import { expect, test } from "vitest";
import { aggregateVerdict, renderFailedSummary, renderSummary } from "../lib/aggregate.ts";
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
    title: "Change Review Summary",
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

test("renderSummary includes omitted steps for partial reviews", () => {
  const summary = renderSummary({
    title: "Change Review Summary",
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
    verdict: "pass",
    startedAt: "2026-06-24T00:00:00.000Z",
    durationMs: 1_000,
    steps: {
      workflow: "change-review",
      availableSteps: ["implementation", "quality", "simplify"],
      requestedSteps: ["implementation"],
      executedSteps: ["implementation"],
      omittedSteps: ["quality", "simplify"],
      partial: true,
    },
  });

  expect(summary).toMatch(/## Steps/);
  expect(summary).toMatch(/Executed: `implementation`/);
  expect(summary).toMatch(/Omitted: `quality`, `simplify`/);
});

test("renderFailedSummary includes omitted steps for failed partial reviews", () => {
  const summary = renderFailedSummary({
    title: "Change Review Summary",
    runId: "run-1",
    workspace: "/tmp/workspace",
    scope: {
      baseRef: "main",
      headRef: "HEAD",
      mergeBase: "abc123",
      headSha: "def456",
    },
    reviews: [],
    failedReviews: [{ key: "implementation", stage: "implementation", error: "failed" }],
    startedAt: "2026-06-24T00:00:00.000Z",
    durationMs: 1_000,
    steps: {
      workflow: "change-review",
      availableSteps: ["implementation", "quality", "simplify"],
      requestedSteps: ["implementation"],
      executedSteps: ["implementation"],
      omittedSteps: ["quality", "simplify"],
      partial: true,
    },
  });

  expect(summary).toMatch(/## Steps/);
  expect(summary).toMatch(/Omitted: `quality`, `simplify`/);
  expect(summary).toMatch(/## Failed reviewers/);
});

test("renderSummary omits step section for full reviews", () => {
  const summary = renderSummary({
    title: "Change Review Summary",
    runId: "run-1",
    workspace: "/tmp/workspace",
    scope: {
      baseRef: "main",
      headRef: "HEAD",
      mergeBase: "abc123",
      headSha: "def456",
    },
    reviews: [],
    verdict: "pass",
    startedAt: "2026-06-24T00:00:00.000Z",
    durationMs: 1_000,
    steps: {
      workflow: "change-review",
      availableSteps: ["implementation", "quality", "simplify"],
      requestedSteps: ["implementation", "quality", "simplify"],
      executedSteps: ["implementation", "quality", "simplify"],
      omittedSteps: [],
      partial: false,
    },
  });

  expect(summary).not.toMatch(/## Steps/);
});
