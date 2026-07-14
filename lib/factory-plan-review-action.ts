import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Agent, AgentProviderOptions, AgentRunResult } from "./agents.ts";
import { createFactoryArtifactRef, verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { factoryActionKey } from "./factory-action-contract.ts";
import {
  factoryActionResultPath,
  readFactoryActionResult,
  writeFactoryActionResult,
} from "./factory-action-result.ts";
import { loadFactoryContinuationForReaction } from "./factory-continuation.ts";
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
  const candidate =
    state?.phase === "planning" && state.candidateEventId
      ? events.find((event) => event.id === state.candidateEventId)
      : undefined;
  if (
    !state ||
    !latest ||
    !candidate ||
    candidate.type !== "planning.candidate.produced" ||
    reaction.handler !== "reviewPlanCandidate" ||
    JSON.stringify(decideNextFactoryAction(state, latest)) !== JSON.stringify(reaction)
  )
    throw new Error("reviewPlanCandidate reaction conflicts with durable Factory state");
  const continuation = loadFactoryContinuationForReaction({
    events,
    causationEventId: reaction.causationEventId,
    phase: "planning",
    handler: "reviewPlanCandidate",
    attempt: reaction.attempt,
    phaseRunId: ctx.runId,
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    roots: { "factory-store": ctx.factoryStore.projectRoot, repository: ctx.workspace },
  });
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
      candidatePath = verifyFactoryArtifactRef(candidate.data.candidate, {
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
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch (error) {
        return failAction(input, actionDir, errorMessage(error), "terminal");
      }
      if (hasConflictingStagedIdentity(raw, ctx, reaction))
        throw new Error("Staged review outcome conflicts with action identity");
      const parsed = StagedReviewOutcomeSchema.safeParse(raw);
      if (!parsed.success) return failAction(input, actionDir, parsed.error.message, "terminal");
      staged = parsed.data;
      assertStagedIdentity(ctx, reaction, staged);
    } else {
      const profile = ctx.identity.actions.reviewPlanCandidate;
      let providerCompletion: ReviewProviderCompletion | undefined;
      let priorReviewJson: string | undefined;
      try {
        priorReviewJson =
          continuation?.review?.type === "planning.review.completed"
            ? priorPlanningReviewJson(ctx, candidate, continuation.review)
            : undefined;
      } catch (error) {
        return failAction(input, actionDir, errorMessage(error), "terminal");
      }
      const reviewCtx = createWorkflowContext({
        workspace: ctx.workspace,
        planPath: candidatePath,
        handoffText: [
          "# Factory work-item authority",
          "",
          "Use this durable source for the original goal, requirements, acceptance criteria, and explicit boundaries.",
          "Only decisions marked accepted, current, locked, or superseding are authoritative; other proposals and metadata remain context.",
          "",
          "```json",
          JSON.stringify(ctx.workItem, null, 2),
          "```",
          ...(continuation
            ? [
                "",
                "# Accepted operator response",
                "",
                "The operator selected re-review for this exact plan candidate. Treat this response as accepted clarification and evidence within the original task scope.",
                "",
                continuation.response,
                ...(priorReviewJson
                  ? ["", "# Prior review result", "", "```json", priorReviewJson, "```"]
                  : []),
              ]
            : []),
        ].join("\n"),
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
        agentProviderFactory: (options) => {
          const provider = input.agentProviderFactory(options);
          return {
            name: provider.name,
            async run(runInput) {
              const result = await provider.run(runInput);
              providerCompletion = captureProviderCompletion(result);
              return result;
            },
          };
        },
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
        providerCompletion,
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
      const terminal = buildFailure(
        ctx,
        reaction,
        actionDir,
        errorMessage(error),
        "terminal",
        candidate.id,
      );
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
          candidate.id,
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
    const event: FactoryActionEvent = {
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
        candidateEventId: candidate.id,
        candidateAttempt: candidate.data.attempt,
        ...(blockingRef ? { blockingFindings: blockingRef } : {}),
      },
    };
    writeFactoryActionResult(actionDir, event);
  }
  const recovered = readFactoryActionResult(actionDir);
  assertRecoveredResult(ctx, reaction, recovered, candidate);
  if (
    recovered.type === "planning.review.completed" &&
    recovered.data.verdict === "pass" &&
    ctx.identity.publicationMode === "local"
  ) {
    const candidatePath = verifyFactoryArtifactRef(candidate.data.candidate, {
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

function priorPlanningReviewJson(
  ctx: PlanningContext,
  candidate: Extract<FactoryLifecycleEvent, { type: "planning.candidate.produced" }>,
  review: Extract<FactoryLifecycleEvent, { type: "planning.review.completed" }>,
): string {
  if (
    review.data.candidateEventId !== candidate.id ||
    review.data.candidateAttempt !== candidate.data.attempt
  )
    throw new Error("Prior planning review conflicts with its candidate");
  const output = ReviewOutputSchema.parse(
    JSON.parse(
      readFileSync(
        verifyFactoryArtifactRef(review.data.review, {
          "factory-store": ctx.factoryStore.projectRoot,
          repository: ctx.workspace,
        }),
        "utf8",
      ),
    ),
  );
  return JSON.stringify(output, null, 2);
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
      providerAborted: z.boolean(),
      providerFailureKind: z.literal("workspace-guard").optional(),
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
type ReviewProviderCompletion =
  | {
      ok: true;
      workspaceStatus?: z.infer<typeof WorkspaceStatusSchema>;
    }
  | {
      ok: false;
      aborted: boolean;
      failureKind?: "workspace-guard";
      workspaceStatus?: z.infer<typeof WorkspaceStatusSchema>;
    };

function buildStagedReviewOutcome(input: {
  ctx: PlanningContext;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  meta: unknown;
  reviewRunDir: string;
  callerAborted: boolean;
  providerCompletion: ReviewProviderCompletion | undefined;
}): StagedReviewOutcome {
  const meta = ReviewRunMetaSchema.safeParse(input.meta);
  const review = readReviewArtifact(join(input.reviewRunDir, "spec-review.json"));
  const workspaceStatus =
    input.providerCompletion?.workspaceStatus ??
    readReviewWorkspaceStatus(join(input.reviewRunDir, "spec-review.raw.json"));
  const common = {
    callerAborted: input.callerAborted,
    ...(workspaceStatus ? { workspaceStatus } : {}),
    review,
  };
  const completion: StagedReviewOutcome["completion"] = !meta.success
    ? { status: "invalid", message: "Plan reviewer returned invalid run metadata", ...common }
    : meta.data.status === "failed" && input.providerCompletion?.ok === true
      ? {
          status: "invalid",
          message: review.kind === "present" ? reviewFailureMessage(meta.data) : review.message,
          ...common,
        }
      : meta.data.status === "failed"
        ? {
            status: "failed",
            message: reviewFailureMessage(meta.data),
            providerAborted:
              input.providerCompletion?.ok === false && input.providerCompletion.aborted,
            ...(input.providerCompletion?.ok === false && input.providerCompletion.failureKind
              ? { providerFailureKind: input.providerCompletion.failureKind }
              : {}),
            ...common,
          }
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
    return parseReviewWorkspaceStatus(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function captureProviderCompletion(result: AgentRunResult): ReviewProviderCompletion {
  const workspaceStatus = parseReviewWorkspaceStatus(result.raw);
  if (result.ok) return { ok: true, ...(workspaceStatus ? { workspaceStatus } : {}) };
  return {
    ok: false,
    aborted: result.aborted === true,
    ...(result.failureKind ? { failureKind: result.failureKind } : {}),
    ...(workspaceStatus ? { workspaceStatus } : {}),
  };
}

function parseReviewWorkspaceStatus(
  raw: unknown,
): z.infer<typeof WorkspaceStatusSchema> | undefined {
  if (!isRecord(raw) || !("workspaceStatus" in raw)) return undefined;
  const parsed = WorkspaceStatusSchema.safeParse(raw.workspaceStatus);
  return parsed.success ? parsed.data : undefined;
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

function hasConflictingStagedIdentity(
  value: unknown,
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
): boolean {
  if (!isRecord(value) || !isRecord(value.action)) return false;
  const action = value.action;
  return (
    ("phaseRunId" in action && action.phaseRunId !== ctx.runId) ||
    ("handler" in action && action.handler !== reaction.handler) ||
    ("attempt" in action && action.attempt !== reaction.attempt) ||
    ("causationEventId" in action && action.causationEventId !== reaction.causationEventId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyReviewFailure(
  completion: Extract<StagedReviewOutcome["completion"], { status: "failed" }>,
): "retryable" | "human-required" {
  if (
    completion.callerAborted ||
    completion.providerAborted ||
    completion.providerFailureKind === "workspace-guard"
  )
    return "human-required";
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
  const state = reduceFactoryLifecycleEvents(
    readFactoryActionEvents(input.factoryStateRoot, deriveFactoryWorkItemKey(input.ctx.workItem)),
  );
  const retainedCandidateEventId = state?.phase === "planning" ? state.candidateEventId : undefined;
  const terminal = buildFailure(
    input.ctx,
    input.reaction,
    actionDir,
    message,
    failureKind,
    retainedCandidateEventId,
  );
  writeFactoryActionResult(actionDir, terminal);
  return appendRecovered(input.factoryStateRoot, input.ctx, input.reaction, actionDir);
}

function buildFailure(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  actionDir: string,
  message: string,
  failureKind: "retryable" | "human-required" | "terminal",
  retainedCandidateEventId?: string,
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
      ...(retainedCandidateEventId ? { retainedCandidateEventId } : {}),
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
  const events = readFactoryActionEvents(factoryStateRoot, deriveFactoryWorkItemKey(ctx.workItem));
  const state = reduceFactoryLifecycleEvents(events);
  const candidate =
    state?.phase === "planning" && state.candidateEventId
      ? events.find((event) => event.id === state.candidateEventId)
      : undefined;
  if (!candidate || candidate.type !== "planning.candidate.produced")
    throw new Error("Recovered planning review has no candidate");
  assertRecoveredResult(ctx, reaction, recovered, candidate);
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
  candidate: Extract<FactoryLifecycleEvent, { type: "planning.candidate.produced" }>,
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
  if (
    event.type === "planning.review.completed" &&
    (event.data.candidateEventId !== candidate.id ||
      event.data.candidateAttempt !== candidate.data.attempt)
  )
    throw new Error("Recovered planning review conflicts with its candidate");
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
