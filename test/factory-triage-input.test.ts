import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  factoryLifecycleStatePath,
  resolveFactoryStateRoot,
  workItemKeyToFilename,
} from "../lib/factory-lifecycle-legacy.ts";
import { FactoryLifecycleLockTimeoutError } from "../lib/factory-locks.ts";
import {
  assertFactoryItemFileExists,
  createFactoryRunContextForTest,
} from "../lib/factory-run-context.ts";
import {
  resolveFactoryTriageWorkItem,
  resolveFactoryWorkItemInput,
  validateFactoryWorkItemInput,
} from "../lib/factory-triage-input.ts";
import { run as runFactoryTriage } from "../workflows/factory-triage.workflow.ts";
import {
  fakeLinearAdapter,
  LINEAR_SETTINGS,
  LINEAR_WORK_ITEM,
} from "./factory-linear-test-helpers.ts";

test("resolveFactoryTriageWorkItem reads file input", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-triage-input-"));
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({
      id: "local-1",
      source: "file",
      title: "Local item",
      body: "Read from disk.",
    }),
    "utf8",
  );

  const input = await resolveFactoryTriageWorkItem({
    workspace,
    itemFile: "item.json",
    allowWorkspaceLocalStateRoot: true,
    lifecycleReadMode: "load",
  });

  expect(input).toMatchObject({
    source: "item-file",
    workItem: {
      id: "local-1",
      source: "file",
      title: "Local item",
    },
  });
});

test("station input requires an explicit durable state root outside low-level tests", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-triage-input-"));
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({ id: "local-1", source: "file", title: "Local item", body: "" }),
    "utf8",
  );

  await expect(
    resolveFactoryWorkItemInput({
      workspace,
      itemFile: "item.json",
      lifecycleReadMode: "load",
    }),
  ).rejects.toThrow(/factoryStateRoot is required/);
  expect(existsSync(join(workspace, ".harness/factory"))).toBe(false);
});

