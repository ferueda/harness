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
  const results = await Promise.allSettled(
    reviewTasks.map(async ({ agentName, key, title: reviewTitle }) => {
      return {
        key,
        title: reviewTitle,
        review: await ctx.agent(agentName),
      };
    }),
  );

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
