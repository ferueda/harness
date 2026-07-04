import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentRunInput } from "../lib/agents.ts";
import {
  dispatchFactoryInbox,
  factoryInboxStatus,
  defaultFactoryInboxDir,
} from "../lib/factory-dispatch.ts";
import type { FactoryTriageOutput, FactoryWorkItem } from "../lib/factory-schemas.ts";
import { run as runFactoryTriage } from "../workflows/factory-triage.workflow.ts";

const TRIAGE_OUTPUT = {
  route: "ready-to-plan",
  confidence: "medium",
  rationale: "The item needs planning before implementation.",
  evidence: [{ kind: "repo-state", summary: "Fixture workspace." }],
  suggestedNext: { action: "create-plan" },
} satisfies FactoryTriageOutput;

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "harness-factory-dispatch-"));
}

function writeInboxItem(workspace: string, file: string, item: FactoryWorkItem): string {
  const inboxDir = defaultFactoryInboxDir(workspace);
  mkdirSync(inboxDir, { recursive: true });
  const itemPath = join(inboxDir, file);
  writeFileSync(itemPath, JSON.stringify(item, null, 2), "utf8");
  return itemPath;
}

function item(id: string, title: string): FactoryWorkItem {
  return {
    id,
    source: "file",
    title,
    body: `Body for ${title}`,
    labels: [],
  };
}

test("factoryInboxStatus lists pending items sorted and does not create directories", () => {
  const workspace = createWorkspace();
  const inboxDir = defaultFactoryInboxDir(workspace);
  writeInboxItem(workspace, "002-second.json", item("item-2", "Second"));
  writeInboxItem(workspace, "001-first.json", item("item-1", "First"));

  const status = factoryInboxStatus({ workspace });
  expect(status.workspace).toBe(workspace);
  expect(status.inboxDir).toBe(inboxDir);
  expect(status.pending.map((pending) => pending.file)).toEqual([
    "001-first.json",
    "002-second.json",
  ]);
  expect(status.pending[0]).toMatchObject({
    id: "item-1",
    source: "file",
    title: "First",
  });
  expect(status.processedCount).toBe(0);
  expect(status.failed).toEqual([]);
  expect(existsSync(join(workspace, ".harness/runs/factory"))).toBe(false);
});

test("factoryInboxStatus reports failed items with error summaries", () => {
  const workspace = createWorkspace();
  const failedDir = join(defaultFactoryInboxDir(workspace), "failed");
  mkdirSync(failedDir, { recursive: true });
  writeFileSync(join(failedDir, "run-001-bad.json"), "{ nope", "utf8");
  writeFileSync(
    join(failedDir, "run-001-bad.error.json"),
    JSON.stringify({ error: "Invalid factory work item JSON" }),
    "utf8",
  );

  const status = factoryInboxStatus({ workspace });
  expect(status.failedCount).toBe(1);
  expect(status.failed[0]).toMatchObject({
    file: "run-001-bad.json",
    error: "Invalid factory work item JSON",
  });
});

test("factoryInboxStatus reports invalid pending items without creating runs", () => {
  const workspace = createWorkspace();
  const inboxDir = defaultFactoryInboxDir(workspace);
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "001-bad.json"), "{ nope", "utf8");

  const status = factoryInboxStatus({ workspace });
  expect(status.pendingCount).toBe(1);
  expect(status.pending[0]).toMatchObject({
    file: "001-bad.json",
  });
  expect(status.pending[0]?.error).toContain("Invalid factory work item JSON");
  expect(status.processedCount).toBe(0);
  expect(status.failedCount).toBe(0);
  expect(existsSync(join(workspace, ".harness/runs/factory"))).toBe(false);
});

