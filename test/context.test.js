import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildDiffSection,
  buildHandoffSection,
  buildPlanSection,
  writeRunContext,
} from "../lib/context.js";

test("buildDiffSection writes diff and returns only a file reference", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const runDir = join(workspace, ".harness/runs/reviews/run-1");
  const diff = "diff --git a/a.txt b/a.txt\n+hello\n";

  const section = buildDiffSection(diff, runDir, workspace);

  assert.equal(section, "Diff file: `.harness/runs/reviews/run-1/context/diff.patch`");
  assert.equal(readFileSync(join(runDir, "context/diff.patch"), "utf8"), diff);
  assert.doesNotMatch(section, /hello/);
  assert.doesNotMatch(section, /First 200 lines/);
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

  assert.equal(existsSync(join(runDir, "context/plan.md")), true);
  assert.equal(existsSync(join(runDir, "context/handoff.md")), true);
  assert.equal(
    buildPlanSection(artifacts.plan, workspace),
    "Plan file: `.harness/runs/reviews/run-1/context/plan.md`",
  );
  assert.equal(
    buildHandoffSection(artifacts.handoff, workspace),
    "Handoff file: `.harness/runs/reviews/run-1/context/handoff.md`",
  );
});
