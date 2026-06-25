import type {
  FailedReview,
  ReviewSection,
  ReviewVerdict,
  WorkflowStepMetadata,
} from "../lib/aggregate.ts";
import type { ReviewAgentName } from "../lib/workflow-context.ts";
import type { ReviewOutput } from "../lib/schemas.ts";

type WorkflowRunMeta = {
  verdict?: string;
  status?: string;
  [key: string]: unknown;
};

export type WorkflowContext = {
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
    return ctx.exportFailed({ title, reviews, failedReviews, steps: stepMetadata });
  }

  return ctx.export({
    title,
    reviews,
    verdict: ctx.aggregate(...reviews.map(({ review }) => review)),
    steps: stepMetadata,
  });
}

type ReviewTask = ReviewStep & {
  key: string;
  title: string;
  stage: string;
};

function runReviewTask(ctx: WorkflowContext, task: ReviewTask) {
  return ctx.agent(task.agentName).then((review) => ({
    key: task.key,
    title: task.title,
    review,
  }));
}

async function runReviewTasksSerially(ctx: WorkflowContext, tasks: ReviewTask[]) {
  const results: PromiseSettledResult<Awaited<ReturnType<typeof runReviewTask>>>[] = [];
  for (const task of tasks) {
    try {
      results.push({ status: "fulfilled", value: await runReviewTask(ctx, task) });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }
  return results;
}
