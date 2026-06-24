#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = resolveSmokeBin();
const EXPECTED_RECOMMENDED_COMMAND = ".harness/bin/harness run review";

function resolveSmokeBin(): string {
  const override = process.env.HARNESS_SMOKE_BIN;
  if (!override) return resolve(ROOT, "dist/bin/harness.js");
  return isAbsolute(override) ? override : resolve(ROOT, override);
}

function runHarness(args: string[], input?: string): string {
  if (!existsSync(BIN)) {
    throw new Error(`Built harness CLI not found: ${BIN}`);
  }

  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    input,
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

const initWorkspace = mkdtempSync(join(tmpdir(), "harness-smoke-init-"));
const initOutput = runHarness(["init", "--workspace", initWorkspace]);
const init = JSON.parse(initOutput) as {
  recommendedCommand?: unknown;
  shimPath?: unknown;
  shimUpdated?: unknown;
};

if (typeof init.shimPath !== "string") {
  throw new Error("Expected init output to include shimPath");
}

if (init.shimUpdated !== true) {
  throw new Error(`Expected init to update shim, got ${String(init.shimUpdated)}`);
}

if (init.recommendedCommand !== EXPECTED_RECOMMENDED_COMMAND) {
  throw new Error(`Unexpected init recommendedCommand: ${String(init.recommendedCommand)}`);
}

const shimContent = readFileSync(init.shimPath, "utf8");
if (!shimContent.includes(BIN)) {
  throw new Error("Expected init shim to point at built harness CLI");
}

const shimHelp = spawnSync(init.shimPath, ["--help"], {
  cwd: initWorkspace,
  encoding: "utf8",
});
if (shimHelp.status !== 0 || !shimHelp.stdout.includes("Usage: harness")) {
  throw new Error("Expected init shim to run harness help");
}
rmSync(initWorkspace, { recursive: true, force: true });

const installWorkspace = mkdtempSync(join(tmpdir(), "harness-smoke-install-"));
const installDryRunOutput = runHarness([
  "skills",
  "install",
  "change-review-workflow",
  "--workspace",
  installWorkspace,
  "--dry-run",
]);

const installDryRun = JSON.parse(installDryRunOutput) as {
  skill?: unknown;
  sourcePath?: unknown;
  status?: unknown;
};

if (installDryRun.skill !== "change-review-workflow") {
  throw new Error(`Expected change-review-workflow skill, got ${String(installDryRun.skill)}`);
}

if (typeof installDryRun.sourcePath !== "string") {
  throw new Error("Expected skills install dry-run output to include sourcePath");
}

if (!normalize(installDryRun.sourcePath).endsWith(join("skills", "change-review-workflow"))) {
  throw new Error(`Unexpected skills install sourcePath: ${installDryRun.sourcePath}`);
}

if (installDryRun.status !== "would_install") {
  throw new Error(`Expected skills install dry-run status, got ${String(installDryRun.status)}`);
}

const installOutput = runHarness([
  "skills",
  "install",
  "change-review-workflow",
  "--workspace",
  installWorkspace,
]);
const install = JSON.parse(installOutput) as {
  status?: unknown;
};

if (install.status !== "installed") {
  throw new Error(`Expected skills install status, got ${String(install.status)}`);
}

const installedSkill = readFileSync(
  join(installWorkspace, ".agents/skills/change-review-workflow/SKILL.md"),
  "utf8",
);
if (!installedSkill.includes("name: change-review-workflow")) {
  throw new Error("Expected skills install to materialize change-review-workflow skill");
}
rmSync(installWorkspace, { recursive: true, force: true });

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

const handoffDryRunOutput = runHarness(
  [
    "run",
    "review",
    "--workspace",
    ROOT,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--handoff-stdin",
    "--dry-run",
  ],
  "# Smoke handoff\n",
);
const handoffDryRun = JSON.parse(handoffDryRunOutput) as {
  runDir?: unknown;
  status?: unknown;
};

if (handoffDryRun.status !== "dry_run") {
  throw new Error(`Expected handoff dry_run status, got ${String(handoffDryRun.status)}`);
}

if (typeof handoffDryRun.runDir !== "string") {
  throw new Error("Expected handoff dry-run output to include runDir");
}

const handoffArtifact = readFileSync(join(handoffDryRun.runDir, "context", "handoff.md"), "utf8");
if (handoffArtifact !== "# Smoke handoff\n") {
  throw new Error("Expected handoff dry-run to materialize stdin handoff text");
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
