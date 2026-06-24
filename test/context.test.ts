import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  buildDiffSection,
  buildHandoffSection,
  buildPlanSection,
  writeRunContext,
} from "../lib/context.ts";
test("buildDiffSection writes diff and returns only a file reference", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const runDir = join(workspace, ".harness/runs/reviews/run-1");
  const diff = "diff --git a/a.txt b/a.txt\n+hello\n";
  const section = buildDiffSection(diff, runDir, workspace);
  expect(section).toBe("Diff file: `.harness/runs/reviews/run-1/context/diff.patch`");
  expect(readFileSync(join(runDir, "context/diff.patch"), "utf8")).toBe(diff);
  expect(section).not.toMatch(/hello/);
  expect(section).not.toMatch(/First 200 lines/);
});
test("writeRunContext copies plan and handoff and sections return file references", () => {
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
  expect(buildPlanSection(artifacts.plan, workspace)).toBe(
    "Plan file: `.harness/runs/reviews/run-1/context/plan.md`",
  );
  expect(buildHandoffSection(artifacts.handoff, workspace)).toBe(
    "Handoff file: `.harness/runs/reviews/run-1/context/handoff.md`",
  );
});
