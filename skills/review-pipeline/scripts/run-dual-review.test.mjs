import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { aggregateVerdict, renderSummary } from "./lib/aggregate.mjs";
import {
  buildDiffSection,
  buildRunId,
  fillTemplate,
  prepareGitScope,
  renderPrompt,
} from "./lib/context.mjs";

test("aggregateVerdict prefers blocked over needs_changes", () => {
  assert.equal(
    aggregateVerdict({ verdict: "blocked" }, { verdict: "pass" }),
    "blocked",
  );
  assert.equal(
    aggregateVerdict({ verdict: "pass" }, { verdict: "needs_changes" }),
    "needs_changes",
  );
});

test("aggregateVerdict treats must_fix findings as needs_changes", () => {
  assert.equal(
    aggregateVerdict(
      { verdict: "pass", findings: [{ must_fix: true }] },
      { verdict: "pass", findings: [] },
    ),
    "needs_changes",
  );
});

test("aggregateVerdict passes only when both reviewers pass", () => {
  assert.equal(
    aggregateVerdict({ verdict: "pass", findings: [] }, { verdict: "pass", findings: [] }),
    "pass",
  );
});

test("fillTemplate replaces placeholders", () => {
  const out = fillTemplate("{{A}}-{{B}}", { A: "x", B: "y" });
  assert.equal(out, "x-y");
});

test("buildDiffSection writes patch and inlines small diffs", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dual-review-workspace-"));
  const runDir = join(workspace, "run");
  const diff = "diff --git a/a.txt b/a.txt\n+hello\n";
  const section = buildDiffSection(diff, runDir, workspace);
  assert.match(section, /```diff/);
  assert.match(readFileSync(join(runDir, "context/diff.patch"), "utf8"), /hello/);
});

test("prepareGitScope returns diff between merge-base and head", () => {
  const repo = mkdtempSync(join(tmpdir(), "dual-review-repo-"));
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "base\n", "utf8");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
  const baseRef = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "feature\n", "utf8");
  execFileSync("git", ["commit", "-am", "feature"], { cwd: repo });

  const scope = prepareGitScope(repo, { baseRef, headRef: "HEAD" });
  assert.match(scope.diff, /feature/);
  assert.ok(scope.mergeBase);
  assert.ok(scope.headSha);
});

test("renderSummary includes aggregate verdict", () => {
  const summary = renderSummary({
    runId: "run-1",
    workspace: "/tmp/app",
    scope: { baseRef: "main", headRef: "feature", mergeBase: "abc", headSha: "def" },
    implReview: { verdict: "pass", summary: "ok", findings: [] },
    qualityReview: { verdict: "needs_changes", summary: "nits", findings: [] },
    verdict: "needs_changes",
    startedAt: "2025-06-21T00:00:00.000Z",
    durationMs: 1200,
  });
  assert.match(summary, /needs_changes/);
  assert.match(summary, /Implementation review/);
});

test("buildRunId is stable length with timestamp prefix", () => {
  const id = buildRunId(new Date("2025-06-21T12:34:56.000Z"));
  assert.match(id, /^20250621-123456-[0-9a-f]{6}$/);
});

test("renderPrompt reads template file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dual-review-prompt-"));
  const templatePath = join(dir, "t.md");
  writeFileSync(templatePath, "Hello {{NAME}}", "utf8");
  assert.equal(renderPrompt(templatePath, { NAME: "world" }), "Hello world");
});
