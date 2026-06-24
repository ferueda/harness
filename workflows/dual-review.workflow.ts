export const meta = { name: "dual-review" };

type ReviewOutput = {
  verdict?: string;
  summary?: string;
  findings?: unknown[];
};

type WorkflowContext = {
  agent(name: "review-implementation" | "code-quality-review"): Promise<ReviewOutput>;
  aggregate(reviews: [ReviewOutput, ReviewOutput]): string;
  export(input: {
    implementation: ReviewOutput;
    quality: ReviewOutput;
    verdict: string;
  }): WorkflowRunMeta;
};

type WorkflowRunMeta = {
  verdict?: string;
  status?: string;
  [key: string]: unknown;
};

export async function run(ctx: WorkflowContext): Promise<WorkflowRunMeta> {
  const implementation = await ctx.agent("review-implementation");
  const quality = await ctx.agent("code-quality-review");

  return ctx.export({
    implementation,
    quality,
    verdict: ctx.aggregate([implementation, quality]),
  });
}
