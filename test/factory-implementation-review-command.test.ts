import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runFactoryImplementationReviewCommand } from "../bin/factory-implementation-review-command.ts";
import {
  appendFactoryLifecycleEvent,
  loadFactoryLifecycleState,
} from "../lib/factory-lifecycle.ts";
import { resolveFactoryStore } from "../lib/factory-store.ts";

test("legacy review input is durably terminalized without invoking a provider", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-command-workspace-"));
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: mkdtempSync(join(tmpdir(), "harness-review-command-store-")),
    factoryStoreProjectId: "test-project",
    env: process.env,
  });
  const itemFile = join(workspace, "work-item.json");
  writeFileSync(
    itemFile,
    `${JSON.stringify({
      id: "linear:ENG-123",
      source: "linear",
      title: "Legacy implementation",
      body: "",
      labels: [],
      metadata: { tracker: { source: "linear", id: "ENG-123" } },
    })}\n`,
    "utf8",
  );
  const execution = {
    workspace,
    runDir: join(store.factoryRunsDir, "implementation-legacy"),
    storeRoot: store.storeRoot,
    projectId: store.projectId,
    factoryStateRoot: store.factoryStateRoot,
    repo: {
      name: "test-project",
      id: "test-project",
      idSource: "config" as const,
    },
  };
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: "work_item.imported:linear:ENG-123",
      type: "work_item.imported",
      workItemKey: "linear:ENG-123",
      occurredAt: "2026-07-11T00:00:00.000Z",
      source: "harness",
      data: { source: "linear", title: "Legacy implementation" },
      execution,
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: "implementation.completed:implementation-legacy",
      type: "implementation.completed",
      workItemKey: "linear:ENG-123",
      occurredAt: "2026-07-11T00:00:01.000Z",
      runId: "implementation-legacy",
      source: "harness",
      data: {
        diffPath: "implementation/diff.patch",
        changeReviewHandoffPath: "implementation/change-review-handoff.md",
        reviewBase: "base",
        reviewHead: "head",
        reviewCommitSha: "commit",
      },
      execution,
    },
  });
  const runner = vi.fn();
  const result = await runFactoryImplementationReviewCommand(
    {
      workspace,
      itemFile,
      resume: false,
      factoryStoreRoot: store.storeRoot,
      factoryStoreProjectId: store.projectId,
      maxRuntimeMs: 1_000,
      verbose: false,
    },
    {
      defaultMaxRuntimeMs: 1_000,
      positiveNumber: Number,
      implementationReviewRunner: runner,
    },
  );

  expect(result.status).toBe("ready-for-human");
  expect("legacyIncomplete" in result && result.missing).toContain("session");
  expect(runner).not.toHaveBeenCalled();
  expect(readFileSync(result.summaryPath, "utf8")).toContain("legacy-incomplete");
  expect(
    loadFactoryLifecycleState({
      factoryStateRoot: store.factoryStateRoot,
      workItemKey: "linear:ENG-123",
      workspace,
    })?.factoryStage,
  ).toBe("ready-for-human");
});
