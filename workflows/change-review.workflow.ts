import type { WorkflowStepMetadata } from "../lib/aggregate.ts";
import type { ReviewAgentName } from "../lib/workflow-context.ts";
import { runReviewSteps, type ReviewStep, type WorkflowContext } from "./review-steps.ts";

export const meta = { name: "change-review" };

export const CHANGE_REVIEW_STEPS = ["implementation", "quality", "simplify"] as const;
export type ChangeReviewStepId = (typeof CHANGE_REVIEW_STEPS)[number];

type ChangeReviewOptions = {
  steps?: ChangeReviewStepId[];
};

const STEP_AGENTS = {
  implementation: "review-implementation",
  quality: "code-quality-review",
  simplify: "simplify",
} satisfies Record<ChangeReviewStepId, ReviewAgentName>;

export function run(ctx: WorkflowContext, options: ChangeReviewOptions = {}) {
  const selectedSteps = normalizeChangeReviewSteps(options.steps);
  const reviewSteps = selectedSteps.map(
    (id): ReviewStep => ({
      agentName: STEP_AGENTS[id],
    }),
  );
  const runId = ctx.eventSink ? requiredRunId(ctx) : undefined;
  ctx.eventSink?.({
    type: "run:start",
    runId: runId ?? "",
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
    (result) => {
      ctx.eventSink?.({
        type: "run:end",
        runId: runId ?? "",
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
        runId: runId ?? "",
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

function requiredRunId(ctx: WorkflowContext): string {
  if (ctx.runId) return ctx.runId;
  throw new Error("WorkflowContext.runId is required when emitting workflow events");
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
