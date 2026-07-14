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

test("restart guidance reaches the producer and remains subordinate to work-item scope", () => {
  const prompt = renderFactoryImplementationPrompt({
    workItem,
    restartGuidance: "Preserve the stable check name and exercise the real entry path.\n",
  });
  expect(prompt).toContain("## Accepted restart guidance");
  expect(prompt).toContain("Preserve the stable check name and exercise the real entry path.");
  expect(prompt).toContain("subordinate to the original work-item scope");
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

test("review handoff supplies the same accepted restart guidance", () => {
  const handoff = renderFactoryImplementationReviewHandoff({
    workItem,
    phaseRunId: "phase-1",
    candidateCommit: "a".repeat(40),
    restartGuidance: "Exercise the real entry path.\n",
  });
  expect(handoff).toContain("## Accepted restart guidance");
  expect(handoff).toContain("Exercise the real entry path.");
  expect(handoff).toContain("cannot override or materially expand");
});