test("factoryInboxStatus resolves relative inboxDir against workspace", () => {
  const workspace = createWorkspace();
  const inboxDir = join(workspace, "custom-inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "001-item.json"), JSON.stringify(item("item-1", "First")), "utf8");

  const status = factoryInboxStatus({ workspace, inboxDir: "custom-inbox" });
  expect(status.inboxDir).toBe(inboxDir);
  expect(status.pending.map((pending) => pending.file)).toEqual(["001-item.json"]);
});

test("dispatchFactoryInbox dry-run processes sorted items without moving inbox files", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  writeInboxItem(workspace, "002-second.json", item("item-2", "Second"));
  writeInboxItem(workspace, "001-first.json", item("item-1", "First"));

  const result = await dispatchFactoryInbox({
    workspace,
    runsDir,
    dryRun: true,
    maxRuntimeMs: 1_000,
    runFactoryTriage,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          throw new Error("dry-run should not call provider");
        },
      };
    },
  });

  expect(result.dryRun).toBe(true);
  expect(result.pendingCount).toBe(2);
  expect(result.processedCount).toBe(2);
  expect(result.failedCount).toBe(0);
  expect(result.processed.map((processed) => processed.file)).toEqual([
    "001-first.json",
    "002-second.json",
  ]);
  expect(existsSync(join(defaultFactoryInboxDir(workspace), "001-first.json"))).toBe(true);
  expect(existsSync(join(defaultFactoryInboxDir(workspace), "002-second.json"))).toBe(true);
  expect(existsSync(join(defaultFactoryInboxDir(workspace), "processed"))).toBe(false);
});

test("dispatchFactoryInbox moves successful items to processed", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const itemPath = writeInboxItem(workspace, "001-first.json", item("item-1", "First"));
  const calls: AgentRunInput[] = [];

  const result = await dispatchFactoryInbox({
    workspace,
    runsDir,
    maxRuntimeMs: 1_000,
    runFactoryTriage,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          calls.push(input);
          return {
            ok: true,
            structuredOutput: TRIAGE_OUTPUT,
            raw: { finalResponse: JSON.stringify(TRIAGE_OUTPUT) },
          };
        },
      };
    },
  });

  expect(result.processedCount).toBe(1);
  expect(result.failedCount).toBe(0);
  expect(result.processed[0]).toMatchObject({
    file: "001-first.json",
    route: "ready-to-plan",
    nextAction: "create-plan",
    status: "completed",
  });
  expect(result.processed[0]?.movedTo).toMatch(/processed\/.+-001-first\.json$/);
  expect(existsSync(itemPath)).toBe(false);
  expect(existsSync(result.processed[0]!.movedTo!)).toBe(true);
  expect(calls).toHaveLength(1);
});

test("dispatchFactoryInbox moves workflow failures to failed with run artifacts", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const itemPath = writeInboxItem(workspace, "001-first.json", item("item-1", "First"));

  const result = await dispatchFactoryInbox({
    workspace,
    runsDir,
    maxRuntimeMs: 1_000,
    async runFactoryTriage(ctx) {
      return ctx.exportFailed(new Error("triage exploded"));
    },
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          throw new Error("injected runner should not call provider");
        },
      };
    },
  });

  expect(result.processedCount).toBe(0);
  expect(result.failedCount).toBe(1);
  expect(result.failed[0]).toMatchObject({
    file: "001-first.json",
    status: "failed",
    error: "triage exploded",
  });
  expect(result.failed[0]?.runDir).toMatch(runsDir);
  expect(result.failed[0]?.movedTo).toMatch(/failed\/.+-001-first\.json$/);
  expect(result.failed[0]?.errorPath).toMatch(/failed\/.+-001-first\.error\.json$/);
  expect(existsSync(itemPath)).toBe(false);
  expect(existsSync(result.failed[0]!.runDir!)).toBe(true);
  expect(existsSync(result.failed[0]!.movedTo!)).toBe(true);
  expect(readFileSync(result.failed[0]!.errorPath!, "utf8")).toContain("triage exploded");
});

test("dispatchFactoryInbox moves context bootstrap failures to failed", async () => {
  const workspace = createWorkspace();
  const itemPath = writeInboxItem(workspace, "001-first.json", item("item-1", "First"));

  const result = await dispatchFactoryInbox({
    workspace,
    maxRuntimeMs: 1_000,
    async runFactoryTriage() {
      throw new Error("runner should not be reached");
    },
    agentProviderFactory() {
      throw new Error("provider unavailable");
    },
  });

  expect(result.processedCount).toBe(0);
  expect(result.failedCount).toBe(1);
  expect(result.failed[0]).toMatchObject({
    file: "001-first.json",
    status: "failed",
    error: "provider unavailable",
  });
  expect(result.failed[0]?.runDir).toBeUndefined();
  expect(result.failed[0]?.movedTo).toMatch(/failed\/.+-001-first\.json$/);
  expect(existsSync(itemPath)).toBe(false);
  expect(readFileSync(result.failed[0]!.errorPath!, "utf8")).toContain("provider unavailable");
});

