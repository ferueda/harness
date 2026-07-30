import type {
  FailedReview,
  ReviewScope,
  ReviewVerdict,
  WorkflowStepMetadata,
} from "../lib/review/aggregate.ts";
import type { ReviewAgentName } from "../lib/review/runtime.ts";
import type { ReviewOutput } from "../lib/review/schema.ts";
import {
  runReviewSteps,
  type ReviewStep,
  type ReviewStepRunResult,
  type WorkflowContext,
} from "./review-steps.ts";

export const meta = { name: "change-review" };

export const CHANGE_REVIEW_STEPS = ["implementation", "quality"] as const;
export type ChangeReviewStepId = (typeof CHANGE_REVIEW_STEPS)[number];

type ChangeReviewOptions = {
  steps?: ChangeReviewStepId[];
};

export type ChangeReviewOutputs = Readonly<{
  implementation?: ReviewOutput;
  quality?: ReviewOutput;
}>;

type ChangeReviewIdentity = Readonly<{
  runId: string;
  runDir: string;
  workspace: string;
  scope: Readonly<ReviewScope>;
}>;

type ChangeReviewResultBase = ChangeReviewIdentity &
  Readonly<{
    reviewOutputs: ChangeReviewOutputs;
  }>;

type WorkflowMetadata = Readonly<{
  [key: string]: unknown;
}>;

export type ChangeReviewResult =
  | (WorkflowMetadata &
      ChangeReviewResultBase &
      Readonly<{
        status: "completed";
        verdict: ReviewVerdict;
        reviewFailures: readonly [];
      }>)
  | (WorkflowMetadata &
      ChangeReviewResultBase &
      Readonly<{
        status: "failed";
        verdict?: never;
        reviewFailures: readonly [FailedReview, ...FailedReview[]];
      }>)
  | (WorkflowMetadata &
      Omit<ChangeReviewResultBase, "reviewOutputs"> &
      Readonly<{
        status: "dry_run";
        verdict?: never;
        reviewOutputs: Readonly<{ implementation?: never; quality?: never }>;
        reviewFailures: readonly [];
      }>);

const STEP_AGENTS = {
  implementation: "review-implementation",
  quality: "code-quality-review",
} satisfies Record<ChangeReviewStepId, ReviewAgentName>;

