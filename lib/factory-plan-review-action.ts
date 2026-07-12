import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Agent, AgentProviderOptions } from "./agents.ts";
import { createFactoryArtifactRef, verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { factoryActionKey } from "./factory-action-contract.ts";
import {
  factoryActionResultPath,
  readFactoryActionResult,
  writeFactoryActionResult,
} from "./factory-action-result.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryActionEvent, FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import type { openFactoryPlanningRunContext } from "./factory-planning-run-context.ts";
import { ReviewOutputSchema } from "./schemas.ts";
import { createWorkflowContext } from "./workflow-context.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
  type FactoryReaction,
} from "./factory-state-machine.ts";
import { run as runPlanReview } from "../workflows/plan-review.workflow.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";
import { startFactoryActionTelemetry } from "./factory-action-telemetry.ts";
import { z } from "zod";

type PlanningContext = ReturnType<typeof openFactoryPlanningRunContext>;

export async function reviewPlanCandidate(input: {
  ctx: PlanningContext;
  factoryStateRoot: string;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  maxRuntimeMs: number;
  signal?: AbortSignal;
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
  reviewRunner?: typeof runPlanReview;
}): Promise<{ event: FactoryLifecycleEvent; state: FactoryLifecycleState }> {
  const { ctx, reaction } = input;
  const events = readFactoryActionEvents(
    input.factoryStateRoot,
    deriveFactoryWorkItemKey(ctx.workItem),
  );
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  if (
    !state ||
    !latest ||
    reaction.handler !== "reviewPlanCandidate" ||
    JSON.stringify(decideNextFactoryAction(state, latest)) !== JSON.stringify(reaction) ||
    latest.type !== "planning.candidate.produced"
  )
    throw new Error("reviewPlanCandidate reaction conflicts with durable Factory state");
  const actionDir = join(
    ctx.runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    factoryActionKey({ ...reaction, phaseRunId: ctx.runId }),
  );
  if (!existsSync(factoryActionResultPath(actionDir))) {
    mkdirSync(actionDir, { recursive: true });
    let candidatePath: string;
    try {
      candidatePath = verifyFactoryArtifactRef(latest.data.candidate, {
        "factory-store": ctx.factoryStore.projectRoot,
        repository: ctx.workspace,
      });
    } catch (error) {
      return failAction(input, actionDir, errorMessage(error), "terminal");
    }
    const reviewPath = join(actionDir, "spec-review.json");
    const resultPath = join(actionDir, "review-result.json");
    let staged: StagedReviewOutcome;
    if (existsSync(resultPath)) {
      try {
        staged = StagedReviewOutcomeSchema.parse(JSON.parse(readFileSync(resultPath, "utf8")));
      } catch (error) {
        return failAction(input, actionDir, errorMessage(error), "terminal");
      }
      assertStagedIdentity(ctx, reaction, staged);
    } else {
      const profile = ctx.identity.actions.reviewPlanCandidate;
      const reviewCtx = createWorkflowContext({
        workspace: ctx.workspace,
        planPath: candidatePath,
        runsDir: join(actionDir, "review-runs"),
        includeGitScope: false,
        agentProvider: profile.provider,
        ...(profile.provider === "codex" && profile.executable
          ? { codexPathOverride: profile.executable }
          : {}),
        model: profile.model,
        ...(profile.provider === "codex"
          ? {
              sandboxMode: profile.sandbox,
              approvalPolicy: profile.approvalPolicy,
              modelReasoningEffort: profile.reasoningEffort,
            }
          : {}),
        maxRuntimeMs: input.maxRuntimeMs,
        signal: input.signal,
        agentProviderFactory: input.agentProviderFactory,
      });
      const finishTelemetry = startFactoryActionTelemetry({
        eventSink: ctx.eventSink,
        runId: ctx.runId,
        runDir: actionDir,
        workspace: ctx.workspace,
        stepId: reaction.handler,
      });
      let meta: unknown;
      try {
        meta = await (input.reviewRunner ?? runPlanReview)(reviewCtx);
      } catch (error) {
        finishTelemetry("failed", errorMessage(error));
        return failAction(input, actionDir, errorMessage(error), "human-required");
      }
      staged = buildStagedReviewOutcome({
        ctx,
        reaction,
        meta,
        reviewRunDir: reviewCtx.runDir,
        callerAborted: input.signal?.aborted === true,
      });
      finishTelemetry(staged.completion.status === "completed" ? "completed" : "failed");
      writeDurableFactoryFile(resultPath, `${JSON.stringify(staged, null, 2)}\n`, true);
    }

    if (staged.completion.review.kind === "present") {
      writeDurableFactoryFile(reviewPath, staged.completion.review.bytes, true);
    }
    if (staged.completion.status === "invalid") {
      return failAction(input, actionDir, staged.completion.message, "terminal");
    }
    if (staged.completion.status === "failed") {
      return failAction(
        input,
        actionDir,
        staged.completion.message,
        classifyReviewFailure(staged.completion),
      );
    }
    if (staged.completion.review.kind !== "present") {
      return failAction(input, actionDir, staged.completion.review.message, "terminal");
    }
    let review: z.infer<typeof ReviewOutputSchema>;
    try {
      review = ReviewOutputSchema.parse(JSON.parse(readFileSync(reviewPath, "utf8")));
    } catch (error) {
      const terminal = buildFailure(ctx, reaction, actionDir, errorMessage(error), "terminal");
      writeFactoryActionResult(actionDir, terminal);
      return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
    }
    let reviewRef: ReturnType<typeof ref>;
    try {
      reviewRef = ref(ctx, reviewPath);
    } catch (error) {
      return failAction(input, actionDir, errorMessage(error), "terminal");
    }
    const verdict = review.verdict;
    let blockingRef;
    if (verdict === "needs_changes") {
      const findings = review.findings
        .filter((finding) => finding.must_fix)
        .map((finding, index) => ({
          id: `spec-${String(index + 1).padStart(3, "0")}`,
          ...finding,
        }));
      if (findings.length === 0) {
        const terminal = buildFailure(
          ctx,
          reaction,
          actionDir,
          "plan-review needs_changes without a must_fix finding",
          "terminal",
        );
        writeFactoryActionResult(actionDir, terminal);
        return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
      }
      const path = join(actionDir, "blocking-findings.json");
      writeFileSync(path, `${JSON.stringify(findings, null, 2)}\n`);
      try {
        blockingRef = ref(ctx, path);
      } catch (error) {
        return failAction(input, actionDir, errorMessage(error), "terminal");
      }
    }
    if (verdict === "pass" && ctx.identity.publicationMode === "local") {
      try {
        materialize(candidatePath, resolve(ctx.workspace, ctx.identity.outputPlan));
      } catch (error) {
        if (error instanceof MaterializationConflictError)
          return failAction(input, actionDir, error.message, "terminal");
        throw error;
      }
    }
    const event: FactoryLifecycleEvent = {
      version: 1,
      id: `planning.review.completed:${factoryActionKey({ ...reaction, phaseRunId: ctx.runId })}`,
      type: "planning.review.completed",
      workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
      occurredAt: new Date().toISOString(),
      phaseRunId: ctx.runId,
      data: {
        handler: "reviewPlanCandidate",
        handlerVersion: 1,
        attempt: reaction.attempt,
        causationEventId: reaction.causationEventId,
        execution: { workspaceRef: ctx.factoryStore.repo.id, runRef: reviewRef },
        evidence: blockingRef ? [reviewRef, blockingRef] : [reviewRef],
        verdict,
        review: reviewRef,
        ...(blockingRef ? { blockingFindings: blockingRef } : {}),
        reviewCeiling: ctx.identity.reviewCeiling,
      },
    };
    writeFactoryActionResult(actionDir, event);
  }
  const recovered = readFactoryActionResult(actionDir);
  assertRecoveredResult(ctx, reaction, recovered);
  if (
    recovered.type === "planning.review.completed" &&
    recovered.data.verdict === "pass" &&
    ctx.identity.publicationMode === "local"
  ) {
    const candidatePath = verifyFactoryArtifactRef(latest.data.candidate, {
      "factory-store": ctx.factoryStore.projectRoot,
      repository: ctx.workspace,
    });
    materialize(candidatePath, resolve(ctx.workspace, ctx.identity.outputPlan));
  }
  return appendFactoryActionEvent({
    factoryStateRoot: input.factoryStateRoot,
    event: recovered,
    expectedLastEventId: reaction.causationEventId,
  });
}

