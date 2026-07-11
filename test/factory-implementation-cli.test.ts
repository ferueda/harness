import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { factoryImplementationCliOutput } from "../bin/factory-implementation-cli.ts";
import { runFactoryImplementationWithLifecycle } from "../bin/factory-commands.ts";
import {
  createFactoryImplementationRunContextForTest,
  type FactoryImplementationRunMeta,
} from "../lib/factory-implementation-run-context.ts";
import type { FactoryImplementationInput } from "../lib/factory-implementation-input.ts";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  factoryLifecycleStatePath,
  readFactoryLifecycleEvents,
} from "../lib/factory-lifecycle.ts";
import { resolveFactoryStore } from "../lib/factory-store.ts";
import { parseFactoryWorkItemMetadata, type FactoryWorkItem } from "../lib/factory-schemas.ts";
import { parseFactoryRunStartedProgress } from "./factory-run-started-test-helpers.ts";
import { runFactoryHarness } from "./factory-store-test-helpers.ts";

const BIN = join(process.cwd(), "bin/harness.ts");

test("implementation CLI output preserves an explicit failed Linear projection", () => {
  const workspace = createWorkspace();
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    workItem: directWorkItem(),
    implementationInput: directInput(directWorkItem()),
    implementerRole: { agent: "cursor" },
    dryRun: true,
  });
  const meta = ctx.export({ status: "dry_run" });

  expect(factoryImplementationCliOutput(meta)).not.toHaveProperty("linearApplied");
  expect(factoryImplementationCliOutput(meta, { linearApplied: false })).toMatchObject({
    linearApplied: false,
  });
});

test("implementation item-file direct dry-run rebuilds missing lifecycle projection in memory", () => {
  const workspace = createWorkspace();
  const workItem = directWorkItem();
  const itemFile = writeWorkItem(workspace, workItem);
  const storeRoot = mkdtempSync(join(tmpdir(), "harness-implementation-store-"));
  const store = resolveFactoryStore({ workspace, factoryStoreRoot: storeRoot, env: {} });
  const workItemKey = deriveFactoryWorkItemKey(workItem);
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: "2026-07-09T00:00:00.000Z",
      source: "harness",
      data: { source: "file", title: workItem.title },
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: "triage.completed:direct-run",
      type: "triage.completed",
      workItemKey,
      occurredAt: "2026-07-09T00:01:00.000Z",
      runId: "direct-run",
      source: "harness",
      data: {
        route: "ready-to-implement",
        nextAction: "implement-directly",
        rationale: "Ready for direct implementation.",
        routeArtifactPath: "factory-route.md",
        triageArtifactPath: "factory-triage.json",
      },
    },
  });
  rmSync(factoryLifecycleStatePath(store.factoryStateRoot, workItemKey));
  rmSync(join(store.factoryStateRoot, "locks"), { recursive: true, force: true });

  const result = runHarness([
    "factory",
    "implementation",
    "run",
    "--workspace",
    workspace,
    "--item-file",
    itemFile,
    "--dry-run",
    "--factory-store-root",
    storeRoot,
  ]);

  expect(result.status).toBe(0);
  const output = parseStdout(result);
  expect(output).toMatchObject({
    workflow: "factory-implementation",
    status: "dry_run",
    mode: "direct",
    implementerAgent: { name: "cursor", model: "grok-4.5" },
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
  expect(output.warnings).toEqual([
    expect.objectContaining({
      code: "durable-state-missing",
      factoryStateRoot: store.factoryStateRoot,
      workItemKey,
    }),
  ]);
  expect(existsSync(factoryLifecycleStatePath(store.factoryStateRoot, workItemKey))).toBe(false);
  expect(existsSync(join(store.factoryStateRoot, "locks"))).toBe(false);
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

test("implementation live without dry-run still validates input", () => {
  const missing = runHarness(["factory", "implementation", "run"]);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("one of --item-file or --linear-issue is required");
  expect(missing.stderr).not.toContain(
    "Factory implementation station only supports --dry-run in v1",
  );

  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-implementation-cli-"));
  const missingFile = runHarness([
    "factory",
    "implementation",
    "run",
    "--workspace",
    workspace,
    "--item-file",
    "missing.json",
  ]);
  expect(missingFile.status).not.toBe(0);
  expect(missingFile.stderr).not.toContain(
    "Factory implementation station only supports --dry-run in v1",
  );
  expect(missingFile.stderr.length).toBeGreaterThan(0);
});

test("implementation run help includes live options", () => {
  const result = runHarness(["factory", "implementation", "run", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("--max-runtime-ms");
  expect(result.stdout).toContain("--verbose");
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

test("runFactoryImplementationWithLifecycle dry-run skips lifecycle events", async () => {
  const workspace = createWorkspace();
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-factory-impl-lifecycle-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const workItem = directWorkItem();
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem,
    implementationInput: directInput(workItem),
    implementerRole: { agent: "cursor" },
    dryRun: true,
  });

  const meta = await runFactoryImplementationWithLifecycle({
    ctx,
    factoryStateRoot,
    async runImplementation(runCtx) {
      return runCtx.export({ status: "dry_run" });
    },
  });

  expect(meta.status).toBe("dry_run");
  expect(
    readFactoryLifecycleEvents({
      factoryStateRoot,
      workItemKey: deriveFactoryWorkItemKey(workItem),
    }),
  ).toHaveLength(0);
});

test("runFactoryImplementationWithLifecycle live success appends imported/started/completed", async () => {
  const workspace = createWorkspace();
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-factory-impl-lifecycle-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const workItem = directWorkItem();
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem,
    implementationInput: directInput(workItem),
    implementerRole: { agent: "cursor" },
    dryRun: false,
    maxRuntimeMs: 1_000,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          throw new Error("lifecycle helper should use injected runner");
        },
      };
    },
  });

  const completed = baseLiveMeta(ctx, {
    status: "implementation-complete",
    reviewBase: "aaa111",
    reviewHead: `refs/harness/factory/${ctx.runId}/implementation`,
    reviewCommitSha: "bbb222",
  });

  const meta = await runFactoryImplementationWithLifecycle({
    ctx,
    factoryStateRoot,
    itemFile: join(workspace, "work-item.json"),
    async runImplementation() {
      return completed;
    },
  });

  expect(meta.status).toBe("implementation-complete");
  const events = readFactoryLifecycleEvents({
    factoryStateRoot,
    workItemKey: deriveFactoryWorkItemKey(workItem),
  });
  expect(events.map((event) => event.type)).toEqual([
    "work_item.imported",
    "implementation.started",
    "implementation.completed",
  ]);
  expect(events[2]).toMatchObject({
    type: "implementation.completed",
    data: {
      reviewBase: "aaa111",
      reviewHead: `refs/harness/factory/${ctx.runId}/implementation`,
      reviewCommitSha: "bbb222",
    },
  });
});

