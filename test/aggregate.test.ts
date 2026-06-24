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
test("aggregateVerdict passes only when both reviewers pass", () => {
  expect(aggregateVerdict({ verdict: "pass" }, { verdict: "pass" })).toBe("pass");
});
