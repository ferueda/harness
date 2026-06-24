import { expect, test } from "vitest";
import { aggregateVerdict } from "../lib/aggregate.ts";
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
