import { createHash } from "node:crypto";
import type { ImplementationReviewFinding, ImplementationReviewer } from "./revise-schema.ts";

export function createImplementationReviewFindingId(input: {
  reviewedRevision: string;
  reviewer: ImplementationReviewer;
  finding: Omit<ImplementationReviewFinding, "id" | "reviewer">;
}): string {
  return `implementation-review-finding-${sha256(
    JSON.stringify({
      reviewedRevision: input.reviewedRevision,
      reviewer: input.reviewer,
      finding: canonicalImplementationReviewFinding(input.finding),
    }),
  )}`;
}

export function canonicalImplementationReviewFinding(
  finding: Omit<ImplementationReviewFinding, "id" | "reviewer">,
): Readonly<Omit<ImplementationReviewFinding, "id" | "reviewer">> {
  return {
    title: finding.title,
    severity: finding.severity,
    location: finding.location,
    issue: finding.issue,
    recommendation: finding.recommendation,
    rationale: finding.rationale,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