test("runFactoryImplementationWithLifecycle terminal event uses tracker metadata key", async () => {
  const workspace = createWorkspace();
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-factory-impl-lifecycle-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const workItem: FactoryWorkItem = {
    ...directWorkItem(),
    id: "file:local-1",
    source: "file",
    metadata: {
      tracker: { source: "linear", id: "FER-47" },
      factoryStage: "ready-to-implement",
      factoryRoute: "ready-to-implement",
      factoryNextAction: "implement-directly",
    },
  };
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem,
    implementationInput: directInput(workItem),
    implementerRole: { agent: "cursor" },
    dryRun: false,
    maxRuntimeMs: 1_000,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          throw new Error("lifecycle helper should use injected runner");
        },
      };
    },
  });

  const completed = baseLiveMeta(ctx, {
    status: "implementation-complete",
    reviewBase: "aaa111",
    reviewHead: `refs/harness/factory/${ctx.runId}/implementation`,
    reviewCommitSha: "bbb222",
  });

  await runFactoryImplementationWithLifecycle({
    ctx,
    factoryStateRoot,
    itemFile: join(workspace, "work-item.json"),
    async runImplementation() {
      return completed;
    },
  });

  const trackerEvents = readFactoryLifecycleEvents({
    factoryStateRoot,
    workItemKey: "linear:FER-47",
  });
  const fallbackEvents = readFactoryLifecycleEvents({
    factoryStateRoot,
    workItemKey: deriveFactoryWorkItemKey({ ...workItem, metadata: undefined }),
  });
  expect(trackerEvents.map((event) => event.type)).toEqual([
    "work_item.imported",
    "implementation.started",
    "implementation.completed",
  ]);
  expect(fallbackEvents).toHaveLength(0);
});

