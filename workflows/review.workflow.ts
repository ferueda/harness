import { runReviewSteps } from "./review-steps.ts";
import type { WorkflowContext } from "./review-steps.ts";

export const meta = { name: "review" };

export function run(ctx: WorkflowContext) {
  return runReviewSteps(ctx, "Review Summary", ["review-implementation", "code-quality-review"]);
}
