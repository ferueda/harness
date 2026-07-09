import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createFactoryReviewHead } from "../lib/factory-review-head.ts";

test("createFactoryReviewHead succeeds with populated ignored .harness and omits it from the review tree", () => {
  const workspace = createGitWorkspaceWithIgnoredHarness();
  const runDir = join(workspace, ".harness", "runs", "factory", "run-fer-56");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "marker.txt"), "factory run artifact\n", "utf8");
  writeFileSync(join(workspace, "tracked.txt"), "edited for review head\n", "utf8");

  const reviewBase = git(workspace, ["rev-parse", "HEAD"]).trim();
  const result = createFactoryReviewHead({
    workspace,
    runDir,
    runId: "run-fer-56",
    reviewBase,
  });

  expect(result.reviewCommitSha).toMatch(/^[0-9a-f]{40}$/);
  expect(result.diffPatch).toContain("edited for review head");

  const treePaths = git(workspace, ["ls-tree", "-r", "--name-only", result.reviewCommitSha])
    .trim()
    .split("\n")
    .filter(Boolean);
  expect(treePaths).toContain("tracked.txt");
  expect(treePaths.some((path) => path === ".harness" || path.startsWith(".harness/"))).toBe(false);
});

function createGitWorkspaceWithIgnoredHarness(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-review-head-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspace,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, ".gitignore"), ".harness/\n", "utf8");
  writeFileSync(join(workspace, "tracked.txt"), "tracked content\n", "utf8");
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
