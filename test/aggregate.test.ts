import { expect, test } from "vitest";
import { aggregateVerdict, renderFailedSummary } from "../lib/aggregate.ts";
test("aggregateVerdict prefers blocked over other verdicts", () => {
  expect(aggregateVerdict({ verdict: "blocked" }, { verdict: "pass" })).toBe("blocked");
});
test("aggregateVerdict treats must_fix findings as needs_changes", () => {
  expect(
    aggregateVerdict({ verdict: "pass", findings: [{ must_fix: true }] }, { verdict: "pass" }),
  ).toBe("needs_changes");
});
test("aggregateVerdict treats any needs_changes review as needs_changes", () => {
  expect(
    aggregateVerdict({ verdict: "pass" }, { verdict: "pass" }, { verdict: "needs_changes" }),
  ).toBe("needs_changes");
});
test("aggregateVerdict treats no reviews as needs_changes", () => {
  expect(aggregateVerdict()).toBe("needs_changes");
});

test("aggregateVerdict passes when one reviewer passes", () => {
  expect(aggregateVerdict({ verdict: "pass" })).toBe("pass");
});

test("aggregateVerdict passes when all provided reviewers pass", () => {
  expect(aggregateVerdict({ verdict: "pass" }, { verdict: "pass" }, { verdict: "pass" })).toBe(
    "pass",
  );
});

test("renderFailedSummary includes successful sections and failed reviewers", () => {
  const summary = renderFailedSummary({
    title: "Review Summary",
    runId: "run-1",
    workspace: "/tmp/workspace",
    scope: {
      baseRef: "main",
      headRef: "HEAD",
      mergeBase: "abc123",
      headSha: "def456",
    },
    reviews: [
      {
        key: "implementation",
        title: "Implementation review",
        review: { verdict: "pass", summary: "ok", findings: [] },
      },
    ],
    failedReviews: [{ key: "codeQuality", stage: "quality", error: "bad output" }],
    startedAt: "2026-06-24T00:00:00.000Z",
    durationMs: 1_000,
  });

  expect(summary).toMatch(/## Implementation review/);
  expect(summary).toMatch(/## Failed reviewers/);
  expect(summary).toMatch(/codeQuality/);
  expect(summary).toMatch(/bad output/);
});
