import { expect, test } from "vitest";
import type { FactoryImplementationInput } from "../lib/factory-implementation-input.ts";
import { renderFactoryImplementationChangeReviewHandoff } from "../lib/prompts/factory-implementation.ts";

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
