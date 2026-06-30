import type { WorkflowStepMetadata } from "../lib/aggregate.ts";
import type { ReviewAgentName } from "../lib/workflow-context.ts";
import { runReviewSteps, type ReviewStep, type WorkflowContext } from "./review-steps.ts";

export const meta = { name: "plan-review" };

// Keep the step shape parallel to change-review even though plan-review has one fixed step.
const PLAN_REVIEW_STEPS = ["spec"] as const;
type PlanReviewStepId = (typeof PLAN_REVIEW_STEPS)[number];

const STEP_AGENTS = {
  spec: "review-spec",
} satisfies Record<PlanReviewStepId, ReviewAgentName>;

export function run(ctx: WorkflowContext) {
  const reviewSteps = PLAN_REVIEW_STEPS.map(
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
  return runReviewSteps(ctx, "Plan Review Summary", reviewSteps, buildStepMetadata()).then(
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

function buildStepMetadata(): WorkflowStepMetadata {
  return {
    workflow: meta.name,
    availableSteps: [...PLAN_REVIEW_STEPS],
    requestedSteps: [...PLAN_REVIEW_STEPS],
    executedSteps: [...PLAN_REVIEW_STEPS],
    omittedSteps: [],
    partial: false,
  };
}
