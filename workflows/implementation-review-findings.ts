import { z } from "zod";
import {
  canonicalImplementationReviewFinding,
  createImplementationReviewFindingId,
} from "../lib/implementation/finding-identity.ts";
import {
  IMPLEMENTATION_REVISION_MAX_FINDINGS,
  ImplementationRevisionGitRevisionSchema,
  ImplementationRevisionReviewSchema,
  type ImplementationReviewFinding,
  type ImplementationReviewer,
  type ImplementationRevisionReview,
} from "../lib/implementation/revise-schema.ts";
import { ReviewOutputSchema, type ReviewOutput } from "../lib/review/schema.ts";

export type ImplementationReviewerOutputs = Readonly<{
  implementation: ReviewOutput;
  quality: ReviewOutput;
}>;

export type ImplementationRevisionReviewResult =
  | Readonly<{ ok: true; review: ImplementationRevisionReview }>
  | Readonly<{ ok: false; error: string }>;

const ReviewerOutputsSchema = z
  .object({
    implementation: ReviewOutputSchema,
    quality: ReviewOutputSchema,
  })
  .strict();

export function createImplementationRevisionReview(input: {
  reviewedRevision: string;
  reviews: ImplementationReviewerOutputs;
}): ImplementationRevisionReviewResult {
  const revision = ImplementationRevisionGitRevisionSchema.safeParse(input.reviewedRevision);
  if (!revision.success) {
    return {
      ok: false,
      error: `Invalid reviewed implementation revision: ${formatZodError(revision.error.issues)}`,
    };
  }
  const reviews = ReviewerOutputsSchema.safeParse(input.reviews);
  if (!reviews.success) {
    return {
      ok: false,
      error: `Invalid implementation reviewer outputs: ${formatZodError(reviews.error.issues)}`,
    };
  }

  const findings = (
    [
      ["implementation", reviews.data.implementation],
      ["quality", reviews.data.quality],
    ] as const
  ).flatMap(([reviewer, output]) =>
    output.findings
      .filter((finding) => finding.must_fix)
      .map((finding) =>
        implementationReviewFinding({
          reviewedRevision: revision.data,
          reviewer,
          finding,
        }),
      ),
  );

  if (findings.length === 0) {
    return {
      ok: false,
      error: "Implementation revision requires at least one actionable reviewer finding.",
    };
  }
  if (findings.length > IMPLEMENTATION_REVISION_MAX_FINDINGS) {
    return {
      ok: false,
      error: `Implementation revision accepts at most ${IMPLEMENTATION_REVISION_MAX_FINDINGS} actionable findings.`,
    };
  }

  const review = ImplementationRevisionReviewSchema.safeParse({
    reviewedRevision: revision.data,
    findings,
  });
  if (!review.success) {
    return {
      ok: false,
      error: `Invalid implementation revision review: ${formatZodError(review.error.issues)}`,
    };
  }
  return { ok: true, review: review.data };
}

function implementationReviewFinding(input: {
  reviewedRevision: string;
  reviewer: ImplementationReviewer;
  finding: ReviewOutput["findings"][number];
}): ImplementationReviewFinding {
  const canonical = canonicalImplementationReviewFinding(input.finding);
  return {
    id: createImplementationReviewFindingId({
      reviewedRevision: input.reviewedRevision,
      reviewer: input.reviewer,
      finding: canonical,
    }),
    reviewer: input.reviewer,
    ...canonical,
  };
}

function formatZodError(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}