test("runFactoryImplementationWithLifecycle live failed meta appends implementation.failed", async () => {
  const workspace = createWorkspace();
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-factory-impl-lifecycle-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const workItem = directWorkItem();
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem,
    implementationInput: directInput(workItem),
    implementerRole: { agent: "cursor" },
    dryRun: false,
    maxRuntimeMs: 1_000,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          throw new Error("lifecycle helper should use injected runner");
        },
      };
    },
  });

  const failed = baseLiveMeta(ctx, {
    status: "implementation-failed",
    error: "Implementer failed",
  });

  const meta = await runFactoryImplementationWithLifecycle({
    ctx,
    factoryStateRoot,
    async runImplementation() {
      return failed;
    },
  });

  expect(meta.status).toBe("implementation-failed");
  const events = readFactoryLifecycleEvents({
    factoryStateRoot,
    workItemKey: deriveFactoryWorkItemKey(workItem),
  });
  expect(events.map((event) => event.type)).toEqual([
    "work_item.imported",
    "implementation.started",
    "implementation.failed",
  ]);
  expect(events[2]).toMatchObject({
    type: "implementation.failed",
    data: { error: "Implementer failed" },
  });
});

test("runFactoryImplementationWithLifecycle live runner throw terminalizes without rethrow", async () => {
  const workspace = createWorkspace();
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-factory-impl-lifecycle-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const workItem = directWorkItem();
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem,
    implementationInput: directInput(workItem),
    implementerRole: { agent: "cursor" },
    dryRun: false,
    maxRuntimeMs: 1_000,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          throw new Error("lifecycle helper should use injected runner");
        },
      };
    },
  });

  const meta = await runFactoryImplementationWithLifecycle({
    ctx,
    factoryStateRoot,
    async runImplementation() {
      throw new Error("workflow exploded after started");
    },
  });

  expect(meta.status).toBe("implementation-failed");
  expect(meta.error).toContain("workflow exploded after started");
  expect(existsSync(join(ctx.runDir, "meta.json"))).toBe(true);
  const events = readFactoryLifecycleEvents({
    factoryStateRoot,
    workItemKey: deriveFactoryWorkItemKey(workItem),
  });
  expect(events.map((event) => event.type)).toEqual([
    "work_item.imported",
    "implementation.started",
    "implementation.failed",
  ]);
  expect(events[2]).toMatchObject({
    type: "implementation.failed",
    data: { error: "workflow exploded after started" },
  });
});

test("runFactoryImplementationWithLifecycle rethrows when terminal lifecycle append fails after success", async () => {
  const workspace = createWorkspace();
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-factory-impl-lifecycle-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const workItem = directWorkItem();
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem,
    implementationInput: directInput(workItem),
    implementerRole: { agent: "cursor" },
    dryRun: false,
    maxRuntimeMs: 1_000,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          throw new Error("lifecycle helper should use injected runner");
        },
      };
    },
  });

  const completed = baseLiveMeta(ctx, {
    status: "implementation-complete",
    reviewBase: "aaa111",
    reviewHead: `refs/harness/factory/${ctx.runId}/implementation`,
    reviewCommitSha: "bbb222",
  });

  await expect(
    runFactoryImplementationWithLifecycle({
      ctx,
      factoryStateRoot,
      async runImplementation() {
        // Invalidate the lifecycle root after started events so terminal append fails.
        rmSync(factoryStateRoot, { recursive: true, force: true });
        writeFileSync(factoryStateRoot, "not-a-directory\n", "utf8");
        return completed;
      },
    }),
  ).rejects.toThrow();
});

test("runFactoryImplementationWithLifecycle rethrows when failed meta export cannot be written", async () => {
  const workspace = createWorkspace();
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-factory-impl-lifecycle-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const workItem = directWorkItem();
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem,
    implementationInput: directInput(workItem),
    implementerRole: { agent: "cursor" },
    dryRun: false,
    maxRuntimeMs: 1_000,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          throw new Error("lifecycle helper should use injected runner");
        },
      };
    },
  });

  let thrown: unknown;
  try {
    await runFactoryImplementationWithLifecycle({
      ctx,
      factoryStateRoot,
      async runImplementation() {
        rmSync(ctx.runDir, { recursive: true, force: true });
        writeFileSync(ctx.runDir, "not-a-directory\n", "utf8");
        throw new Error("workflow exploded after started");
      },
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as AggregateError).message).toContain("workflow exploded after started");
  expect((thrown as AggregateError).errors).toHaveLength(2);
});

