import { describe, expect, it } from "vitest";
import { createImplementationReviewFindingId } from "../lib/implementation/finding-identity.ts";
import type { ReviewOutput } from "../lib/review/schema.ts";
import { createImplementationRevisionReview } from "../workflows/implementation-review-findings.ts";

const REVISION = "a".repeat(40);

describe("implementation review finding adapter", () => {
  it("selects actionable findings from both reviewers with deterministic identities", () => {
    const result = createImplementationRevisionReview({
      reviewedRevision: REVISION,
      reviews: {
        implementation: reviewOutput([
          finding({ title: "Fix behavior", must_fix: true }),
          finding({ title: "Optional cleanup", must_fix: false }),
        ]),
        quality: reviewOutput([finding({ title: "Simplify branch", must_fix: true })]),
      },
    });

    expect(result).toEqual({
      ok: true,
      review: {
        reviewedRevision: REVISION,
        findings: [
          expect.objectContaining({
            id: expect.stringMatching(/^implementation-review-finding-[0-9a-f]{64}$/),
            reviewer: "implementation",
            title: "Fix behavior",
          }),
          expect.objectContaining({
            id: expect.stringMatching(/^implementation-review-finding-[0-9a-f]{64}$/),
            reviewer: "quality",
            title: "Simplify branch",
          }),
        ],
      },
    });
    if (!result.ok) throw new Error("expected trusted review");
    expect(result.review.findings.map((item) => item.title)).not.toContain("Optional cleanup");
    expect(
      createImplementationRevisionReview({
        reviewedRevision: REVISION,
        reviews: {
          implementation: reviewOutput([
            finding({ title: "Fix behavior", must_fix: true }),
            finding({ title: "Optional cleanup", must_fix: false }),
          ]),
          quality: reviewOutput([finding({ title: "Simplify branch", must_fix: true })]),
        },
      }),
    ).toEqual(result);
  });

  it("binds identity to revision, reviewer, and canonical content", () => {
    const base = finding({ title: "Fix behavior", must_fix: true });
    const canonical = {
      title: base.title,
      severity: base.severity,
      location: base.location,
      issue: base.issue,
      recommendation: base.recommendation,
      rationale: base.rationale,
    };
    const id = createImplementationReviewFindingId({
      reviewedRevision: REVISION,
      reviewer: "implementation",
      finding: canonical,
    });

    expect(
      createImplementationReviewFindingId({
        reviewedRevision: "b".repeat(40),
        reviewer: "implementation",
        finding: canonical,
      }),
    ).not.toBe(id);
    expect(
      createImplementationReviewFindingId({
        reviewedRevision: REVISION,
        reviewer: "quality",
        finding: canonical,
      }),
    ).not.toBe(id);
    expect(
      createImplementationReviewFindingId({
        reviewedRevision: REVISION,
        reviewer: "implementation",
        finding: { ...canonical, recommendation: "Use the existing guard." },
      }),
    ).not.toBe(id);
  });

  it("rejects incomplete reviewer output and reviews without actionable findings", () => {
    expect(
      createImplementationRevisionReview({
        reviewedRevision: REVISION,
        reviews: {
          implementation: reviewOutput([]),
        } as never,
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("quality"),
    });
    expect(
      createImplementationRevisionReview({
        reviewedRevision: REVISION,
        reviews: {
          implementation: reviewOutput([finding({ must_fix: false })]),
          quality: reviewOutput([]),
        },
      }),
    ).toEqual({
      ok: false,
      error: "Implementation revision requires at least one actionable reviewer finding.",
    });
  });

  it("rejects duplicate actionable findings from one reviewer", () => {
    const duplicate = finding({ must_fix: true });
    const result = createImplementationRevisionReview({
      reviewedRevision: REVISION,
      reviews: {
        implementation: reviewOutput([duplicate, duplicate]),
        quality: reviewOutput([]),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("unique IDs"),
    });
  });
});

function reviewOutput(findings: ReviewOutput["findings"]): ReviewOutput {
  return {
    verdict: findings.some((item) => item.must_fix) ? "needs_changes" : "pass",
    summary: "Focused review result.",
    findings,
  };
}

function finding(
  overrides: Partial<ReviewOutput["findings"][number]> = {},
): ReviewOutput["findings"][number] {
  return {
    title: "Honor the selected source",
    severity: "High",
    location: "lib/implementation/revise.ts:100",
    issue: "The selected plan may be mutated.",
    recommendation: "Verify the plan after the provider run.",
    rationale: "The plan remains implementation authority.",
    must_fix: true,
    ...overrides,
  };
}
