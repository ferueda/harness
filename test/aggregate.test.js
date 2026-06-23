import assert from "node:assert/strict";
import test from "node:test";
import { aggregateVerdict } from "../lib/aggregate.js";

test("aggregateVerdict prefers blocked over other verdicts", () => {
  assert.equal(aggregateVerdict({ verdict: "blocked" }, { verdict: "pass" }), "blocked");
});

test("aggregateVerdict treats must_fix findings as needs_changes", () => {
  assert.equal(
    aggregateVerdict({ verdict: "pass", findings: [{ must_fix: true }] }, { verdict: "pass" }),
    "needs_changes",
  );
});

test("aggregateVerdict passes only when both reviewers pass", () => {
  assert.equal(aggregateVerdict({ verdict: "pass" }, { verdict: "pass" }), "pass");
});