export function run(
  ctx: WorkflowContext,
  options: ChangeReviewOptions = {},
): Promise<ChangeReviewResult> {
  const identity = requireChangeReviewIdentity(ctx);
  const selectedSteps = normalizeChangeReviewSteps(options.steps);
  const reviewSteps = selectedSteps.map(
    (id): ReviewStep => ({
      agentName: STEP_AGENTS[id],
    }),
  );
  ctx.eventSink?.({
    type: "run:start",
    runId: identity.runId,
    runDir: ctx.runDir,
    workspace: ctx.workspace,
    status: "running",
    startedAt: new Date().toISOString(),
  });
  const startedAt = Date.now();
  return runReviewSteps(
    ctx,
    "Change Review Summary",
    reviewSteps,
    buildStepMetadata(selectedSteps),
  ).then(
    (stepResult) => {
      const result = buildChangeReviewResult(identity, stepResult);
      ctx.eventSink?.({
        type: "run:end",
        runId: identity.runId,
        runDir: ctx.runDir,
        workspace: ctx.workspace,
        status: result.status === "failed" ? "failed" : "completed",
        durationMs: Date.now() - startedAt,
      });
      return result;
    },
    (error: unknown) => {
      ctx.eventSink?.({
        type: "run:end",
        runId: identity.runId,
        runDir: ctx.runDir,
        workspace: ctx.workspace,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    },
  );
}

export function changeReviewCliMetadata(result: ChangeReviewResult): WorkflowMetadata {
  const {
    reviewOutputs: _reviewOutputs,
    reviewFailures: _reviewFailures,
    runDir,
    ...metadata
  } = result;
  return result.status === "dry_run" ? { ...metadata, runDir } : metadata;
}

function requireChangeReviewIdentity(ctx: WorkflowContext): ChangeReviewIdentity {
  if (!ctx.runId) throw new Error("Change review requires WorkflowContext.runId");
  if (!ctx.runDir) throw new Error("Change review requires WorkflowContext.runDir");
  if (!ctx.workspace) throw new Error("Change review requires WorkflowContext.workspace");
  if (!ctx.scope) throw new Error("Change review requires an exact Git scope");
  return {
    runId: ctx.runId,
    runDir: ctx.runDir,
    workspace: ctx.workspace,
    scope: {
      baseRef: ctx.scope.baseRef,
      headRef: ctx.scope.headRef,
      mergeBase: ctx.scope.mergeBase,
      headSha: ctx.scope.headSha,
    },
  };
}

function buildChangeReviewResult(
  identity: ChangeReviewIdentity,
  stepResult: ReviewStepRunResult,
): ChangeReviewResult {
  const { status, verdict, ...metadata } = stepResult.metadata;
  if (status === "dry_run") {
    return {
      ...metadata,
      ...identity,
      status,
      reviewOutputs: {},
      reviewFailures: [],
    };
  }

  const reviewOutputs = collectReviewOutputs(stepResult);
  if (status === "completed") {
    if (!isReviewVerdict(verdict)) {
      throw new Error(`Change review completed with invalid verdict: ${String(verdict)}`);
    }
    if (stepResult.failedReviews.length > 0) {
      throw new Error("Change review completed with reviewer failures");
    }
    return {
      ...metadata,
      ...identity,
      status,
      verdict,
      reviewOutputs,
      reviewFailures: [],
    };
  }

  if (status === "failed") {
    const [firstFailure, ...remainingFailures] = stepResult.failedReviews;
    if (!firstFailure) throw new Error("Change review failed without a reviewer failure");
    return {
      ...metadata,
      ...identity,
      status,
      reviewOutputs,
      reviewFailures: [firstFailure, ...remainingFailures],
    };
  }

  throw new Error(`Change review returned unsupported status: ${String(status)}`);
}

function collectReviewOutputs(stepResult: ReviewStepRunResult): ChangeReviewOutputs {
  const outputs: {
    implementation?: ReviewOutput;
    quality?: ReviewOutput;
  } = {};
  for (const section of stepResult.reviews) {
    if (section.key === "implementation") outputs.implementation = section.review;
    if (section.key === "codeQuality") outputs.quality = section.review;
  }
  return outputs;
}

function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return value === "pass" || value === "needs_changes" || value === "blocked";
}

export function normalizeChangeReviewSteps(
  input: readonly string[] | undefined,
): ChangeReviewStepId[] {
  if (input === undefined) return [...CHANGE_REVIEW_STEPS];
  if (input.length === 0) {
    throw new Error(`No change-review steps requested. Valid steps: ${validStepList()}`);
  }

  const uniqueRequested = new Set(input);
  const unknown = [...uniqueRequested].filter((step) => !isChangeReviewStep(step));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown change-review step: ${unknown.join(", ")}. Valid steps: ${validStepList()}`,
    );
  }

  return CHANGE_REVIEW_STEPS.filter((step) => uniqueRequested.has(step));
}

export function isChangeReviewStep(step: string): step is ChangeReviewStepId {
  return (CHANGE_REVIEW_STEPS as readonly string[]).includes(step);
}

function buildStepMetadata(selectedSteps: ChangeReviewStepId[]): WorkflowStepMetadata {
  const omittedSteps = CHANGE_REVIEW_STEPS.filter((step) => !selectedSteps.includes(step));
  return {
    workflow: meta.name,
    availableSteps: [...CHANGE_REVIEW_STEPS],
    requestedSteps: [...selectedSteps],
    executedSteps: [...selectedSteps],
    omittedSteps,
    partial: omittedSteps.length > 0,
  };
}

function validStepList(): string {
  return CHANGE_REVIEW_STEPS.join(", ");
}