test("dispatchFactoryInbox dry-run reports workflow failures without moving inbox files", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const itemPath = writeInboxItem(workspace, "001-first.json", item("item-1", "First"));

  const result = await dispatchFactoryInbox({
    workspace,
    runsDir,
    dryRun: true,
    maxRuntimeMs: 1_000,
    async runFactoryTriage(ctx) {
      return ctx.exportFailed(new Error("dry-run triage exploded"));
    },
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          throw new Error("injected runner should not call provider");
        },
      };
    },
  });

  expect(result.processedCount).toBe(0);
  expect(result.failedCount).toBe(1);
  expect(result.failed[0]).toMatchObject({
    file: "001-first.json",
    status: "failed",
    error: "dry-run triage exploded",
  });
  expect(result.failed[0]?.movedTo).toBeUndefined();
  expect(result.failed[0]?.errorPath).toBeUndefined();
  expect(existsSync(itemPath)).toBe(true);
  expect(existsSync(join(defaultFactoryInboxDir(workspace), "failed"))).toBe(false);
});

test("dispatchFactoryInbox continues through mixed live outcomes", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const firstPath = writeInboxItem(workspace, "001-first.json", item("item-1", "First"));
  const secondPath = writeInboxItem(workspace, "002-second.json", item("item-2", "Second"));

  const result = await dispatchFactoryInbox({
    workspace,
    runsDir,
    maxRuntimeMs: 1_000,
    async runFactoryTriage(ctx) {
      if (ctx.workItem.id === "item-1") {
        return ctx.exportFailed(new Error("first failed"));
      }
      return runFactoryTriage(ctx);
    },
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return {
            ok: true,
            structuredOutput: TRIAGE_OUTPUT,
            raw: { finalResponse: JSON.stringify(TRIAGE_OUTPUT) },
          };
        },
      };
    },
  });

  expect(result.pendingCount).toBe(2);
  expect(result.processedCount).toBe(1);
  expect(result.failedCount).toBe(1);
  expect(result.failed[0]).toMatchObject({
    file: "001-first.json",
    status: "failed",
    error: "first failed",
  });
  expect(result.processed[0]).toMatchObject({
    file: "002-second.json",
    status: "completed",
    route: "ready-to-plan",
  });
  expect(existsSync(firstPath)).toBe(false);
  expect(existsSync(secondPath)).toBe(false);
  expect(result.failed[0]?.movedTo).toMatch(/failed\/.+-001-first\.json$/);
  expect(result.processed[0]?.movedTo).toMatch(/processed\/.+-002-second\.json$/);
});

test("dispatchFactoryInbox moves invalid items to failed with an error file", async () => {
  const workspace = createWorkspace();
  const inboxDir = defaultFactoryInboxDir(workspace);
  mkdirSync(inboxDir, { recursive: true });
  const badItemPath = join(inboxDir, "001-bad.json");
  writeFileSync(badItemPath, "{ nope", "utf8");

  const result = await dispatchFactoryInbox({
    workspace,
    dryRun: false,
    maxRuntimeMs: 1_000,
    runFactoryTriage,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          throw new Error("invalid item should not call provider");
        },
      };
    },
  });

  expect(result.processedCount).toBe(0);
  expect(result.failedCount).toBe(1);
  expect(result.failed[0]).toMatchObject({
    file: "001-bad.json",
    status: "failed",
  });
  expect(result.failed[0]?.movedTo).toMatch(/failed\/.+-001-bad\.json$/);
  expect(result.failed[0]?.errorPath).toMatch(/failed\/.+-001-bad\.error\.json$/);
  expect(existsSync(badItemPath)).toBe(false);
  expect(readFileSync(result.failed[0]!.errorPath!, "utf8")).toContain(
    "Invalid factory work item JSON",
  );
});
