import type { ReviewSection, ReviewVerdict } from "../lib/aggregate.ts";
import type { ReviewOutput } from "../lib/schemas.ts";

type ReviewAgentName = "review-implementation" | "code-quality-review" | "simplify";

type WorkflowRunMeta = {
  verdict?: string;
  status?: string;
  [key: string]: unknown;
};

type WorkflowContext = {
  agent(name: ReviewAgentName): Promise<ReviewOutput>;
  aggregate(...reviews: ReviewOutput[]): ReviewVerdict;
  reviewTitle(name: ReviewAgentName): string;
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
  const reviews: (ReviewSection & { review: ReviewOutput })[] = [];

  for (const agentName of agents) {
    reviews.push({
      title: ctx.reviewTitle(agentName),
      review: await ctx.agent(agentName),
    });
  }

  return ctx.export({
    title,
    reviews,
    verdict: ctx.aggregate(...reviews.map(({ review }) => review)),
  });
}
