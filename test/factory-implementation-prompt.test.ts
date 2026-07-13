import { expect, test } from "vitest";
import type { FactoryImplementationInput } from "../lib/factory-implementation-input.ts";
import {
  renderFactoryImplementationChangeReviewHandoff,
  renderFactoryImplementationPrompt,
} from "../lib/prompts/factory-implementation.ts";

const plannedInput = {
  mode: "planned",
  source: "item-file",
  workItem: {
    id: "github:example/repo#47",
    source: "github",
    title: "Replace legacy routing",
    body: "Follow the accepted cutover.",
    labels: ["factory"],
  },
  metadata: {},
  approvedPlanPath: "dev/plans/replace-legacy-routing.md",
  planPath: "/workspace/dev/plans/replace-legacy-routing.md",
  approvedPlanCommit: "abc1234",
} satisfies FactoryImplementationInput;

const directInput = {
  mode: "direct",
  source: "linear",
  workItem: {
    id: "linear:FER-47",
    source: "linear",
    title: "Add factory implementation",
    body: "Keep the review context.",
    labels: ["factory"],
  },
  metadata: {},
  sourceMaterial: {
    title: "Add factory implementation",
    body: "Keep   the review\ncontext.",
    labels: ["factory"],
    url: "https://linear.app/example/issue/FER-47",
    tracker: { source: "linear", id: "FER-47" },
  },
} satisfies FactoryImplementationInput;

function expectCompletionContract(prompt: string): void {
  expect(prompt).toContain("Success means the accepted outcome is complete");
  expect(prompt).toContain("relevant non-destructive repository validation has run");
  expect(prompt).toContain("unavailable validation is reported");
  expect(prompt).toContain("the final diff is reconciled against the accepted decisions");
  expect(prompt).toContain("a material conflict invalidates the approach");
  expect(prompt).toContain("completion requires material scope expansion");
  expect(prompt).toContain("stop and report the conflict or exact decision needed");
}

test("planned implementation reconciles the approved plan before editing", () => {
  const prompt = renderFactoryImplementationPrompt({
    implementationInput: plannedInput,
    implementerAgent: { name: "codex", model: "gpt-5.6-sol" },
  });

  expect(prompt).toContain("Repository invariants and documented project intent");
  expect(prompt).toContain("The approved plan at the absolute plan path");
  expect(prompt).not.toContain("The resolved source request under Direct Implementation");
  expect(prompt).toContain("Verified current repository facts as the implementation baseline");
  expect(prompt).toContain("Before editing, reconcile");
  expect(prompt).toContain("post-change ownership, removals, cutover order");
  expect(prompt).toContain("required compatibility");
  expectCompletionContract(prompt);
});

test("direct implementation keeps source context as task authority", () => {
  const prompt = renderFactoryImplementationPrompt({
    implementationInput: directInput,
    implementerAgent: { name: "codex", model: "gpt-5.6-sol" },
  });

  expect(prompt).toContain("The resolved source request under Direct Implementation");
  expect(prompt).not.toContain("The approved plan at the absolute plan path");
  expect(prompt).toContain("### Body");
  expect(prompt).toContain("Keep   the review\ncontext.");
  expect(prompt).toContain("Historical branches and superseded implementations are context only");
  expect(prompt).toContain("This station does not own tracker mutation");
  expectCompletionContract(prompt);
});

test("implementation review handoff preserves direct context without duplicating run evidence", () => {
  const handoff = renderFactoryImplementationChangeReviewHandoff({
    mode: "live",
    status: "implementation-complete",
    implementationInput: directInput,
    implementerAgent: { name: "codex", model: "gpt-5.6-sol" },
    artifacts: {
      diff: "implementation/diff.patch",
      rawOutput: "implementation/implementer.raw.json",
      workspaceStatus: "implementation/workspace-status.json",
      changeReviewHandoff: "implementation/change-review-handoff.md",
    },
    changedFiles: ["lib/example.ts"],
    provider: { session: { provider: "codex", id: "session-1" } },
    review: {
      reviewBase: "main",
      reviewHead: "refs/harness/review",
      reviewCommitSha: "abc1234",
    },
    warnings: {
      dirtyBefore: false,
      emptyPatchWithStatusChange: false,
      patchTruncated: false,
    },
  });

  expect(handoff).toContain("### Goal");
  expect(handoff).toContain("### Decisions and boundaries");
  expect(handoff).toContain("### Verification");
  expect(handoff).toContain("### Scrutiny");
  expect(handoff).toContain("- Source title: Add factory implementation");
  expect(handoff).toContain("- Source URL: https://linear.app/example/issue/FER-47");
  expect(handoff).toContain("- Task context: Keep the review context.");
  expect(handoff).not.toContain("**Status:** complete");
  expect(handoff).not.toContain("### Files changed");
  expect(handoff).not.toContain("### Implementation notes");
  expect(handoff).not.toContain("lib/example.ts");
  expect(handoff).not.toContain("implementation/diff.patch");
  expect(handoff).not.toContain("session-1");
  expect(handoff).not.toContain("- Tracker:");
});
