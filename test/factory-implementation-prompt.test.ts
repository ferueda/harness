import { expect, test } from "vitest";
import {
  renderFactoryImplementationPrompt,
  renderFactoryImplementationReviewHandoff,
} from "../lib/prompts/factory-implementation.ts";

const workItem = {
  id: "item-1",
  source: "file" as const,
  title: "Ship implementation",
  body: "Keep it scoped.",
  labels: [],
};

test("implementation prompt grants edits but forbids Git and Factory authority", () => {
  const prompt = renderFactoryImplementationPrompt({ workItem, planPath: "/tmp/plan.md" });
  expect(prompt).toContain("Follow the reviewed plan");
  expect(prompt).toContain("Do not stage, commit, checkout");
  expect(prompt).toContain("Do not mutate trackers");
});

test("accepted revision response reaches the producer with prior candidate identity", () => {
  const prompt = renderFactoryImplementationPrompt({
    workItem,
    revision: {
      priorCommit: "a".repeat(40),
      blockingFindings: [],
      operatorResponse: "The live smoke passed; preserve the candidate and update only evidence.",
    },
  });
  expect(prompt).toContain("## Accepted operator response");
  expect(prompt).toContain("a".repeat(40));
  expect(prompt).toContain("The live smoke passed");
});

test("review handoff identifies the exact immutable candidate", () => {
  const handoff = renderFactoryImplementationReviewHandoff({
    workItem,
    phaseRunId: "phase-1",
    candidateCommit: "a".repeat(40),
  });
  expect(handoff).toContain("phase-1");
  expect(handoff).toContain("a".repeat(40));
  expect(handoff).toContain("Ship implementation");
});

test("review handoff supplies the accepted re-review response", () => {
  const handoff = renderFactoryImplementationReviewHandoff({
    workItem,
    phaseRunId: "phase-1",
    candidateCommit: "a".repeat(40),
    continuation: {
      response: "The live entry-path smoke passed.",
      priorReview: {
        implementation: { verdict: "blocked", summary: "tool unavailable", findings: [] },
        quality: { verdict: "pass", summary: "ok", findings: [] },
      },
    },
  });
  expect(handoff).toContain("## Accepted operator response");
  expect(handoff).toContain("The live entry-path smoke passed.");
  expect(handoff).toContain("Prior implementation review");
  expect(handoff).toContain("tool unavailable");
  expect(handoff).toContain("Prior quality review");
});