test("runFactoryImplementationWithLifecycle throw path does not advertise unwritten live artifacts", async () => {
  const workspace = createWorkspace();
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-factory-impl-lifecycle-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const workItem = directWorkItem();
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem,
    implementationInput: directInput(workItem),
    implementerRole: { agent: "cursor" },
    dryRun: false,
    maxRuntimeMs: 1_000,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          throw new Error("lifecycle helper should use injected runner");
        },
      };
    },
  });

  const meta = await runFactoryImplementationWithLifecycle({
    ctx,
    factoryStateRoot,
    async runImplementation() {
      throw new Error("workflow exploded before live artifacts");
    },
  });

  expect(meta.status).toBe("implementation-failed");
  expect(meta.artifacts.rawOutput).toBeUndefined();
  expect(meta.artifacts.diff).toBeUndefined();
  expect(meta.artifacts.workspaceStatus).toBeUndefined();
  expect(existsSync(join(ctx.runDir, "implementation/implementer.raw.json"))).toBe(false);
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
    id: "file:local-1",
    source: "file",
    title: "Direct work",
    body: "Implement direct request.",
    labels: ["factory"],
    url: "https://example.com/work/local-1",
    metadata: {
      tracker: { source: "file", id: "local-1", url: "https://example.com/work/local-1" },
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

function directInput(workItem: FactoryWorkItem): FactoryImplementationInput {
  const metadata = parseFactoryWorkItemMetadata(workItem.metadata);
  return {
    mode: "direct",
    source: "item-file",
    workItem,
    metadata,
    sourceMaterial: {
      title: workItem.title,
      body: workItem.body,
      labels: workItem.labels,
      url: workItem.url,
      ...(metadata.tracker ? { tracker: metadata.tracker } : {}),
    },
  };
}

function baseLiveMeta(
  ctx: ReturnType<typeof createFactoryImplementationRunContextForTest>,
  overrides: Partial<FactoryImplementationRunMeta> & {
    status: FactoryImplementationRunMeta["status"];
  },
): FactoryImplementationRunMeta {
  return {
    runId: ctx.runId,
    workflow: "factory-implementation",
    status: overrides.status,
    mode: "direct",
    workspace: ctx.workspace,
    runDir: ctx.runDir,
    workItem: {
      id: ctx.workItem.id,
      source: ctx.workItem.source,
      title: ctx.workItem.title,
    },
    implementerAgent: ctx.implementerAgent,
    artifacts: {
      workItem: "context/work-item.json",
      implementationInput: "context/implementation-input.json",
      sourceMaterial: "context/source-material.json",
      prompt: "implementation/prompt.md",
      changeReviewHandoff: "implementation/change-review-handoff.md",
      summary: "summary.md",
      meta: "meta.json",
      ...(overrides.status === "implementation-complete"
        ? {
            rawOutput: "implementation/implementer.raw.json" as const,
            workspaceStatus: "implementation/workspace-status.json" as const,
            diff: "implementation/diff.patch" as const,
          }
        : {
            rawOutput: "implementation/implementer.raw.json" as const,
            workspaceStatus: "implementation/workspace-status.json" as const,
            diff: "implementation/diff.patch" as const,
          }),
    },
    summaryPath: join(ctx.runDir, "summary.md"),
    metaPath: join(ctx.runDir, "meta.json"),
    startedAt: ctx.startedAt.toISOString(),
    durationMs: 1,
    eventsFile: "events.jsonl",
    factoryMetadata: ctx.implementationInput.metadata,
    ...(overrides.error ? { error: overrides.error } : {}),
    ...(overrides.reviewBase ? { reviewBase: overrides.reviewBase } : {}),
    ...(overrides.reviewHead ? { reviewHead: overrides.reviewHead } : {}),
    ...(overrides.reviewCommitSha ? { reviewCommitSha: overrides.reviewCommitSha } : {}),
  };
}

function runHarness(args: string[]) {
  return runFactoryHarness({
    bin: BIN,
    args,
    cwd: process.cwd(),
    env: { LINEAR_API_KEY: "test-key" },
  }).result;
}

function parseStdout(result: ReturnType<typeof runHarness>): Record<string, any> {
  return JSON.parse(result.stdout) as Record<string, any>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
