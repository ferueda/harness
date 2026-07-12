import { expect, test } from "vitest";
import {
  renderFactoryPlanningInitialPrompt,
  renderFactoryPlanningRevisionPrompt,
} from "../lib/prompts/factory-planning.ts";

test("factory planner prioritizes explicit intent and minimum-sufficient scope", () => {
  const prompt = renderFactoryPlanningInitialPrompt({
    workItemJson: '{"title":"Small fix"}',
    draftPath: "/tmp/draft.md",
    currentDate: "2026-07-11",
  });

  expect(prompt).toContain("Repository hard invariants and documented project intent");
  expect(prompt).toContain("Explicit work-item goal, requirements, acceptance criteria, and scope");
  expect(prompt).toContain("accepted, current, locked, or superseding");
  expect(prompt).toContain("Never infer authority from tracker comment order");
  expect(prompt).toContain("return needs-human and quote the conflicting directions");
  expect(prompt).toContain("Write the minimum sufficient plan");
  expect(prompt).toContain("Conditional content:");
  expect(prompt).toContain("smallest coherent change");
  expect(prompt).toContain("smallest focused checks plus the repository's canonical validation");
  expect(prompt).toContain("routine diff inspection");
  expect(prompt).toContain("must trace to an acceptance criterion");
  expect(prompt).not.toContain('Include a "Skills for the executor" table');
});

test("factory revision receives blockers and requires pruning", () => {
  const prompt = renderFactoryPlanningRevisionPrompt({
    draftPath: "/tmp/draft.md",
    currentDate: "2026-07-11",
    reviewFindingsJson: '[{"id":"spec-002","must_fix":true}]',
  });

  expect(prompt).toContain("latest blocking review findings");
  expect(prompt).toContain("Advisory findings remain in review evidence");
  expect(prompt).toContain("every supplied must_fix finding requires a decision");
  expect(prompt).toContain("latest blocking finding id");
  expect(prompt).toContain("remove obsolete, duplicated, speculative, or superseded material");
  expect(prompt).toContain('"spec-002"');
});