const WorkspaceStatusSchema = z.object({ before: z.string(), after: z.string() }).strict();
const ReviewArtifactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("present"), bytes: z.string() }).strict(),
  z.object({ kind: z.literal("missing"), message: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("unreadable"), message: z.string().min(1) }).strict(),
]);
const ReviewCompletionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      callerAborted: z.boolean(),
      workspaceStatus: WorkspaceStatusSchema.optional(),
      review: ReviewArtifactSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      message: z.string().min(1),
      callerAborted: z.boolean(),
      workspaceStatus: WorkspaceStatusSchema.optional(),
      review: ReviewArtifactSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("invalid"),
      message: z.string().min(1),
      callerAborted: z.boolean(),
      workspaceStatus: WorkspaceStatusSchema.optional(),
      review: ReviewArtifactSchema,
    })
    .strict(),
]);
const StagedReviewOutcomeSchema = z
  .object({
    version: z.literal(1),
    action: z
      .object({
        phaseRunId: z.string(),
        handler: z.literal("reviewPlanCandidate"),
        attempt: z.number().int().positive(),
        causationEventId: z.string(),
      })
      .strict(),
    completion: ReviewCompletionSchema,
  })
  .strict();
type StagedReviewOutcome = z.infer<typeof StagedReviewOutcomeSchema>;
const ReviewRunMetaSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed") }).passthrough(),
  z
    .object({
      status: z.literal("failed"),
      failedReviews: z.array(z.object({ error: z.string() }).passthrough()).optional(),
    })
    .passthrough(),
]);

