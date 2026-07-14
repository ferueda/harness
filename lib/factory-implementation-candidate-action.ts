import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import type { Agent, AgentProviderOptions, AgentSessionRef } from "./agents.ts";
import {
  createFactoryArtifactRef,
  verifyFactoryArtifactRef,
  type FactoryArtifactRef,
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
  FactoryImplementationCandidateEvidenceSchema,
  FactoryImplementationSessionSchema,
} from "./factory-implementation-review-evidence.ts";
import {
  FactoryImplementationRevisionError,
  loadFactoryImplementationRevision,
  matchesFactoryImplementationRevisionWorkspace,
} from "./factory-implementation-revision.ts";
import {
  FactoryImplementationGitAuthoritySchema,
  readFactoryImplementationGitAuthority,
  sameFactoryImplementationGitAuthority,
} from "./factory-implementation-git-refs.ts";
import type { FactoryImplementationRunContext } from "./factory-implementation-run-context.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryActionEvent, FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import {
  createFactoryReviewHead,
  FactoryReviewHeadError,
  readFactoryWorkspaceTree,
} from "./factory-review-head.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
  type FactoryReaction,
} from "./factory-state-machine.ts";
import { renderFactoryImplementationPrompt } from "./prompts/factory-implementation.ts";

const FactsSchema = FactoryImplementationGitAuthoritySchema.extend({
  status: z.string(),
  refs: z.string(),
  indexClean: z.boolean(),
});
const StagedSchema = z.object({
  version: z.literal(1),
  action: z.object({
    phaseRunId: z.string(),
    handler: z.literal("produceImplementationCandidate"),
    attempt: z.number().int().positive(),
    causationEventId: z.string(),
  }),
  timestamp: z.iso.datetime(),
  before: FactsSchema,
  after: FactsSchema,
  afterTree: z.string().regex(/^[0-9a-f]{40}$/),
  result: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      session: FactoryImplementationSessionSchema,
      raw: z.unknown(),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
      aborted: z.boolean().optional(),
      malformed: z.boolean().optional(),
      raw: z.unknown().optional(),
    }),
  ]),
});
type Staged = z.infer<typeof StagedSchema>;
export async function produceImplementationCandidate(input: {
  ctx: FactoryImplementationRunContext;
  factoryStateRoot: string;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  maxRuntimeMs: number;
  signal?: AbortSignal;
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
  reviewHeadFactory?: typeof createFactoryReviewHead;
}): Promise<{ event: FactoryLifecycleEvent; state: FactoryLifecycleState }> {
  assertReaction(input);
  return withFactoryImplementationExecutionLease({
    factoryStateRoot: input.factoryStateRoot,
    workspace: input.ctx.workspace,
    workItem: input.ctx.workItem,
    runDir: input.ctx.runDir,
    action: async () => runLeased(input),
  });
}

