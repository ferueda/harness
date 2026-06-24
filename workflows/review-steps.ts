import type { ReviewSection, ReviewVerdict } from "../lib/aggregate.ts";
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
  reviewInfo(name: ReviewAgentName): { key: string; title: string };
  export(input: {
    title: string;
    reviews: ReviewSection[];
    verdict: ReviewVerdict;
  }): WorkflowRunMeta;
};

export async function runReviewSteps(
  ctx: WorkflowContext,
  title: string,
  agents: ReviewAgentName[],
): Promise<WorkflowRunMeta> {
  const reviews: ReviewSection[] = [];

  for (const agentName of agents) {
    const reviewInfo = ctx.reviewInfo(agentName);
    reviews.push({
      key: reviewInfo.key,
      title: reviewInfo.title,
      review: await ctx.agent(agentName),
    });
  }

  return ctx.export({
    title,
    reviews,
    verdict: ctx.aggregate(...reviews.map(({ review }) => review)),
  });
}