function buildStagedReviewOutcome(input: {
  ctx: PlanningContext;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  meta: unknown;
  reviewRunDir: string;
  callerAborted: boolean;
}): StagedReviewOutcome {
  const meta = ReviewRunMetaSchema.safeParse(input.meta);
  const review = readReviewArtifact(join(input.reviewRunDir, "spec-review.json"));
  const workspaceStatus = readReviewWorkspaceStatus(
    join(input.reviewRunDir, "spec-review.raw.json"),
  );
  const common = {
    callerAborted: input.callerAborted,
    ...(workspaceStatus ? { workspaceStatus } : {}),
    review,
  };
  const completion: StagedReviewOutcome["completion"] = !meta.success
    ? { status: "invalid", message: "Plan reviewer returned invalid run metadata", ...common }
    : meta.data.status === "failed"
      ? { status: "failed", message: reviewFailureMessage(meta.data), ...common }
      : { status: "completed", ...common };
  return StagedReviewOutcomeSchema.parse({
    version: 1,
    action: {
      phaseRunId: input.ctx.runId,
      handler: "reviewPlanCandidate",
      attempt: input.reaction.attempt,
      causationEventId: input.reaction.causationEventId,
    },
    completion,
  });
}

function readReviewArtifact(path: string): z.infer<typeof ReviewArtifactSchema> {
  if (!existsSync(path))
    return { kind: "missing", message: "Plan reviewer did not produce spec-review.json" };
  try {
    return { kind: "present", bytes: readFileSync(path, "utf8") };
  } catch (error) {
    return { kind: "unreadable", message: errorMessage(error) };
  }
}

function readReviewWorkspaceStatus(
  path: string,
): z.infer<typeof WorkspaceStatusSchema> | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("workspaceStatus" in raw))
      return undefined;
    const parsed = WorkspaceStatusSchema.safeParse(raw.workspaceStatus);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function assertStagedIdentity(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  staged: StagedReviewOutcome,
): void {
  if (
    staged.action.phaseRunId !== ctx.runId ||
    staged.action.handler !== reaction.handler ||
    staged.action.attempt !== reaction.attempt ||
    staged.action.causationEventId !== reaction.causationEventId
  )
    throw new Error("Staged review outcome conflicts with action identity");
}

