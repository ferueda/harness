import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";

const BIN = join(process.cwd(), "bin/harness.ts");

test("implementation item-file direct dry-run writes artifacts without lifecycle state", () => {
  const workspace = createWorkspace();
  const itemFile = writeWorkItem(workspace, directWorkItem());

  const result = runHarness([
    "factory",
    "implementation",
    "run",
    "--workspace",
    workspace,
    "--item-file",
    itemFile,
    "--dry-run",
  ]);

  expect(result.status).toBe(0);
  const output = parseStdout(result);
  expect(output).toMatchObject({
    workflow: "factory-implementation",
    status: "dry_run",
    mode: "direct",
    implementerAgent: { name: "cursor", model: "composer-2.5" },
  });
  expect(output.summaryPath).toBe(join(output.runDir, "summary.md"));
  expect(output.metaPath).toBe(join(output.runDir, "meta.json"));
  expect(existsSync(join(output.runDir, "implementation/prompt.md"))).toBe(true);
  expect(existsSync(join(output.runDir, "implementation/change-review-handoff.md"))).toBe(true);
  expect(existsSync(join(workspace, ".harness/factory"))).toBe(false);
  expect(parseFactoryRunStartedProgress(result.stderr)).toEqual({
    harnessFactory: "run-started",
    station: "implementation",
    runId: output.runId,
    runDir: output.runDir,
    workspace,
  });
  expect(existsSync(join(output.runDir, "events.jsonl"))).toBe(false);
});

test("implementation item-file planned dry-run writes plan reference", () => {
  const workspace = createWorkspace();
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(join(workspace, "dev/plans/FER-47.md"), "# Plan\n", "utf8");
  const itemFile = writeWorkItem(workspace, plannedWorkItem());

  const result = runHarness([
    "factory",
    "implementation",
    "run",
    "--workspace",
    workspace,
    "--item-file",
    itemFile,
    "--dry-run",
  ]);

  expect(result.status).toBe(0);
  const output = parseStdout(result);
  expect(output).toMatchObject({
    workflow: "factory-implementation",
    status: "dry_run",
    mode: "planned",
    artifacts: { planRef: "context/plan-ref.json" },
  });
  expect(readJson(join(output.runDir, "context/plan-ref.json"))).toMatchObject({
    approvedPlanPath: "dev/plans/FER-47.md",
    approvedPlanCommit: "abc1234",
  });
});

test("implementation run requires dry-run before role resolution", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-implementation-cli-"));
  const result = runHarness([
    "factory",
    "implementation",
    "run",
    "--workspace",
    workspace,
    "--item-file",
    "missing.json",
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Factory implementation station only supports --dry-run in v1");
});

test("implementation run validates exactly one input source", () => {
  const missing = runHarness(["factory", "implementation", "run", "--dry-run"]);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("one of --item-file or --linear-issue is required");

  const both = runHarness([
    "factory",
    "implementation",
    "run",
    "--item-file",
    "item.json",
    "--linear-issue",
    "FER-47",
    "--dry-run",
  ]);
  expect(both.status).not.toBe(0);
  expect(both.stderr).toContain("--item-file and --linear-issue are mutually exclusive");
});

test("implementation run fails closed for invalid readiness", () => {
  const workspace = createWorkspace();
  const itemFile = writeWorkItem(workspace, {
    ...directWorkItem(),
    metadata: { factoryStage: "ready-to-implement" },
  });

  const result = runHarness([
    "factory",
    "implementation",
    "run",
    "--workspace",
    workspace,
    "--item-file",
    itemFile,
    "--dry-run",
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Factory work item is not ready for implementation");
});

test("implementation run includes configured implementer role in output and meta", () => {
  const workspace = createWorkspace({
    factory: {
      implementation: {
        roles: {
          implementer: { agent: "codex", model: "gpt-impl", modelReasoningEffort: "high" },
        },
      },
    },
  });
  const itemFile = writeWorkItem(workspace, directWorkItem());

  const result = runHarness([
    "factory",
    "implementation",
    "run",
    "--workspace",
    workspace,
    "--item-file",
    itemFile,
    "--dry-run",
  ]);

  expect(result.status).toBe(0);
  const output = parseStdout(result);
  expect(output.implementerAgent).toMatchObject({
    name: "codex",
    model: "gpt-impl",
    modelReasoningEffort: "high",
  });
  expect(readJson(join(output.runDir, "meta.json"))).toMatchObject({
    implementerAgent: output.implementerAgent,
  });
});

function createWorkspace(config: Record<string, unknown> = {}): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-implementation-cli-"));
  writeFileSync(
    join(workspace, "harness.json"),
    `${JSON.stringify({ defaultAgent: "cursor", ...config }, null, 2)}\n`,
    "utf8",
  );
  return workspace;
}

function writeWorkItem(workspace: string, workItem: FactoryWorkItem): string {
  const itemPath = join(workspace, "work-item.json");
  writeFileSync(itemPath, `${JSON.stringify(workItem, null, 2)}\n`, "utf8");
  return itemPath;
}

function directWorkItem(): FactoryWorkItem {
  return {
    id: "local-1",
    source: "file",
    title: "Direct work",
    body: "Implement direct request.",
    labels: ["factory"],
    url: "https://example.com/work/local-1",
    metadata: {
      tracker: { source: "manual", id: "local-1", url: "https://example.com/work/local-1" },
      factoryStage: "ready-to-implement",
      factoryRoute: "ready-to-implement",
      factoryNextAction: "implement-directly",
    },
  };
}

function plannedWorkItem(): FactoryWorkItem {
  return {
    ...directWorkItem(),
    metadata: {
      tracker: { source: "linear", id: "FER-47" },
      factoryStage: "plan-approved",
      approvedPlanPath: "dev/plans/FER-47.md",
      approvedPlanCommit: "abc1234",
    },
  };
}

function runHarness(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "test-key" },
  });
}

function parseStdout(result: ReturnType<typeof runHarness>): Record<string, any> {
  return JSON.parse(result.stdout) as Record<string, any>;
}

function parseFactoryRunStartedProgress(stderr: string) {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as { harnessFactory?: string };
        return parsed.harnessFactory === "run-started" ? [parsed] : [];
      } catch {
        return [];
      }
    });
  expect(lines).toHaveLength(1);
  return lines[0];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
