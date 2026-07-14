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
  expect(prompt).toContain(
    "missing decision would materially change scope or architecture, return needs-human",
  );
  expect(prompt).toContain("smallest set of exact questions needed to resolve it");
});

test("factory planner uses a compact decision-rich plan shape", () => {
  const prompt = renderFactoryPlanningInitialPrompt({
    workItemJson: '{"title":"Small fix"}',
    draftPath: "/tmp/draft.md",
    currentDate: "2026-07-11",
  });

  expect(prompt).toContain("Write the minimum sufficient plan");
  expect(prompt).toContain("capable, context-limited executor with repository access");
  expect(prompt).toContain("without prior context about the task at hand");
  expect(prompt).not.toContain("no prior conversation");
  expect(prompt).toContain("Use this default plan shape:");
  expect(prompt).toContain("## Goal");
  expect(prompt).toContain("## Changes");
  expect(prompt).toContain("## Verify");
  expect(prompt).toContain("## Boundaries");
  expect(prompt).toContain("Omit when none exist");
  expect(prompt).not.toContain("unresolved decisions");
  expect(prompt).toContain("smallest coherent change");
  expect(prompt).toContain(
    "Verify repository commands and external contracts before prescribing them",
  );
  expect(prompt).toContain("highest existing stable test seam proving acceptance");
  expect(prompt).toContain("distinct invariant or failure mode unobservable there");
  expect(prompt).toContain("changes an executor decision");
  expect(prompt).toContain("Generic planning templates are optional");
  expect(prompt).toContain("routine diff inspection");
  expect(prompt).toContain("exact files or symbols establish ownership");
  expect(prompt).toContain(
    "every change and test traces to acceptance, an invariant, or a verified risk",
  );
  expect(prompt).toContain("no material implementation choice remains unresolved");
  expect(prompt).toContain(
    "Prune repeated criteria, covered commands, duplicated context, and empty optional sections",
  );
  expect(prompt).toContain("Do not include secrets");
  expect(prompt).not.toContain("Conditional content:");
  expect(prompt).not.toContain("separate test matrices");
  expect(prompt).not.toContain("maintenance notes");
});

test("factory planner states cross-cutting behavior only when it materially changes", () => {
  const prompt = renderFactoryPlanningInitialPrompt({
    workItemJson: '{"title":"Change failure routing"}',
    draftPath: "/tmp/draft.md",
    currentDate: "2026-07-12",
  });

  expect(prompt).toContain(
    "When work materially changes failure handling, state or data flow, privacy, or security behavior, state the required behavior beside the affected change. Omit this detail when that behavior is unchanged or irrelevant.",
  );
});

test("factory planner names behavior lifecycle only when work changes an existing path", () => {
  const prompt = renderFactoryPlanningInitialPrompt({
    workItemJson: '{"title":"Replace legacy routing"}',
    draftPath: "/tmp/draft.md",
    currentDate: "2026-07-12",
  });

  expect(prompt).toContain(
    "replaces, redirects, splits, deprecates, or removes an existing behavior",
  );
  expect(prompt).toContain("post-change owner, exact removals and cutover order");
  expect(prompt).toContain("required compatibility beside the change");
  expect(prompt).toContain("Omit this lifecycle detail for ordinary additive work");
});

test("factory revision receives blockers and requires pruning", () => {
  const prompt = renderFactoryPlanningRevisionPrompt({
    draftPath: "/tmp/draft.md",
    currentDate: "2026-07-11",
    reviewFindingsJson: '[{"id":"spec-002","must_fix":true}]',
    operatorResponse: "Keep the accepted publication boundary.",
  });

  expect(prompt).toContain("latest blocking review findings");
  expect(prompt).toContain("Advisory findings remain in review evidence");
  expect(prompt).toContain("every supplied must_fix finding requires a decision");
  expect(prompt).toContain("latest blocking finding id");
  expect(prompt).toContain("remove obsolete, duplicated, speculative, or superseded material");
  expect(prompt).toContain('"spec-002"');
  expect(prompt).toContain("Keep the accepted publication boundary.");
});