test("live station input fails closed with lock diagnostics before rebuilding a missing projection", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-triage-lock-timeout-"));
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-triage-lock-store-"));
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({ id: "local-1", source: "file", title: "Locked item", body: "" }),
    "utf8",
  );
  const workItemKey = "file:local-1";
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: "2026-07-09T00:00:00.000Z",
      source: "harness",
      data: { source: "file", title: "Locked item" },
    },
  });
  const statePath = factoryLifecycleStatePath(factoryStateRoot, workItemKey);
  rmSync(statePath);
  const ownerPath = join(
    factoryStateRoot,
    "locks",
    `${workItemKeyToFilename(workItemKey)}.lock`,
    "owner.json",
  );
  mkdirSync(dirname(ownerPath), { recursive: true });
  writeFileSync(
    ownerPath,
    `${JSON.stringify({
      pid: 1,
      hostname: "other-host",
      token: "held-token",
      workspace,
      workItemKey,
      startedAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  let thrown: unknown;
  try {
    await resolveFactoryWorkItemInput({
      workspace,
      itemFile: "item.json",
      factoryStateRoot,
      lifecycleReadMode: "load",
      lifecycleLockOptions: { timeoutMs: 0 },
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(FactoryLifecycleLockTimeoutError);
  expect((thrown as FactoryLifecycleLockTimeoutError).diagnostic).toMatchObject({
    operation: "read",
    workItemKey,
    lockPath: join(factoryStateRoot, "locks", `${workItemKeyToFilename(workItemKey)}.lock`),
    stale: false,
    owner: { token: "held-token", hostname: "other-host" },
  });
  expect(existsSync(statePath)).toBe(false);
  expect(readFileSync(ownerPath, "utf8")).toContain("held-token");
});

test("item-file input accepts warnings added by factory linear fetch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-triage-input-"));
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({
      id: "local-1",
      source: "file",
      title: "Fetched item",
      body: "",
      labels: [],
      warnings: [{ code: "durable-state-stale" }],
    }),
    "utf8",
  );

  await expect(
    resolveFactoryWorkItemInput({
      workspace,
      itemFile: "item.json",
      lifecycleReadMode: "inspect",
      allowWorkspaceLocalStateRoot: true,
    }),
  ).resolves.toMatchObject({ workItem: { id: "local-1", title: "Fetched item" } });
});

test("resolveFactoryTriageWorkItem fetches Linear issue input without applying tracker updates", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-triage-input-"));
  const calls: unknown[] = [];

  const input = await resolveFactoryTriageWorkItem({
    workspace,
    linearIssue: "ENG-123",
    allowWorkspaceLocalStateRoot: true,
    linearSettings: LINEAR_SETTINGS,
    env: { LINEAR_API_KEY: "test-key" },
    lifecycleReadMode: "load",
    linearAdapterFactory: (adapterInput) => {
      calls.push(adapterInput);
      return fakeLinearAdapter({
        fetchWorkItem: async (issueRef) => {
          expect(issueRef).toBe("ENG-123");
          return LINEAR_WORK_ITEM;
        },
      });
    },
  });

  expect(calls).toEqual([{ apiKey: "test-key", settings: LINEAR_SETTINGS }]);
  expect(input).toEqual({
    source: "linear",
    workItem: LINEAR_WORK_ITEM,
    linearApplied: false,
  });
});

test("resolveFactoryWorkItemInput keeps generic resolver compatible with triage input", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-work-item-input-"));
  const input = await resolveFactoryWorkItemInput({
    workspace,
    linearIssue: "ENG-123",
    allowWorkspaceLocalStateRoot: true,
    linearSettings: LINEAR_SETTINGS,
    env: { LINEAR_API_KEY: "test-key" },
    lifecycleReadMode: "load",
    linearAdapterFactory: () => fakeLinearAdapter(),
  });

  expect(input).toMatchObject({
    source: "linear",
    workItem: {
      id: "linear:ENG-123",
      source: "linear",
    },
    linearApplied: false,
  });
});

test("resolveFactoryWorkItemInput overlays lifecycle state over Linear fallback metadata", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-work-item-lifecycle-"));
  const factoryStateRoot = resolveFactoryStateRoot({ workspace });
  const workItemKey = deriveFactoryWorkItemKey(LINEAR_WORK_ITEM);
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: "2026-07-08T00:00:00.000Z",
      source: "harness",
      data: {
        source: LINEAR_WORK_ITEM.source,
        title: LINEAR_WORK_ITEM.title,
        tracker: { source: "linear", id: "ENG-123" },
      },
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: "triage.completed:run-1",
      type: "triage.completed",
      workItemKey,
      occurredAt: "2026-07-08T00:01:00.000Z",
      runId: "run-1",
      source: "harness",
      data: {
        route: "ready-to-plan",
        nextAction: "create-plan",
        rationale: "Needs a plan.",
        routeArtifactPath: "factory-route.md",
        triageArtifactPath: "factory-triage.json",
      },
    },
  });

  const input = await resolveFactoryWorkItemInput({
    workspace,
    linearIssue: "ENG-123",
    allowWorkspaceLocalStateRoot: true,
    linearSettings: LINEAR_SETTINGS,
    env: { LINEAR_API_KEY: "test-key" },
    lifecycleReadMode: "load",
    linearAdapterFactory: () =>
      fakeLinearAdapter({
        fetchWorkItem: async () => ({
          ...LINEAR_WORK_ITEM,
          metadata: {
            ...LINEAR_WORK_ITEM.metadata,
            factoryStage: "incoming",
          },
        }),
      }),
  });

  expect(input.workItem.metadata).toMatchObject({
    linearStatus: "Backlog",
    factoryStage: "ready-to-plan",
    factoryRoute: "ready-to-plan",
    factoryNextAction: "create-plan",
    factoryRunId: "run-1",
  });
});

test("lifecycle triage clears stale source plan publication metadata", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-work-item-lifecycle-clear-"));
  const factoryStateRoot = resolveFactoryStateRoot({ workspace });
  const workItemKey = deriveFactoryWorkItemKey(LINEAR_WORK_ITEM);
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: "2026-07-08T00:00:00.000Z",
      source: "harness",
      data: { source: "linear", title: LINEAR_WORK_ITEM.title },
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: "triage.completed:run-direct",
      type: "triage.completed",
      workItemKey,
      occurredAt: "2026-07-08T00:01:00.000Z",
      runId: "run-direct",
      source: "harness",
      data: {
        route: "ready-to-implement",
        nextAction: "implement-directly",
        rationale: "Direct",
        routeArtifactPath: "factory-route.md",
        triageArtifactPath: "factory-triage.json",
      },
    },
  });
  const input = await resolveFactoryWorkItemInput({
    workspace,
    linearIssue: "ENG-123",
    factoryStateRoot,
    linearSettings: LINEAR_SETTINGS,
    env: { LINEAR_API_KEY: "test-key" },
    lifecycleReadMode: "load",
    linearAdapterFactory: () =>
      fakeLinearAdapter({
        fetchWorkItem: async () => ({
          ...LINEAR_WORK_ITEM,
          metadata: {
            ...LINEAR_WORK_ITEM.metadata,
            approvedPlanPath: "dev/plans/stale.md",
            approvedPlanPrUrl: "https://github.com/example/repo/pull/1",
            approvedPlanCommit: "abc1234",
          },
        }),
      }),
  });
  expect(input.workItem.metadata).toMatchObject({
    linearStatus: "Backlog",
    factoryStage: "ready-to-implement",
    factoryRoute: "ready-to-implement",
    factoryNextAction: "implement-directly",
  });
  expect(input.workItem.metadata).not.toHaveProperty("approvedPlanPath");
  expect(input.workItem.metadata).not.toHaveProperty("approvedPlanPrUrl");
  expect(input.workItem.metadata).not.toHaveProperty("approvedPlanCommit");
});

test("validateFactoryWorkItemInput rejects multiple input sources", () => {
  expect(() =>
    validateFactoryWorkItemInput({ itemFile: "item.json", linearIssue: "ENG-123" }),
  ).toThrow(/--item-file and --linear-issue are mutually exclusive/);
});

test("Linear issue input can run through factory triage dry-run artifacts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-triage-input-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-triage-runs-"));
  const input = await resolveFactoryTriageWorkItem({
    workspace,
    linearIssue: "ENG-123",
    allowWorkspaceLocalStateRoot: true,
    linearSettings: LINEAR_SETTINGS,
    env: { LINEAR_API_KEY: "test-key" },
    lifecycleReadMode: "inspect",
    linearAdapterFactory: () => fakeLinearAdapter(),
  });
  const ctx = createFactoryRunContextForTest({
    workspace,
    runsDir,
    workItem: input.workItem,
    dryRun: true,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          throw new Error("dry-run should not call provider");
        },
      };
    },
  });

  const meta = await runFactoryTriage(ctx);
  const contextWorkItem = JSON.parse(
    readFileSync(join(ctx.runDir, "context/work-item.json"), "utf8"),
  );

  expect(meta.status).toBe("dry_run");
  expect(meta.workItem).toMatchObject({
    id: "linear:ENG-123",
    source: "linear",
    title: "Linear issue",
  });
  expect(contextWorkItem).toMatchObject({
    source: "linear",
    metadata: {
      tracker: {
        source: "linear",
        id: "ENG-123",
      },
      linearIssueId: "issue-1",
      linearProjectId: "project-1",
      linearProjectName: "Harness",
    },
  });
});

test("resolveFactoryTriageWorkItem requires Linear config and API key", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-triage-input-"));

  await expect(
    resolveFactoryTriageWorkItem({
      workspace,
      itemFile: "item.json",
      linearIssue: "ENG-123",
      linearSettings: LINEAR_SETTINGS,
      env: { LINEAR_API_KEY: "test-key" },
      lifecycleReadMode: "load",
    }),
  ).rejects.toThrow(/--item-file and --linear-issue are mutually exclusive/);

  await expect(
    resolveFactoryTriageWorkItem({
      workspace,
      linearIssue: "ENG-123",
      env: { LINEAR_API_KEY: "test-key" },
      lifecycleReadMode: "load",
    }),
  ).rejects.toThrow(/factory\.linear is required/);

  await expect(
    resolveFactoryTriageWorkItem({
      workspace,
      linearIssue: "ENG-123",
      linearSettings: LINEAR_SETTINGS,
      env: { LINEAR_API_KEY: "" },
      lifecycleReadMode: "load",
    }),
  ).rejects.toThrow(/LINEAR_API_KEY is required/);
});

test("assertFactoryItemFileExists resolves relative paths from workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-triage-input-"));
  mkdirSync(join(workspace, "items"));
  writeFileSync(join(workspace, "items/item.json"), "{}", "utf8");

  const resolved = assertFactoryItemFileExists(workspace, "items/item.json");

  expect(readFileSync(resolved, "utf8")).toBe("{}");
  expect(() => assertFactoryItemFileExists(workspace, "missing.json")).toThrow(
    /Factory item file does not exist: missing\.json/,
  );
});
