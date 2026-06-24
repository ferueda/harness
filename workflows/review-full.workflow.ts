import { runReviewSteps } from "./review-steps.ts";
import type { WorkflowContext } from "./review-steps.ts";

export const meta = { name: "review-full" };

export function run(ctx: WorkflowContext) {
  return runReviewSteps(ctx, "Full Review Summary", [
    "review-implementation",
    "code-quality-review",
    "simplify",
  ]);
}
