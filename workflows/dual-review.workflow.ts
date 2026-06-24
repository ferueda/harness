import type { ReviewVerdict } from "../lib/aggregate.ts";
import type { ReviewOutput } from "../lib/schemas.ts";

export const meta = { name: "dual-review" };

type WorkflowContext = {
  agent(name: "review-implementation" | "code-quality-review"): Promise<ReviewOutput>;
  aggregate(implementation: ReviewOutput, quality: ReviewOutput): ReviewVerdict;
  export(input: {
    implementation: ReviewOutput;
    quality: ReviewOutput;
    verdict: ReviewVerdict;
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
    verdict: ctx.aggregate(implementation, quality),
  });
}