function classifyReviewFailure(
  completion: Extract<StagedReviewOutcome["completion"], { status: "failed" }>,
): "retryable" | "human-required" {
  if (completion.callerAborted) return "human-required";
  const status = completion.workspaceStatus;
  return status && status.before === status.after ? "retryable" : "human-required";
}

function failAction(
  input: {
    ctx: PlanningContext;
    factoryStateRoot: string;
    reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  },
  actionDir: string,
  message: string,
  failureKind: "retryable" | "human-required" | "terminal",
): { event: FactoryLifecycleEvent; state: FactoryLifecycleState } {
  const terminal = buildFailure(input.ctx, input.reaction, actionDir, message, failureKind);
  writeFactoryActionResult(actionDir, terminal);
  return appendRecovered(input.factoryStateRoot, input.ctx, input.reaction, actionDir);
}

function buildFailure(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  actionDir: string,
  message: string,
  failureKind: "retryable" | "human-required" | "terminal",
): FactoryActionEvent {
  const failurePath = join(actionDir, "failure.json");
  writeDurableFactoryFile(
    failurePath,
    `${JSON.stringify({ message, failureKind }, null, 2)}\n`,
    true,
  );
  const failure = ref(ctx, failurePath);
  return {
    version: 1,
    id: `factory.action.failed:${factoryActionKey({ ...reaction, phaseRunId: ctx.runId })}`,
    type: "factory.action.failed",
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    occurredAt: new Date().toISOString(),
    phaseRunId: ctx.runId,
    data: {
      handler: "reviewPlanCandidate",
      handlerVersion: 1,
      attempt: reaction.attempt,
      causationEventId: reaction.causationEventId,
      execution: { workspaceRef: ctx.factoryStore.repo.id, runRef: failure },
      evidence: [failure],
      phase: "planning",
      failureKind,
      message,
    },
  };
}

function appendRecovered(
  factoryStateRoot: string,
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  actionDir: string,
) {
  const recovered = readFactoryActionResult(actionDir);
  assertRecoveredResult(ctx, reaction, recovered);
  return appendFactoryActionEvent({
    factoryStateRoot,
    event: recovered,
    expectedLastEventId: reaction.causationEventId,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reviewFailureMessage(
  meta: Extract<z.infer<typeof ReviewRunMetaSchema>, { status: "failed" }>,
): string {
  return meta.failedReviews?.map((failure) => failure.error).join("; ") || "Plan reviewer failed";
}

function assertRecoveredResult(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  event: FactoryLifecycleEvent,
): void {
  if (
    (event.type !== "planning.review.completed" && event.type !== "factory.action.failed") ||
    event.workItemKey !== deriveFactoryWorkItemKey(ctx.workItem) ||
    event.phaseRunId !== ctx.runId ||
    event.data.handler !== "reviewPlanCandidate" ||
    event.data.attempt !== reaction.attempt ||
    event.data.causationEventId !== reaction.causationEventId ||
    event.data.execution.workspaceRef !== ctx.factoryStore.repo.id
  )
    throw new Error("Recovered planning review result conflicts with phase identity");
  const roots = { "factory-store": ctx.factoryStore.projectRoot, repository: ctx.workspace };
  verifyFactoryArtifactRef(event.data.execution.runRef, roots);
  for (const evidence of event.data.evidence) verifyFactoryArtifactRef(evidence, roots);
}

function ref(ctx: PlanningContext, path: string) {
  return createFactoryArtifactRef({
    base: "factory-store",
    root: ctx.factoryStore.projectRoot,
    path: relative(ctx.factoryStore.projectRoot, path),
  });
}

class MaterializationConflictError extends Error {}

function materialize(source: string, target: string) {
  mkdirSync(dirname(target), { recursive: true });
  const bytes = readFileSync(source);
  if (existsSync(target)) {
    if (!readFileSync(target).equals(bytes))
      throw new MaterializationConflictError(
        `Output plan conflicts with reviewed candidate: ${target}`,
      );
    return;
  }
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, bytes, { flag: "wx" });
  renameSync(temp, target);
}
