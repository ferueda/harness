import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Agent, AgentProviderOptions } from "./agents.ts";
import {
  createFactoryArtifactRef,
  FactoryArtifactRefSchema,
  verifyFactoryArtifactRef,
} from "./factory-artifact-ref.ts";
import { factoryActionKey } from "./factory-action-contract.ts";
import {
  factoryActionResultPath,
  readFactoryActionResult,
  writeFactoryActionResult,
} from "./factory-action-result.ts";
import { startFactoryActionTelemetry } from "./factory-action-telemetry.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";
import { withFactoryImplementationExecutionLease } from "./factory-implementation-policy.ts";
import {
  validateImplementationReviewEvidence,
  type ImplementationReviewEvidence,
} from "./factory-implementation-review-evidence.ts";
import type { FactoryImplementationRunContext } from "./factory-implementation-run-context.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryActionEvent, FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { promoteFactoryCandidate, readFactoryWorkspaceTree } from "./factory-review-head.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
  type FactoryReaction,
} from "./factory-state-machine.ts";
import { createWorkflowContext } from "./workflow-context.ts";
import { renderFactoryImplementationReviewHandoff } from "./prompts/factory-implementation.ts";
import { run as runChangeReview } from "../workflows/change-review.workflow.ts";

type ReviewRunner = typeof runChangeReview;
class BranchDriftError extends Error {}
const StagedReviewSchema = z.object({
  version: z.literal(1),
  action: z.object({
    phaseRunId: z.string(),
    handler: z.literal("reviewImplementationCandidate"),
    attempt: z.number().int().positive(),
    causationEventId: z.string(),
  }),
  reviewRunDir: z.string(),
  meta: z.unknown(),
});
const CandidateEvidenceSchema = z.object({
  version: z.literal(1),
  phaseRunId: z.string(),
  attempt: z.number().int().positive(),
  base: z.string(),
  ref: z.string(),
  commit: z.string(),
  tree: z.string(),
  status: z.string(),
  effectiveSession: z.object({ provider: z.string(), id: z.string() }),
  artifacts: z.object({
    raw: FactoryArtifactRefSchema,
    diff: FactoryArtifactRefSchema,
    handoff: FactoryArtifactRefSchema,
  }),
});

export async function reviewImplementationCandidate(input: {
  ctx: FactoryImplementationRunContext;
  factoryStateRoot: string;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  maxRuntimeMs: number;
  signal?: AbortSignal;
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
  reviewRunner?: ReviewRunner;
}): Promise<{ event: FactoryLifecycleEvent; state: FactoryLifecycleState }> {
  const candidate = assertReaction(input);
  return withFactoryImplementationExecutionLease({
    factoryStateRoot: input.factoryStateRoot,
    workspace: input.ctx.workspace,
    workItem: input.ctx.workItem,
    runDir: input.ctx.runDir,
    action: async () => runLeased(input, candidate),
  });
}

