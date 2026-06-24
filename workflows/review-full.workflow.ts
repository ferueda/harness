import { runReviewSteps } from "./review-steps.ts";

export const meta = { name: "review-full" };

export function run(ctx: Parameters<typeof runReviewSteps>[0]) {
  return runReviewSteps(ctx, "Full Review Summary", [
    "review-implementation",
    "code-quality-review",
    "simplify",
  ]);
}
