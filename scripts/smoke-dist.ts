#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = resolveSmokeBin();
const EXPECTED_RECOMMENDED_COMMAND = ".harness/bin/harness run change-review";

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

function runHarnessAllowFailure(args: string[]) {
  if (!existsSync(BIN)) {
    throw new Error(`Built harness CLI not found: ${BIN}`);
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

runHarness(["--help"]);
const factoryHelp = runHarness(["run", "factory-triage", "--help"]);
if (!factoryHelp.includes("harness run factory-triage")) {
  throw new Error("Expected factory-triage help to include command usage");
}
if (!factoryHelp.includes("--item-file <path>")) {
  throw new Error("Expected factory-triage help to include --item-file");
}
const planReviewHelp = runHarness(["run", "plan-review", "--help"]);
if (!planReviewHelp.includes("harness run plan-review")) {
  throw new Error("Expected plan-review help to include command usage");
}
if (!planReviewHelp.includes("--plan <path>")) {
  throw new Error("Expected plan-review help to include --plan");
}
const factoryStatusHelp = runHarness(["factory", "status", "--help"]);
if (!factoryStatusHelp.includes("harness factory status")) {
  throw new Error("Expected factory status help to include command usage");
}
const factoryLinearHelp = runHarness(["factory", "linear", "--help"]);
if (!factoryLinearHelp.includes("harness factory linear")) {
  throw new Error("Expected factory linear help to include command usage");
}
if (!factoryLinearHelp.includes("list")) {
  throw new Error("Expected factory linear help to include list command");
}
const factoryLinearListHelp = runHarness(["factory", "linear", "list", "--help"]);
if (!factoryLinearListHelp.includes("harness factory linear list")) {
  throw new Error("Expected factory linear list help to include command usage");
}
if (!factoryLinearListHelp.includes("--status")) {
  throw new Error("Expected factory linear list help to include --status");
}
const factoryLinearFetchHelp = runHarness(["factory", "linear", "fetch", "--help"]);
if (!factoryLinearFetchHelp.includes("harness factory linear fetch")) {
  throw new Error("Expected factory linear fetch help to include command usage");
}
if (!factoryLinearFetchHelp.includes("TEAM-123")) {
  throw new Error("Expected factory linear fetch help to include issue identifier guidance");
}
const factoryTriageStationHelp = runHarness(["factory", "triage", "--help"]);
if (!factoryTriageStationHelp.includes("harness factory triage")) {
  throw new Error("Expected factory triage help to include command usage");
}
if (!factoryTriageStationHelp.includes("--item-file <path>")) {
  throw new Error("Expected factory triage help to include --item-file");
}
if (!factoryTriageStationHelp.includes("--linear-issue <issue>")) {
  throw new Error("Expected factory triage help to include --linear-issue");
}
if (!factoryTriageStationHelp.includes("--apply")) {
  throw new Error("Expected factory triage help to include --apply");
}
if (!factoryTriageStationHelp.includes("--dry-run")) {
  throw new Error("Expected factory triage help to include --dry-run");
}
const factoryPlanningStationHelp = runHarness(["factory", "planning", "--help"]);
if (!factoryPlanningStationHelp.includes("harness factory planning")) {
  throw new Error("Expected factory planning help to include command usage");
}
if (!factoryPlanningStationHelp.includes("publish")) {
  throw new Error("Expected factory planning help to include publish subcommand");
}
if (!factoryPlanningStationHelp.includes("mark-plan-merged")) {
  throw new Error("Expected factory planning help to include mark-plan-merged subcommand");
}
const factoryPlanningRunHelp = runHarness(["factory", "planning", "run", "--help"]);
if (!factoryPlanningRunHelp.includes("harness factory planning run")) {
  throw new Error("Expected factory planning run help to include command usage");
}
if (!factoryPlanningRunHelp.includes("--item-file <path>")) {
  throw new Error("Expected factory planning help to include --item-file");
}
if (!factoryPlanningRunHelp.includes("--linear-issue <issue>")) {
  throw new Error("Expected factory planning help to include --linear-issue");
}
if (!factoryPlanningRunHelp.includes("--output-plan <path>")) {
  throw new Error("Expected factory planning help to include --output-plan");
}
if (!factoryPlanningRunHelp.includes("--apply")) {
  throw new Error("Expected factory planning help to include --apply");
}
if (!factoryPlanningRunHelp.includes("--dry-run")) {
  throw new Error("Expected factory planning help to include --dry-run");
}
const factoryPlanningPublishHelp = runHarness(["factory", "planning", "publish", "--help"]);
if (!factoryPlanningPublishHelp.includes("harness factory planning publish")) {
  throw new Error("Expected factory planning publish help to include command usage");
}
const factoryPlanningMergedHelp = runHarness(["factory", "planning", "mark-plan-merged", "--help"]);
if (!factoryPlanningMergedHelp.includes("harness factory planning mark-plan-merged")) {
  throw new Error("Expected factory planning mark-plan-merged help to include command usage");
}
const factoryDispatchHelp = runHarnessAllowFailure(["factory", "dispatch", "--help"]);
const factoryDispatchHelpText = `${factoryDispatchHelp.stderr}\n${factoryDispatchHelp.stdout}`;
if (/factory dispatch/i.test(factoryDispatchHelpText)) {
  throw new Error("Expected factory dispatch to be absent from factory help");
}
const factoryDispatch = runHarnessAllowFailure(["factory", "dispatch"]);
const factoryDispatchText = `${factoryDispatch.stderr}\n${factoryDispatch.stdout}`;
if (factoryDispatch.status === 0 || !/unknown command.*dispatch/i.test(factoryDispatchText)) {
  throw new Error("Expected removed factory dispatch command to report unknown command");
}

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
  "change-review",
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
  workflow?: unknown;
  executedSteps?: unknown;
  partial?: unknown;
  prompts?: { implementation?: unknown; quality?: unknown; simplify?: unknown };
};

if (dryRun.status !== "dry_run") {
  throw new Error(`Expected dry_run status, got ${String(dryRun.status)}`);
}

if (typeof dryRun.runDir !== "string") {
  throw new Error("Expected dry-run output to include runDir");
}

if (dryRun.workflow !== "change-review") {
  throw new Error(`Expected change-review workflow metadata, got ${String(dryRun.workflow)}`);
}

if (
  !Array.isArray(dryRun.executedSteps) ||
  dryRun.executedSteps.join(",") !== "implementation,quality,simplify" ||
  dryRun.partial !== false
) {
  throw new Error("Expected default dry-run output to include full step metadata");
}

if (
  typeof dryRun.prompts?.implementation !== "string" ||
  typeof dryRun.prompts?.quality !== "string" ||
  typeof dryRun.prompts?.simplify !== "string"
) {
  throw new Error("Expected dry-run output to include all prompt paths");
}

const selectedDryRunOutput = runHarness([
  "run",
  "change-review",
  "--workspace",
  ROOT,
  "--base",
  "HEAD",
  "--head",
  "HEAD",
  "--steps",
  "implementation",
  "--dry-run",
]);

const selectedDryRun = JSON.parse(selectedDryRunOutput) as {
  status?: unknown;
  executedSteps?: unknown;
  omittedSteps?: unknown;
  partial?: unknown;
  prompts?: { implementation?: unknown; quality?: unknown; simplify?: unknown };
};

if (selectedDryRun.status !== "dry_run") {
  throw new Error(`Expected selected-step dry_run status, got ${String(selectedDryRun.status)}`);
}

if (
  !Array.isArray(selectedDryRun.executedSteps) ||
  selectedDryRun.executedSteps.join(",") !== "implementation" ||
  !Array.isArray(selectedDryRun.omittedSteps) ||
  selectedDryRun.omittedSteps.join(",") !== "quality,simplify" ||
  selectedDryRun.partial !== true ||
  typeof selectedDryRun.prompts?.implementation !== "string" ||
  selectedDryRun.prompts?.quality !== undefined ||
  selectedDryRun.prompts?.simplify !== undefined
) {
  throw new Error("Expected selected-step dry-run output to include only implementation prompt");
}

const handoffDryRunOutput = runHarness(
  [
    "run",
    "change-review",
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
