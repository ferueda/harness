import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  cleanupOrphanedRunDir,
  createWorkflowContext,
  resolveSkillPath,
} from "../lib/workflow-context.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function createGitWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: workspace });
  writeFileSync(join(workspace, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

test("cleanupOrphanedRunDir removes incomplete run directories", () => {
  const runDir = mkdtempSync(join(tmpdir(), "harness-orphaned-run-"));
  mkdirSync(join(runDir, "context"));
  expect(cleanupOrphanedRunDir(runDir)).toBe(true);
  expect(existsSync(runDir)).toBe(false);
});
test("cleanupOrphanedRunDir preserves runs with metadata", () => {
  const runDir = mkdtempSync(join(tmpdir(), "harness-run-"));
  writeFileSync(join(runDir, "meta.json"), "{}\n", "utf8");
  expect(cleanupOrphanedRunDir(runDir)).toBe(false);
  expect(existsSync(runDir)).toBe(true);
});
test("resolveSkillPath prefers workspace agent skills over bundled skills", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const skillPath = join(workspace, ".agents/skills/review-implementation/SKILL.md");
  mkdirSync(join(workspace, ".agents/skills/review-implementation"), { recursive: true });
  writeFileSync(skillPath, "# Workspace review implementation\n", "utf8");
  expect(resolveSkillPath("review-implementation", workspace)).toBe(skillPath);
});
test("resolveSkillPath falls back to user agent skills before bundled skills", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const homeDir = mkdtempSync(join(tmpdir(), "harness-home-"));
  const skillPath = join(homeDir, ".agents/skills/review-implementation/SKILL.md");
  mkdirSync(join(homeDir, ".agents/skills/review-implementation"), { recursive: true });
  writeFileSync(skillPath, "# User review implementation\n", "utf8");
  expect(resolveSkillPath("review-implementation", workspace, homeDir)).toBe(skillPath);
});
test("resolveSkillPath falls back to bundled workflow skills", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const devSkillPath = join(workspace, ".agents/skills/simplify/SKILL.md");
  mkdirSync(join(workspace, ".agents/skills/simplify"), { recursive: true });
  writeFileSync(devSkillPath, "# Dev simplify\n", "utf8");
  const skillPath = resolveSkillPath("simplify-review", workspace, workspace);
  expect(skillPath).toBe(join(REPO_ROOT, "skills/simplify-review/SKILL.md"));
  expect(readFileSync(skillPath, "utf8")).toContain("name: simplify-review");
});
test("exportFailed writes metadata and summary with no successful reviews", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContext({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    maxRuntimeMs: 1_000,
  });

  const meta = ctx.exportFailed({
    title: "Review Summary",
    reviews: [],
    failedReviews: [
      { key: "implementation", stage: "implementation", error: "implementation failed" },
    ],
  });

  expect(meta.status).toBe("failed");
  expect("verdict" in meta).toBe(false);
  expect(meta.reviews).toEqual({});
  expect("failedReviews" in meta ? meta.failedReviews : undefined).toEqual([
    { key: "implementation", stage: "implementation", error: "implementation failed" },
  ]);
  expect(readFileSync(join(ctx.runDir, "meta.json"), "utf8")).toContain('"status": "failed"');
  const summary = readFileSync(join(ctx.runDir, "summary.md"), "utf8");
  expect(summary).toMatch(/## Failed reviewers/);
  expect(summary).toMatch(/implementation failed/);
});