async function runLeased(
  input: Parameters<typeof reviewImplementationCandidate>[0],
  candidate: Extract<FactoryLifecycleEvent, { type: "implementation.candidate.produced" }>,
) {
  const { ctx, reaction } = input;
  const actionDir = join(
    ctx.runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    factoryActionKey({ ...reaction, phaseRunId: ctx.runId }),
  );
  mkdirSync(actionDir, { recursive: true });
  if (existsSync(factoryActionResultPath(actionDir))) return appendRecovered(input, actionDir);
  try {
    validateCandidate(ctx, candidate);
  } catch (error) {
    return fail(
      input,
      actionDir,
      message(error),
      error instanceof BranchDriftError ? "human-required" : "terminal",
    );
  }
  const stagedPath = join(actionDir, "review-result.json");
  let staged: z.infer<typeof StagedReviewSchema>;
  if (existsSync(stagedPath)) {
    const parsed = StagedReviewSchema.safeParse(JSON.parse(readFileSync(stagedPath, "utf8")));
    if (!parsed.success)
      return fail(input, actionDir, "Invalid staged change-review result", "terminal");
    staged = parsed.data;
    if (
      staged.action.phaseRunId !== ctx.runId ||
      staged.action.handler !== reaction.handler ||
      staged.action.attempt !== reaction.attempt ||
      staged.action.causationEventId !== reaction.causationEventId
    )
      throw new Error("Staged change-review result conflicts with action identity");
    assertReviewRunContained(actionDir, staged.reviewRunDir);
  } else {
    const profile = ctx.identity.actions.reviewImplementationCandidate;
    const planPath =
      ctx.identity.input.mode === "planned"
        ? verifyFactoryArtifactRef(ctx.identity.input.planCandidate, roots(ctx))
        : undefined;
    const reviewCtx = createWorkflowContext({
      workspace: ctx.workspace,
      baseRef: ctx.identity.baseSha,
      headRef: candidate.data.commit,
      runsDir: join(actionDir, "review-runs"),
      handoffText: renderFactoryImplementationReviewHandoff({
        workItem: ctx.workItem,
        phaseRunId: ctx.runId,
        candidateCommit: candidate.data.commit,
      }),
      ...(planPath ? { planPath } : {}),
      agentProvider: profile.provider,
      ...(profile.provider === "codex" && profile.executable
        ? { codexPathOverride: profile.executable }
        : {}),
      model: profile.model,
      ...(profile.provider === "codex"
        ? {
            sandboxMode: "read-only",
            approvalPolicy: "never",
            modelReasoningEffort: profile.reasoningEffort,
          }
        : {}),
      maxRuntimeMs: input.maxRuntimeMs,
      signal: input.signal,
      agentProviderFactory: input.agentProviderFactory,
    });
    const finish = startFactoryActionTelemetry({
      eventSink: ctx.eventSink,
      runId: ctx.runId,
      runDir: actionDir,
      workspace: ctx.workspace,
      stepId: reaction.handler,
    });
    let meta: unknown;
    try {
      meta = await (input.reviewRunner ?? runChangeReview)(reviewCtx);
    } catch (error) {
      finish("failed", message(error));
      return fail(input, actionDir, message(error), "human-required");
    }
    finish("completed");
    staged = {
      version: 1,
      action: {
        phaseRunId: ctx.runId,
        handler: "reviewImplementationCandidate",
        attempt: reaction.attempt,
        causationEventId: reaction.causationEventId,
      },
      reviewRunDir: reviewCtx.runDir,
      meta,
    };
    writeDurableFactoryFile(stagedPath, `${JSON.stringify(staged, null, 2)}\n`, true);
  }
  let evidence: ImplementationReviewEvidence;
  try {
    const postTree = readFactoryWorkspaceTree({
      workspace: ctx.workspace,
      runDir: actionDir,
      baseSha: ctx.identity.baseSha,
    });
    if (postTree.tree !== candidate.data.tree)
      return fail(
        input,
        actionDir,
        "Review workspace changed from the immutable candidate tree",
        "human-required",
      );
    if (isFailedReviewMeta(staged.meta))
      return fail(
        input,
        actionDir,
        "One or more implementation reviewers failed",
        input.signal?.aborted ? "human-required" : "retryable",
      );
    evidence = validateImplementationReviewEvidence({
      meta: staged.meta,
      implementationPath: join(staged.reviewRunDir, "implementation-review.json"),
      qualityPath: join(staged.reviewRunDir, "quality-review.json"),
    });
  } catch (error) {
    return fail(input, actionDir, message(error), "terminal");
  }
  const implementationRef = ref(ctx, join(staged.reviewRunDir, "implementation-review.json"));
  const qualityRef = ref(ctx, join(staged.reviewRunDir, "quality-review.json"));
  let blockingRef;
  if (evidence.verdict === "needs_changes") {
    const path = join(actionDir, "blocking-findings.json");
    writeDurableFactoryFile(path, `${JSON.stringify(evidence.blocking, null, 2)}\n`, true);
    blockingRef = ref(ctx, path);
  }
  const manifestPath = join(actionDir, "review-evidence.json");
  writeDurableFactoryFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        phaseRunId: ctx.runId,
        attempt: reaction.attempt,
        base: ctx.identity.baseSha,
        commit: candidate.data.commit,
        tree: candidate.data.tree,
        partial: false,
        verdict: evidence.verdict,
        reviewers: { implementation: implementationRef, quality: qualityRef },
        ...(blockingRef ? { blockingFindings: blockingRef } : {}),
      },
      null,
      2,
    )}\n`,
    true,
  );
  if (evidence.verdict === "pass") {
    try {
      promoteFactoryCandidate({
        workspace: ctx.workspace,
        branchRef: ctx.identity.branchRef,
        baseSha: ctx.identity.baseSha,
        candidateSha: candidate.data.commit,
      });
    } catch (error) {
      return fail(input, actionDir, message(error), "human-required");
    }
  }
  const manifest = ref(ctx, manifestPath);
  const event: FactoryActionEvent = {
    version: 1,
    id: `implementation.review.completed:${factoryActionKey({ ...reaction, phaseRunId: ctx.runId })}`,
    type: "implementation.review.completed",
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    occurredAt: new Date().toISOString(),
    phaseRunId: ctx.runId,
    data: {
      handler: "reviewImplementationCandidate",
      handlerVersion: 1,
      attempt: reaction.attempt,
      causationEventId: reaction.causationEventId,
      execution: { workspaceRef: ctx.factoryStore.repo.id, runRef: manifest },
      evidence: [manifest, implementationRef, qualityRef],
      verdict: evidence.verdict,
      review: manifest,
      ...(blockingRef ? { blockingFindings: blockingRef } : {}),
      reviewCeiling: 1,
    },
  };
  writeFactoryActionResult(actionDir, event);
  return appendRecovered(input, actionDir);
}

function validateCandidate(
  ctx: FactoryImplementationRunContext,
  candidate: Extract<FactoryLifecycleEvent, { type: "implementation.candidate.produced" }>,
): void {
  const branchRef = git(ctx.workspace, ["symbolic-ref", "-q", "HEAD"]).trim();
  if (branchRef !== ctx.identity.branchRef)
    throw new BranchDriftError("Implementation symbolic branch changed before review");
  const branchSha = git(ctx.workspace, ["rev-parse", ctx.identity.branchRef]).trim();
  if (branchSha !== ctx.identity.baseSha && branchSha !== candidate.data.commit)
    throw new BranchDriftError("Implementation branch base changed before review");
  const manifestPath = verifyFactoryArtifactRef(candidate.data.candidate, roots(ctx));
  const manifest = CandidateEvidenceSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (
    manifest.phaseRunId !== ctx.runId ||
    manifest.attempt !== candidate.data.attempt ||
    manifest.base !== ctx.identity.baseSha ||
    manifest.ref !== `refs/harness/factory/${ctx.runId}/${candidate.data.attempt}` ||
    manifest.commit !== candidate.data.commit ||
    manifest.tree !== candidate.data.tree ||
    manifest.effectiveSession.provider !== candidate.data.effectiveSession.provider ||
    manifest.effectiveSession.id !== candidate.data.effectiveSession.id
  )
    throw new Error("Candidate evidence conflicts with lifecycle identity");
  verifyFactoryArtifactRef(manifest.artifacts.raw, roots(ctx));
  verifyFactoryArtifactRef(manifest.artifacts.diff, roots(ctx));
  verifyFactoryArtifactRef(manifest.artifacts.handoff, roots(ctx));
  if (
    git(ctx.workspace, [
      "rev-parse",
      candidate.data.candidate ? candidate.data.commit : "",
    ]).trim() !== candidate.data.commit
  )
    throw new Error("Candidate commit is missing");
  if (
    git(ctx.workspace, ["rev-parse", `${candidate.data.commit}^`]).trim() !== ctx.identity.baseSha
  )
    throw new Error("Candidate parent does not match the implementation base");
  if (
    git(ctx.workspace, ["rev-parse", `${candidate.data.commit}^{tree}`]).trim() !==
    candidate.data.tree
  )
    throw new Error("Candidate tree does not match lifecycle evidence");
  const expectedRef = `refs/harness/factory/${ctx.runId}/${candidate.data.attempt}`;
  if (git(ctx.workspace, ["rev-parse", expectedRef]).trim() !== candidate.data.commit)
    throw new Error("Candidate ref does not match lifecycle evidence");
  const live = readFactoryWorkspaceTree({
    workspace: ctx.workspace,
    runDir: ctx.runDir,
    baseSha: ctx.identity.baseSha,
  });
  if (live.tree !== candidate.data.tree)
    throw new Error("Live workspace tree does not match the candidate");
}

function fail(
  input: Parameters<typeof reviewImplementationCandidate>[0],
  actionDir: string,
  error: string,
  failureKind: "retryable" | "human-required" | "terminal",
) {
  const path = join(actionDir, "failure.json");
  writeDurableFactoryFile(path, `${JSON.stringify({ error, failureKind }, null, 2)}\n`, true);
  const failure = ref(input.ctx, path);
  const event: FactoryActionEvent = {
    version: 1,
    id: `factory.action.failed:${factoryActionKey({ ...input.reaction, phaseRunId: input.ctx.runId })}`,
    type: "factory.action.failed",
    workItemKey: deriveFactoryWorkItemKey(input.ctx.workItem),
    occurredAt: new Date().toISOString(),
    phaseRunId: input.ctx.runId,
    data: {
      handler: "reviewImplementationCandidate",
      handlerVersion: 1,
      attempt: input.reaction.attempt,
      causationEventId: input.reaction.causationEventId,
      execution: { workspaceRef: input.ctx.factoryStore.repo.id, runRef: failure },
      evidence: [failure],
      phase: "implementation",
      failureKind,
      message: error,
    },
  };
  writeFactoryActionResult(actionDir, event);
  return appendRecovered(input, actionDir);
}

function appendRecovered(
  input: Parameters<typeof reviewImplementationCandidate>[0],
  actionDir: string,
) {
  const event = readFactoryActionResult(actionDir);
  if (
    event.phaseRunId !== input.ctx.runId ||
    event.workItemKey !== deriveFactoryWorkItemKey(input.ctx.workItem) ||
    event.data.handler !== "reviewImplementationCandidate" ||
    event.data.attempt !== input.reaction.attempt ||
    event.data.causationEventId !== input.reaction.causationEventId ||
    event.data.execution.workspaceRef !== input.ctx.factoryStore.repo.id
  )
    throw new Error("Recovered implementation review result conflicts with phase identity");
  for (const evidence of event.data.evidence) verifyFactoryArtifactRef(evidence, roots(input.ctx));
  if (event.type === "implementation.review.completed" && event.data.verdict === "pass") {
    const candidate = readFactoryActionEvents(
      input.factoryStateRoot,
      deriveFactoryWorkItemKey(input.ctx.workItem),
    ).findLast(
      (candidateEvent) =>
        candidateEvent.type === "implementation.candidate.produced" &&
        candidateEvent.phaseRunId === input.ctx.runId,
    );
    if (!candidate || candidate.type !== "implementation.candidate.produced")
      throw new Error("Recovered implementation pass has no candidate");
    promoteFactoryCandidate({
      workspace: input.ctx.workspace,
      branchRef: input.ctx.identity.branchRef,
      baseSha: input.ctx.identity.baseSha,
      candidateSha: candidate.data.commit,
    });
  }
  return appendFactoryActionEvent({
    factoryStateRoot: input.factoryStateRoot,
    event,
    expectedLastEventId: input.reaction.causationEventId,
  });
}

function assertReaction(input: Parameters<typeof reviewImplementationCandidate>[0]) {
  const events = readFactoryActionEvents(
    input.factoryStateRoot,
    deriveFactoryWorkItemKey(input.ctx.workItem),
  );
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  if (
    !state ||
    !latest ||
    latest.type !== "implementation.candidate.produced" ||
    input.reaction.handler !== "reviewImplementationCandidate" ||
    JSON.stringify(decideNextFactoryAction(state, latest)) !== JSON.stringify(input.reaction)
  )
    throw new Error("reviewImplementationCandidate reaction conflicts with durable Factory state");
  return latest;
}

function roots(ctx: FactoryImplementationRunContext) {
  return { "factory-store": ctx.factoryStore.projectRoot, repository: ctx.workspace } as const;
}

function ref(ctx: FactoryImplementationRunContext, path: string) {
  return createFactoryArtifactRef({
    base: "factory-store",
    root: ctx.factoryStore.projectRoot,
    path: relative(ctx.factoryStore.projectRoot, path),
  });
}

function git(workspace: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertReviewRunContained(actionDir: string, reviewRunDir: string): void {
  const root = resolve(actionDir, "review-runs");
  const candidate = resolve(reviewRunDir);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`))
    throw new Error("Staged change-review run escapes its action directory");
}

function isFailedReviewMeta(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && "status" in value && value.status === "failed"
  );
}