async function runLeased(input: {
  ctx: FactoryImplementationRunContext;
  factoryStateRoot: string;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  maxRuntimeMs: number;
  signal?: AbortSignal;
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
  reviewHeadFactory?: typeof createFactoryReviewHead;
}) {
  const { ctx, reaction } = input;
  const actionDir = join(
    ctx.runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    factoryActionKey({ ...reaction, phaseRunId: ctx.runId }),
  );
  mkdirSync(actionDir, { recursive: true });
  let revision: ReturnType<typeof loadFactoryImplementationRevision> | undefined;
  if (reaction.attempt > 1) {
    try {
      revision = loadFactoryImplementationRevision(input);
    } catch (error) {
      return fail(
        input,
        actionDir,
        message(error),
        error instanceof FactoryImplementationRevisionError ? error.failureKind : "terminal",
      );
    }
  }
  if (existsSync(factoryActionResultPath(actionDir))) return appendRecovered(input, actionDir);
  const stagedPath = join(actionDir, "provider-result.json");
  let staged: Staged;
  if (existsSync(stagedPath)) {
    const parsed = readStaged(stagedPath);
    if (!parsed)
      return fail(
        input,
        actionDir,
        "Invalid staged implementation provider result",
        "human-required",
        revision?.candidateEventId,
      );
    staged = parsed;
    assertStagedIdentity(ctx, reaction, staged);
  } else {
    let before: z.infer<typeof FactsSchema>;
    try {
      before = facts(ctx.workspace, ctx);
      if (
        revision &&
        !matchesFactoryImplementationRevisionWorkspace({ ctx, facts: before, revision })
      )
        return fail(
          input,
          actionDir,
          "Implementation workspace no longer matches the prior immutable candidate",
          "human-required",
          revision.candidateEventId,
        );
      if (
        !revision &&
        (before.head !== ctx.identity.baseSha ||
          before.branchRef !== ctx.identity.branchRef ||
          before.status.trim() ||
          !before.indexClean)
      ) {
        const kind = before.status.trim() ? "human-required" : "terminal";
        return fail(
          input,
          actionDir,
          "Implementation workspace no longer matches its clean base",
          kind,
        );
      }
    } catch (error) {
      return fail(
        input,
        actionDir,
        `Failed to inspect implementation workspace: ${message(error)}`,
        "human-required",
        revision?.candidateEventId,
      );
    }
    const planPath =
      ctx.identity.input.mode === "planned"
        ? verifyFactoryArtifactRef(ctx.identity.input.planCandidate, roots(ctx))
        : undefined;
    const prompt = renderFactoryImplementationPrompt({
      workItem: ctx.workItem,
      planPath,
      ...(revision
        ? {
            revision: {
              blockingFindings: revision.blockingFindings,
              operatorResponse: revision.operatorResponse,
              priorCommit: revision.priorCommit,
            },
          }
        : {}),
    });
    writeFileSync(join(actionDir, "implementer.prompt.md"), prompt);
    const profile = ctx.identity.actions.produceImplementationCandidate;
    const provider = input.agentProviderFactory({
      provider: profile.provider,
      ...(profile.provider === "codex" && profile.executable
        ? { codexPathOverride: profile.executable }
        : {}),
    });
    const finish = startFactoryActionTelemetry({
      eventSink: ctx.eventSink,
      runId: ctx.runId,
      runDir: actionDir,
      workspace: ctx.workspace,
      stepId: reaction.handler,
    });
    const streamPath = join(actionDir, "implementer.stream.jsonl");
    let result: Staged["result"];
    try {
      const completed = await provider.run({
        workspace: ctx.workspace,
        prompt,
        model: profile.model,
        ...(profile.provider === "codex"
          ? {
              sandboxMode: profile.sandbox,
              approvalPolicy: profile.approvalPolicy,
              modelReasoningEffort: profile.reasoningEffort,
            }
          : {}),
        ...(revision ? { session: revision.session } : {}),
        workspaceGuard: "record",
        maxRuntimeMs: input.maxRuntimeMs,
        logPath: streamPath,
        signal: input.signal,
      });
      writeFileSync(
        join(actionDir, "implementer.raw.json"),
        `${JSON.stringify(completed.raw ?? completed, null, 2)}\n`,
      );
      if (completed.ok) {
        if (completed.session === undefined) {
          result = revision?.session
            ? { ok: true, session: revision.session, raw: completed.raw }
            : {
                ok: false,
                error: "Implementer session was not captured",
                malformed: true,
                raw: completed.raw,
              };
        } else {
          const session = FactoryImplementationSessionSchema.safeParse(completed.session);
          result =
            session.success && session.data.provider === profile.provider
              ? { ok: true, session: session.data, raw: completed.raw }
              : {
                  ok: false,
                  error: "Implementer session was invalid or used the wrong provider",
                  malformed: true,
                  raw: completed.raw,
                };
        }
      } else {
        result = {
          ok: false,
          error: completed.error,
          ...(completed.aborted ? { aborted: true } : {}),
          ...(completed.raw === undefined ? {} : { raw: completed.raw }),
        };
      }
    } catch (error) {
      result = {
        ok: false,
        error: message(error),
        ...(input.signal?.aborted ? { aborted: true } : {}),
      };
      writeFileSync(join(actionDir, "implementer.raw.json"), "{}\n");
    }
    if (!existsSync(streamPath)) writeFileSync(streamPath, "");
    let after: z.infer<typeof FactsSchema>;
    let afterTree: string;
    try {
      after = facts(ctx.workspace, ctx);
      afterTree = readFactoryWorkspaceTree({
        workspace: ctx.workspace,
        runDir: actionDir,
        baseSha: ctx.identity.baseSha,
      }).tree;
    } catch (error) {
      finish("failed", message(error));
      return fail(
        input,
        actionDir,
        `Failed to inspect workspace after implementer completion: ${message(error)}`,
        "human-required",
        revision?.candidateEventId,
      );
    }
    staged = {
      version: 1,
      action: {
        phaseRunId: ctx.runId,
        handler: "produceImplementationCandidate",
        attempt: reaction.attempt,
        causationEventId: reaction.causationEventId,
      },
      timestamp: new Date().toISOString(),
      before,
      after,
      afterTree,
      result,
    };
    finish(result.ok ? "completed" : "failed", result.ok ? undefined : result.error);
    writeDurableFactoryFile(stagedPath, `${JSON.stringify(staged, null, 2)}\n`, true);
  }

  if (!staged.result.ok) {
    const unchanged = sameFacts(staged.before, staged.after);
    return fail(
      input,
      actionDir,
      staged.result.error,
      staged.result.aborted || staged.result.malformed || !unchanged
        ? "human-required"
        : "retryable",
      revision?.candidateEventId,
    );
  }
  try {
    if (!matchesStagedSuccessWorkspace(ctx, reaction.attempt, staged))
      return fail(
        input,
        actionDir,
        "Implementation workspace changed after the staged provider result",
        "human-required",
        revision?.candidateEventId,
      );
  } catch (error) {
    return fail(
      input,
      actionDir,
      `Failed to inspect staged implementation workspace: ${message(error)}`,
      "human-required",
      revision?.candidateEventId,
    );
  }
  if (!validStagedSuccessAuthority(ctx, staged))
    return fail(
      input,
      actionDir,
      "Implementer mutated Git branch, refs, HEAD, or index",
      "human-required",
      revision?.candidateEventId,
    );
  try {
    const head = (input.reviewHeadFactory ?? createFactoryReviewHead)({
      workspace: ctx.workspace,
      runDir: actionDir,
      runId: ctx.runId,
      attempt: reaction.attempt,
      reviewBase: ctx.identity.baseSha,
      timestamp: staged.timestamp,
    });
    if (revision && head.treeSha === revision.priorTree)
      return fail(
        input,
        actionDir,
        "Implementation revision produced no new tree",
        "human-required",
        revision.candidateEventId,
      );
    writeDurableFactoryFile(join(actionDir, "candidate.diff.patch"), head.diffPatch, true);
    const diff = ref(ctx, join(actionDir, "candidate.diff.patch"));
    const raw = ref(ctx, join(actionDir, "implementer.raw.json"));
    const stream = ref(ctx, join(actionDir, "implementer.stream.jsonl"));
    const evidencePath = join(actionDir, "candidate-evidence.json");
    writeDurableFactoryFile(
      evidencePath,
      `${JSON.stringify(
        {
          version: 1,
          phaseRunId: ctx.runId,
          attempt: reaction.attempt,
          base: head.reviewBase,
          ref: head.reviewHead,
          commit: head.reviewCommitSha,
          tree: head.treeSha,
          status: staged.after.status,
          effectiveSession: staged.result.session,
          artifacts: { raw, stream, diff },
        },
        null,
        2,
      )}\n`,
      true,
    );
    const candidate = ref(ctx, evidencePath);
    const event = successEvent(
      ctx,
      reaction,
      actionDir,
      candidate,
      head,
      staged.result.session,
      stream,
    );
    writeFactoryActionResult(actionDir, event);
    return appendRecovered(input, actionDir);
  } catch (error) {
    return fail(
      input,
      actionDir,
      message(error),
      error instanceof FactoryReviewHeadError && error.kind === "invariant"
        ? "terminal"
        : "human-required",
      revision?.candidateEventId,
    );
  }
}

