import { expect, test } from "vitest";
import {
  renderFactoryPlanningInitialPrompt,
  renderFactoryPlanningRevisionPrompt,
} from "../lib/prompts/factory-planning.ts";

test("factory planner preserves task authority", () => {
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
});

test("factory planner uses a compact decision-rich plan shape", () => {
  const prompt = renderFactoryPlanningInitialPrompt({
    workItemJson: '{"title":"Small fix"}',
    draftPath: "/tmp/draft.md",
    currentDate: "2026-07-11",
  });

  expect(prompt).toContain("Write the minimum sufficient plan");
  expect(prompt).toContain("capable, context-limited executor with repository access");
  expect(prompt).toContain("Use this default plan shape:");
  expect(prompt).toContain("## Goal");
  expect(prompt).toContain("## Changes");
  expect(prompt).toContain("## Verify");
  expect(prompt).toContain("## Boundaries");
  expect(prompt).toContain("Omit when none exist");
  expect(prompt).toContain("smallest coherent change");
  expect(prompt).toContain("highest existing stable test seam proving acceptance");
  expect(prompt).toContain("distinct invariant or failure mode unobservable there");
  expect(prompt).toContain("changes an executor decision");
  expect(prompt).toContain("Generic planning templates are optional");
  expect(prompt).toContain("routine diff inspection");
  expect(prompt).not.toContain("Conditional content:");
  expect(prompt).not.toContain("separate test matrices");
  expect(prompt).not.toContain("maintenance notes");
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
