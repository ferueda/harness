import type {
  FailedReview,
  ReviewSection,
  ReviewVerdict,
  WorkflowStepMetadata,
} from "../lib/aggregate.ts";
import {
  DEFAULT_WORKFLOW_HEARTBEAT_MS,
  STEP_ID_BY_AGENT,
  type WorkflowEventSink,
} from "../lib/workflow-events.ts";
import type { ReviewAgentName } from "../lib/workflow-context.ts";
import type { ReviewOutput } from "../lib/schemas.ts";

type WorkflowRunMeta = {
  verdict?: string;
  status?: string;
  [key: string]: unknown;
};

export type WorkflowContext = {
  runId?: string;
  runDir?: string;
  workspace?: string;
  eventSink?: WorkflowEventSink;
  heartbeatMs?: number;
  agent(name: ReviewAgentName): Promise<ReviewOutput>;
  aggregate(...reviews: ReviewOutput[]): ReviewVerdict;
  reviewInfo(name: ReviewAgentName): { key: string; title: string; stage: string };
  reviewConcurrency?: "parallel" | "serial";
  export(input: {
    title: string;
    reviews: ReviewSection[];
    verdict: ReviewVerdict;
    steps?: WorkflowStepMetadata;
  }): WorkflowRunMeta;
  exportFailed(input: {
    title: string;
    reviews: ReviewSection[];
    failedReviews: FailedReview[];
    steps?: WorkflowStepMetadata;
  }): WorkflowRunMeta;
};

export type ReviewStep = {
  agentName: ReviewAgentName;
};

export async function runReviewSteps(
  ctx: WorkflowContext,
  title: string,
  steps: ReviewStep[],
  stepMetadata?: WorkflowStepMetadata,
): Promise<WorkflowRunMeta> {
  const reviewTasks = steps.map((step) => ({
    ...step,
    ...ctx.reviewInfo(step.agentName),
  }));
  const results =
    ctx.reviewConcurrency === "serial"
      ? await runReviewTasksSerially(ctx, reviewTasks)
      : await Promise.allSettled(reviewTasks.map((task) => runReviewTask(ctx, task)));
  const exportStepMetadata = trimExecutedStepMetadata(stepMetadata, results.length);

  const reviews: ReviewSection[] = [];
  const failedReviews: FailedReview[] = [];

  for (const [index, result] of results.entries()) {
    const reviewInfo = reviewTasks[index];

    if (result.status === "fulfilled") {
      reviews.push(result.value);
      continue;
    }

    failedReviews.push({
      key: reviewInfo.key,
      stage: reviewInfo.stage,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
  }

  if (failedReviews.length > 0) {
    return ctx.exportFailed({ title, reviews, failedReviews, steps: exportStepMetadata });
  }

  return ctx.export({
    title,
    reviews,
    verdict: ctx.aggregate(...reviews.map(({ review }) => review)),
    steps: exportStepMetadata,
  });
}

type ReviewTask = ReviewStep & {
  key: string;
  title: string;
  stage: string;
};

function runReviewTask(ctx: WorkflowContext, task: ReviewTask) {
  if (!ctx.eventSink) {
    return ctx.agent(task.agentName).then((review) => ({
      key: task.key,
      title: task.title,
      review,
    }));
  }

  const startedAt = new Date();
  const stepId = STEP_ID_BY_AGENT[task.agentName];
  const heartbeatMs = ctx.heartbeatMs ?? DEFAULT_WORKFLOW_HEARTBEAT_MS;
  const baseEvent = {
    runId: requiredRunId(ctx),
    runDir: ctx.runDir,
    workspace: ctx.workspace,
    stepId,
    cliStep: task.stage,
    startedAt: startedAt.toISOString(),
  };
  let active = true;
  ctx.eventSink({
    type: "step:start",
    ...baseEvent,
    status: "running",
  });

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (!active) return;
          ctx.eventSink?.({
            type: "step:heartbeat",
            ...baseEvent,
            status: "running",
            elapsedMs: Date.now() - startedAt.getTime(),
          });
        }, heartbeatMs)
      : undefined;

  const finish = (status: "completed" | "failed", error?: string) => {
    active = false;
    if (heartbeat) clearInterval(heartbeat);
    ctx.eventSink?.({
      type: "step:end",
      ...baseEvent,
      status,
      durationMs: Date.now() - startedAt.getTime(),
      ...(error ? { error } : {}),
      outputs: stepOutputs(task.stage),
    });
  };

  return ctx.agent(task.agentName).then(
    (review) => {
      finish("completed");
      return {
        key: task.key,
        title: task.title,
        review,
      };
    },
    (error: unknown) => {
      finish("failed", error instanceof Error ? error.message : String(error));
      throw error;
    },
  );
}

async function runReviewTasksSerially(ctx: WorkflowContext, tasks: ReviewTask[]) {
  const results: PromiseSettledResult<Awaited<ReturnType<typeof runReviewTask>>>[] = [];
  for (const task of tasks) {
    try {
      results.push({ status: "fulfilled", value: await runReviewTask(ctx, task) });
    } catch (reason) {
      results.push({ status: "rejected", reason });
      break;
    }
  }
  return results;
}

function trimExecutedStepMetadata(
  stepMetadata: WorkflowStepMetadata | undefined,
  executedCount: number,
): WorkflowStepMetadata | undefined {
  if (!stepMetadata || executedCount >= stepMetadata.executedSteps.length) return stepMetadata;

  const executedSteps = stepMetadata.executedSteps.slice(0, executedCount);
  const stoppedSteps = stepMetadata.executedSteps.slice(executedCount);
  return {
    ...stepMetadata,
    executedSteps,
    omittedSteps: [...stepMetadata.omittedSteps, ...stoppedSteps],
    partial: true,
  };
}

function requiredRunId(ctx: WorkflowContext): string {
  if (ctx.runId) return ctx.runId;
  throw new Error("WorkflowContext.runId is required when emitting workflow events");
}

function stepOutputs(stage: string): string[] {
  return [
    `${stage}-review.prompt.md`,
    `${stage}-review.raw.json`,
    `${stage}-review.json`,
    `${stage}-review.stream.jsonl`,
  ];
}
