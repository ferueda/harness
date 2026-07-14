#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const PLAN_MARKDOWN_PATTERN = /^dev\/plans\/.+\.md$/;

function requiredCommitSha(name: "BASE_SHA" | "HEAD_SHA"): string {
  const value = process.env[name];
  if (!value || !SHA_PATTERN.test(value)) {
    throw new Error(`${name} must be a full Git object ID`);
  }

  const result = spawnSync("git", ["cat-file", "-t", value], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.trim() !== "commit") {
    throw new Error(`${name} must resolve to a commit object`);
  }
  return value;
}

function changedPaths(baseSha: string, headSha: string): string[] {
  const result = spawnSync(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", baseSha, headSha, "--"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git diff exited with status ${result.status}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

function publish(planOnly: boolean): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(outputPath, `plan_only=${String(planOnly)}\n`, "utf8");
}

try {
  const paths = changedPaths(requiredCommitSha("BASE_SHA"), requiredCommitSha("HEAD_SHA"));
  publish(paths.length > 0 && paths.every((path) => PLAN_MARKDOWN_PATTERN.test(path)));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to classify changed paths: ${message}`);
  process.exitCode = 1;
}
