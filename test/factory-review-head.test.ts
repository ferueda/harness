import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  createFactoryRemediationCandidate,
  createFactoryReviewHead,
} from "../lib/factory-review-head.ts";

test("createFactoryReviewHead succeeds with populated ignored .harness and omits it from the review tree", () => {
  const workspace = createGitWorkspace({ ignoreHarness: true });
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

test("createFactoryReviewHead fails closed when .harness is not ignored", () => {
  const workspace = createGitWorkspace({ ignoreHarness: false });
  const runDir = join(workspace, ".harness", "runs", "factory", "run-fer-56");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "marker.txt"), "factory run artifact\n", "utf8");
  writeFileSync(join(workspace, "tracked.txt"), "edited for review head\n", "utf8");

  const reviewBase = git(workspace, ["rev-parse", "HEAD"]).trim();
  expect(() =>
    createFactoryReviewHead({
      workspace,
      runDir,
      runId: "run-fer-56-unignored",
      reviewBase,
    }),
  ).toThrow(/must not include \.harness\//);

  const refs = git(workspace, ["for-each-ref", "--format=%(refname)", "refs/harness"]).trim();
  expect(refs).toBe("");
});

test("candidate materialization removes a ref when post-ref evidence generation fails", () => {
  const workspace = createGitWorkspace({ ignoreHarness: true });
  const runDir = join(workspace, ".harness", "runs", "factory", "run-fer-56");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(workspace, "tracked.txt"), "edited for review head\n", "utf8");
  const parent = git(workspace, ["rev-parse", "HEAD"]).trim();

  expect(() =>
    createFactoryRemediationCandidate({
      workspace,
      runDir,
      implementationRunId: "run-fer-56",
      candidateVersion: 1,
      priorCandidate: {
        ref: "HEAD",
        commit: parent,
        tree: git(workspace, ["rev-parse", "HEAD^{tree}"]).trim(),
      },
      originalReviewBase: "missing-review-base",
    }),
  ).toThrow();

  expect(git(workspace, ["for-each-ref", "--format=%(refname)", "refs/harness"]).trim()).toBe("");
});

function createGitWorkspace(options: { ignoreHarness: boolean }): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-review-head-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspace,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "tracked.txt"), "tracked content\n", "utf8");
  const toAdd = ["tracked.txt"];
  if (options.ignoreHarness) {
    writeFileSync(join(workspace, ".gitignore"), ".harness/\n", "utf8");
    toAdd.push(".gitignore");
  }
  execFileSync("git", ["add", ...toAdd], { cwd: workspace, stdio: "ignore" });
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
