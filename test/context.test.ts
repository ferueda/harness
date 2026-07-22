import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  buildDiffRef,
  buildInlinedHandoffSection,
  buildPlanRef,
  writeRunContext,
} from "../lib/review/run-context.ts";
test("buildDiffRef writes diff and returns only a file reference", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const runDir = join(workspace, ".harness/runs/reviews/run-1");
  const diff = "diff --git a/a.txt b/a.txt\n+hello\n";
  const ref = buildDiffRef(diff, runDir, workspace);
  expect(ref).toBe("Diff file: `.harness/runs/reviews/run-1/context/diff.patch`");
  expect(readFileSync(join(runDir, "context/diff.patch"), "utf8")).toBe(diff);
  expect(ref).not.toMatch(/hello/);
  expect(ref).not.toMatch(/First 200 lines/);
});
test("writeRunContext copies plan and handoff artifacts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const runDir = join(workspace, ".harness/runs/reviews/run-1");
  writeFileSync(join(workspace, "plan.md"), "# Plan\n", "utf8");
  writeFileSync(join(workspace, "handoff.md"), "# Handoff\n", "utf8");
  const artifacts = writeRunContext({
    workspace,
    runDir,
    planPath: "plan.md",
    handoffPath: "handoff.md",
  });
  expect(existsSync(join(runDir, "context/plan.md"))).toBe(true);
  expect(existsSync(join(runDir, "context/handoff.md"))).toBe(true);
  expect(buildPlanRef(artifacts.plan, workspace)).toBe(
    "Plan file: `.harness/runs/reviews/run-1/context/plan.md`",
  );
});
test("buildInlinedHandoffSection inlines handoff content when present", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const runDir = join(workspace, ".harness/runs/reviews/run-1");
  const artifacts = writeRunContext({
    workspace,
    runDir,
    handoffText: "# Caller handoff\n\nReview this scope.\n",
  });

  expect(buildInlinedHandoffSection(artifacts.handoff)).toBe(
    "## Handoff\n\n# Caller handoff\n\nReview this scope.",
  );
});
test("buildInlinedHandoffSection returns empty string when handoff is absent", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const runDir = join(workspace, ".harness/runs/reviews/run-1");
  const artifacts = writeRunContext({ workspace, runDir });

  expect(buildInlinedHandoffSection(artifacts.handoff)).toBe("");
});
test("buildInlinedHandoffSection surfaces missing requested handoff path", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const runDir = join(workspace, ".harness/runs/reviews/run-1");
  const artifacts = writeRunContext({
    workspace,
    runDir,
    handoffPath: "missing-handoff.md",
  });

  expect(buildInlinedHandoffSection(artifacts.handoff)).toBe(
    "## Handoff\n\n_Handoff file not found: `missing-handoff.md`_",
  );
});
test("writeRunContext rejects conflicting handoff inputs", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const runDir = join(workspace, ".harness/runs/reviews/run-1");
  writeFileSync(join(workspace, "handoff.md"), "# Handoff\n", "utf8");

  expect(() =>
    writeRunContext({
      workspace,
      runDir,
      handoffPath: "handoff.md",
      handoffText: "# Inline handoff\n",
    }),
  ).toThrow(/Use only one handoff input/);
});
test("writeRunContext rejects blank handoff text", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const runDir = join(workspace, ".harness/runs/reviews/run-1");

  expect(() =>
    writeRunContext({
      workspace,
      runDir,
      handoffText: " \n\t",
    }),
  ).toThrow(/Handoff text must not be empty/);
});
