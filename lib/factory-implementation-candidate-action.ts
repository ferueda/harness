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
import { FactoryImplementationCandidateEvidenceSchema } from "./factory-implementation-review-evidence.ts";
import type { FactoryImplementationRunContext } from "./factory-implementation-run-context.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryActionEvent, FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { createFactoryReviewHead } from "./factory-review-head.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
  type FactoryReaction,
} from "./factory-state-machine.ts";
import { renderFactoryImplementationPrompt } from "./prompts/factory-implementation.ts";

const SessionSchema = z.object({ provider: z.enum(["cursor", "codex"]), id: z.string().min(1) });
const FactsSchema = z.object({
  head: z.string().regex(/^[0-9a-f]{40}$/),
  branchRef: z.string().min(1),
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
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), session: SessionSchema, raw: z.unknown() }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
      aborted: z.boolean().optional(),
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
      );
    staged = parsed;
    assertStagedIdentity(ctx, reaction, staged);
  } else {
    let before: z.infer<typeof FactsSchema>;
    try {
      before = facts(ctx.workspace);
    } catch (error) {
      return fail(
        input,
        actionDir,
        `Failed to inspect implementation workspace: ${message(error)}`,
        "human-required",
      );
    }
    if (
      before.head !== ctx.identity.baseSha ||
      before.branchRef !== ctx.identity.branchRef ||
      before.status.trim() ||
      !before.indexClean
    ) {
      const kind = before.status.trim() ? "human-required" : "terminal";
      return fail(
        input,
        actionDir,
        "Implementation workspace no longer matches its clean base",
        kind,
      );
    }
    const planPath =
      ctx.identity.input.mode === "planned"
        ? verifyFactoryArtifactRef(ctx.identity.input.planCandidate, roots(ctx))
        : undefined;
    const prompt = renderFactoryImplementationPrompt({ workItem: ctx.workItem, planPath });
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
        workspaceGuard: "record",
        maxRuntimeMs: input.maxRuntimeMs,
        logPath: streamPath,
        signal: input.signal,
      });
      writeFileSync(
        join(actionDir, "implementer.raw.json"),
        `${JSON.stringify(completed.raw ?? completed, null, 2)}\n`,
      );
      result = completed.ok
        ? completed.session
          ? { ok: true, session: normalizeSession(completed.session), raw: completed.raw }
          : { ok: false, error: "Implementer session was not captured", raw: completed.raw }
        : {
            ok: false,
            error: completed.error,
            ...(completed.aborted ? { aborted: true } : {}),
            ...(completed.raw === undefined ? {} : { raw: completed.raw }),
          };
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
    try {
      after = facts(ctx.workspace);
    } catch (error) {
      finish("failed", message(error));
      return fail(
        input,
        actionDir,
        `Failed to inspect workspace after implementer completion: ${message(error)}`,
        "human-required",
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
      staged.result.aborted || !unchanged ? "human-required" : "retryable",
    );
  }
  if (
    staged.after.head !== ctx.identity.baseSha ||
    staged.after.branchRef !== ctx.identity.branchRef ||
    !staged.after.indexClean ||
    staged.after.refs !== staged.before.refs
  )
    return fail(
      input,
      actionDir,
      "Implementer mutated Git branch, refs, HEAD, or index",
      "human-required",
    );
  try {
    const head = createFactoryReviewHead({
      workspace: ctx.workspace,
      runDir: actionDir,
      runId: ctx.runId,
      attempt: reaction.attempt,
      reviewBase: ctx.identity.baseSha,
      timestamp: staged.timestamp,
    });
    writeDurableFactoryFile(join(actionDir, "candidate.diff.patch"), head.diffPatch, true);
    const diff = ref(ctx, join(actionDir, "candidate.diff.patch"));
    const raw = ref(ctx, join(actionDir, "implementer.raw.json"));
    const stream = ref(ctx, join(actionDir, "implementer.stream.jsonl"));
    const handoffPath = join(actionDir, "handoff.json");
    writeDurableFactoryFile(
      handoffPath,
      `${JSON.stringify({ summary: "Immutable implementation candidate ready for full review" }, null, 2)}\n`,
      true,
    );
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
          artifacts: { raw, stream, diff, handoff: ref(ctx, handoffPath) },
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
    return fail(input, actionDir, message(error), "terminal");
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
  if (event.type === "implementation.candidate.produced")
    validateRecoveredCandidate(input.ctx, event);
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

function facts(workspace: string) {
  return {
    head: git(workspace, ["rev-parse", "HEAD"]).trim(),
    branchRef: git(workspace, ["symbolic-ref", "-q", "HEAD"]).trim(),
    status: git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]),
    refs: git(workspace, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    indexClean: gitStatus(workspace, ["diff", "--cached", "--quiet"]),
  };
}

function sameFacts(left: z.infer<typeof FactsSchema>, right: z.infer<typeof FactsSchema>) {
  return JSON.stringify(left) === JSON.stringify(right);
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
  } catch {
    return false;
  }
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
  return { provider: session.provider, id: session.id };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
