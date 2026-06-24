import { runReviewSteps } from "./review-steps.ts";

export const meta = { name: "review" };

export function run(ctx: Parameters<typeof runReviewSteps>[0]) {
  return runReviewSteps(ctx, "Review Summary", ["review-implementation", "code-quality-review"]);
}
