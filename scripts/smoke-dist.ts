#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = resolveSmokeBin();

function resolveSmokeBin(): string {
  const override = process.env.HARNESS_SMOKE_BIN;
  if (!override) return resolve(ROOT, "dist/bin/harness.js");
  return isAbsolute(override) ? override : resolve(ROOT, override);
}

function runHarness(args: string[]): string {
  if (!existsSync(BIN)) {
    throw new Error(`Built harness CLI not found: ${BIN}`);
  }

  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `harness ${args.join(" ")} failed with exit ${result.status ?? 1}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

runHarness(["--help"]);

const dryRunOutput = runHarness([
  "run",
  "review",
  "--workspace",
  ROOT,
  "--base",
  "HEAD",
  "--head",
  "HEAD",
  "--dry-run",
]);

const dryRun = JSON.parse(dryRunOutput) as {
  status?: unknown;
  runDir?: unknown;
  prompts?: { implementation?: unknown; quality?: unknown };
};

if (dryRun.status !== "dry_run") {
  throw new Error(`Expected dry_run status, got ${String(dryRun.status)}`);
}

if (typeof dryRun.runDir !== "string") {
  throw new Error("Expected dry-run output to include runDir");
}

if (
  typeof dryRun.prompts?.implementation !== "string" ||
  typeof dryRun.prompts?.quality !== "string"
) {
  throw new Error("Expected dry-run output to include implementation and quality prompt paths");
}

const fullDryRunOutput = runHarness([
  "run",
  "review-full",
  "--workspace",
  ROOT,
  "--base",
  "HEAD",
  "--head",
  "HEAD",
  "--dry-run",
]);

const fullDryRun = JSON.parse(fullDryRunOutput) as {
  status?: unknown;
  prompts?: { implementation?: unknown; quality?: unknown; simplify?: unknown };
};

if (fullDryRun.status !== "dry_run") {
  throw new Error(`Expected review-full dry_run status, got ${String(fullDryRun.status)}`);
}

if (
  typeof fullDryRun.prompts?.implementation !== "string" ||
  typeof fullDryRun.prompts?.quality !== "string" ||
  typeof fullDryRun.prompts?.simplify !== "string"
) {
  throw new Error("Expected review-full dry-run output to include all prompt paths");
}
