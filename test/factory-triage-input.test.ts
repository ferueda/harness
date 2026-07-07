import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
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

test("resolveFactoryTriageWorkItem fetches Linear issue input without applying tracker updates", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-triage-input-"));
  const calls: unknown[] = [];

  const input = await resolveFactoryTriageWorkItem({
    workspace,
    linearIssue: "ENG-123",
    linearSettings: LINEAR_SETTINGS,
    env: { LINEAR_API_KEY: "test-key" },
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
    linearSettings: LINEAR_SETTINGS,
    env: { LINEAR_API_KEY: "test-key" },
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
    linearSettings: LINEAR_SETTINGS,
    env: { LINEAR_API_KEY: "test-key" },
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
    }),
  ).rejects.toThrow(/--item-file and --linear-issue are mutually exclusive/);

  await expect(
    resolveFactoryTriageWorkItem({
      workspace,
      linearIssue: "ENG-123",
      env: { LINEAR_API_KEY: "test-key" },
    }),
  ).rejects.toThrow(/factory\.linear is required/);

  await expect(
    resolveFactoryTriageWorkItem({
      workspace,
      linearIssue: "ENG-123",
      linearSettings: LINEAR_SETTINGS,
      env: { LINEAR_API_KEY: "" },
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