function readStaged(path: string): Staged | undefined {
  try {
    const parsed = StagedSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function successEvent(
  ctx: FactoryImplementationRunContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  actionDir: string,
  candidate: FactoryArtifactRef,
  head: { reviewCommitSha: string; treeSha: string },
  session: AgentSessionRef,
  stream: FactoryArtifactRef,
): FactoryActionEvent {
  const runRef = ref(ctx, join(actionDir, "implementer.raw.json"));
  return {
    version: 1,
    id: `implementation.candidate.produced:${factoryActionKey({ ...reaction, phaseRunId: ctx.runId })}`,
    type: "implementation.candidate.produced",
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    occurredAt: new Date().toISOString(),
    phaseRunId: ctx.runId,
    data: {
      handler: "produceImplementationCandidate",
      handlerVersion: 1,
      attempt: reaction.attempt,
      causationEventId: reaction.causationEventId,
      execution: { workspaceRef: ctx.factoryStore.repo.id, runRef },
      evidence: [candidate, runRef, stream],
      commit: head.reviewCommitSha,
      tree: head.treeSha,
      candidate,
      effectiveSession: normalizeSession(session),
    },
  };
}

function fail(
  input: Parameters<typeof runLeased>[0],
  actionDir: string,
  error: string,
  failureKind: "retryable" | "human-required" | "terminal",
  retainedCandidateEventId?: string,
) {
  const failurePath = join(actionDir, "failure.json");
  writeDurableFactoryFile(
    failurePath,
    `${JSON.stringify({ error, failureKind }, null, 2)}\n`,
    true,
  );
  const failure = ref(input.ctx, failurePath);
  const event: FactoryActionEvent = {
    version: 1,
    id: `factory.action.failed:${factoryActionKey({ ...input.reaction, phaseRunId: input.ctx.runId })}`,
    type: "factory.action.failed",
    workItemKey: deriveFactoryWorkItemKey(input.ctx.workItem),
    occurredAt: new Date().toISOString(),
    phaseRunId: input.ctx.runId,
    data: {
      handler: "produceImplementationCandidate",
      handlerVersion: 1,
      attempt: input.reaction.attempt,
      causationEventId: input.reaction.causationEventId,
      execution: { workspaceRef: input.ctx.factoryStore.repo.id, runRef: failure },
      evidence: [failure],
      phase: "implementation",
      failureKind,
      message: error,
      ...(retainedCandidateEventId ? { retainedCandidateEventId } : {}),
    },
  };
  writeFactoryActionResult(actionDir, event);
  return appendRecovered(input, actionDir);
}

function appendRecovered(input: Parameters<typeof runLeased>[0], actionDir: string) {
  const event = readFactoryActionResult(actionDir);
  if (
    event.phaseRunId !== input.ctx.runId ||
    event.workItemKey !== deriveFactoryWorkItemKey(input.ctx.workItem) ||
    event.data.handler !== "produceImplementationCandidate" ||
    event.data.attempt !== input.reaction.attempt ||
    event.data.causationEventId !== input.reaction.causationEventId ||
    event.data.execution.workspaceRef !== input.ctx.factoryStore.repo.id
  )
    throw new Error("Recovered implementation candidate result conflicts with phase identity");
  for (const evidence of event.data.evidence) verifyFactoryArtifactRef(evidence, roots(input.ctx));
  if (event.type === "implementation.candidate.produced") {
    const staged = readStaged(join(actionDir, "provider-result.json"));
    if (!staged || !staged.result.ok)
      throw new Error("Recovered candidate has no successful staged provider result");
    assertStagedIdentity(input.ctx, input.reaction, staged);
    if (
      !validStagedSuccessAuthority(input.ctx, staged) ||
      !matchesStagedSuccessWorkspace(input.ctx, input.reaction.attempt, staged)
    )
      throw new Error("Factory Git authority or workspace changed before candidate recovery");
    validateRecoveredCandidate(input.ctx, event);
  }
  return appendFactoryActionEvent({
    factoryStateRoot: input.factoryStateRoot,
    event,
    expectedLastEventId: input.reaction.causationEventId,
  });
}

function validateRecoveredCandidate(
  ctx: FactoryImplementationRunContext,
  event: Extract<FactoryLifecycleEvent, { type: "implementation.candidate.produced" }>,
): void {
  const manifestPath = verifyFactoryArtifactRef(event.data.candidate, roots(ctx));
  const manifest = FactoryImplementationCandidateEvidenceSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  const expectedRef = `refs/harness/factory/${ctx.runId}/${event.data.attempt}`;
  if (
    manifest.phaseRunId !== ctx.runId ||
    manifest.attempt !== event.data.attempt ||
    manifest.base !== ctx.identity.baseSha ||
    manifest.ref !== expectedRef ||
    manifest.commit !== event.data.commit ||
    manifest.tree !== event.data.tree ||
    manifest.effectiveSession.provider !== event.data.effectiveSession.provider ||
    manifest.effectiveSession.id !== event.data.effectiveSession.id
  )
    throw new Error("Recovered candidate evidence conflicts with lifecycle identity");
  for (const artifact of Object.values(manifest.artifacts))
    verifyFactoryArtifactRef(artifact, roots(ctx));
  if (git(ctx.workspace, ["rev-parse", expectedRef]).trim() !== event.data.commit)
    throw new Error("Recovered candidate ref conflicts with lifecycle evidence");
  if (git(ctx.workspace, ["rev-parse", `${event.data.commit}^`]).trim() !== ctx.identity.baseSha)
    throw new Error("Recovered candidate parent conflicts with implementation base");
  if (git(ctx.workspace, ["rev-parse", `${event.data.commit}^{tree}`]).trim() !== event.data.tree)
    throw new Error("Recovered candidate tree conflicts with lifecycle evidence");
}

function assertReaction(input: Parameters<typeof produceImplementationCandidate>[0]): void {
  const events = readFactoryActionEvents(
    input.factoryStateRoot,
    deriveFactoryWorkItemKey(input.ctx.workItem),
  );
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  if (
    !state ||
    !latest ||
    input.reaction.handler !== "produceImplementationCandidate" ||
    JSON.stringify(decideNextFactoryAction(state, latest)) !== JSON.stringify(input.reaction)
  )
    throw new Error("produceImplementationCandidate reaction conflicts with durable Factory state");
}

function assertStagedIdentity(
  ctx: FactoryImplementationRunContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  staged: Staged,
): void {
  if (
    staged.action.phaseRunId !== ctx.runId ||
    staged.action.handler !== reaction.handler ||
    staged.action.attempt !== reaction.attempt ||
    staged.action.causationEventId !== reaction.causationEventId
  )
    throw new Error("Staged implementation provider result conflicts with action identity");
}

function facts(workspace: string, ctx: FactoryImplementationRunContext) {
  return {
    ...readFactoryImplementationGitAuthority({
      workspace,
      branchRef: ctx.identity.branchRef,
      phaseRunId: ctx.runId,
    }),
    status: git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]),
    refs: git(workspace, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    indexClean: gitStatus(workspace, ["diff", "--cached", "--quiet"]),
  };
}

function sameFacts(left: z.infer<typeof FactsSchema>, right: z.infer<typeof FactsSchema>) {
  return (
    left.head === right.head &&
    left.branchRef === right.branchRef &&
    left.status === right.status &&
    left.indexClean === right.indexClean &&
    sameFactoryImplementationGitAuthority(left, right)
  );
}

function validStagedSuccessAuthority(
  ctx: FactoryImplementationRunContext,
  staged: Staged,
): boolean {
  return (
    staged.result.ok &&
    staged.after.head === ctx.identity.baseSha &&
    staged.after.branchRef === ctx.identity.branchRef &&
    staged.after.branchTip === ctx.identity.baseSha &&
    staged.after.indexClean &&
    sameFactoryImplementationGitAuthority(staged.before, staged.after)
  );
}

function matchesStagedSuccessWorkspace(
  ctx: FactoryImplementationRunContext,
  attempt: number,
  staged: Staged,
): boolean {
  const live = facts(ctx.workspace, ctx);
  if (
    live.head !== staged.after.head ||
    live.branchRef !== staged.after.branchRef ||
    live.status !== staged.after.status ||
    live.indexClean !== staged.after.indexClean ||
    live.branchTip !== staged.after.branchTip ||
    !phaseRefsMatchBeforeCandidatePublication(staged.after.phaseRefs, live.phaseRefs, {
      phaseRunId: ctx.runId,
      attempt,
    })
  )
    return false;
  return (
    readFactoryWorkspaceTree({
      workspace: ctx.workspace,
      runDir: ctx.runDir,
      baseSha: ctx.identity.baseSha,
    }).tree === staged.afterTree
  );
}

function phaseRefsMatchBeforeCandidatePublication(
  expected: string,
  live: string,
  candidate: { phaseRunId: string; attempt: number },
): boolean {
  if (live === expected) return true;
  // Create-only publication may finish before a crash; its exact ref is validated downstream.
  const candidateRef = `refs/harness/factory/${candidate.phaseRunId}/${candidate.attempt} `;
  const withoutCandidate = live
    .split("\n")
    .filter((line) => !line.startsWith(candidateRef))
    .join("\n");
  return withoutCandidate === expected;
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitStatus(workspace: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
    return true;
  } catch (error) {
    if (isExitCode(error, 1)) return false;
    throw error;
  }
}

function isExitCode(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}

function ref(ctx: FactoryImplementationRunContext, path: string): FactoryArtifactRef {
  return createFactoryArtifactRef({
    base: "factory-store",
    root: ctx.factoryStore.projectRoot,
    path: relative(ctx.factoryStore.projectRoot, path),
  });
}

function roots(ctx: FactoryImplementationRunContext) {
  return { "factory-store": ctx.factoryStore.projectRoot, repository: ctx.workspace } as const;
}

function normalizeSession(session: AgentSessionRef): AgentSessionRef {
  return FactoryImplementationSessionSchema.parse(session);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
