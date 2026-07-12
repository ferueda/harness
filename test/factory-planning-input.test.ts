import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  appendFactoryLifecycleEvent,
  resolveFactoryStateRoot,
} from "../lib/factory-lifecycle-legacy.ts";
import { assertFactoryPlanningLinearEntry } from "../lib/factory-planning-input.ts";
import { createFactoryPlanningRunContextForTest } from "../lib/factory-planning-run-context.ts";
import { resolveFactoryWorkItemInput } from "../lib/factory-triage-input.ts";
import { run as runFactoryPlanning } from "../workflows/factory-planning.workflow.ts";
import {
  fakeLinearAdapter,
  LINEAR_SETTINGS,
  LINEAR_WORK_ITEM,
} from "./factory-linear-test-helpers.ts";

test("Linear issue input can run through factory planning dry-run artifacts", async () => {
  for (const [factoryStage, linearStatus] of [
    ["ready-to-plan", "Needs Plan"],
    ["plan-needs-human", "Needs Clarification"],
    ["plan-review-unresolved", "Plan Needs Review"],
    ["planning-failed", "Planning Failed"],
  ] as const) {
    const workspace = mkdtempSync(join(tmpdir(), "harness-planning-input-"));
    const runsDir = mkdtempSync(join(tmpdir(), "harness-planning-runs-"));
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
              factoryStage,
              linearStatus,
            },
          }),
        }),
    });
    assertFactoryPlanningLinearEntry(input);

    const ctx = createFactoryPlanningRunContextForTest({
      workspace,
      runsDir,
      workItem: input.workItem,
      plannerRole: { agent: "cursor" },
      reviewerRole: { agent: "cursor" },
      dryRun: true,
      maxReviewIterations: 1,
      maxRuntimeMs: 1_000,
      agentProviderFactory(options) {
        return {
          name: options.provider,
          async run() {
            throw new Error("dry-run should not call provider");
          },
        };
      },
      async planReviewRunner() {
        throw new Error("dry-run should not call plan-review");
      },
    });

    const meta = await runFactoryPlanning(ctx);
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
      metadata: {
        factoryStage,
        linearProjectId: "project-1",
        linearProjectName: "Harness",
        linearStatus,
      },
    });
  }
});

test("Linear planning entry guard accepts only Linear input ready-to-plan states", () => {
  for (const [factoryStage, linearStatus] of [
    ["ready-to-plan", "Needs Plan"],
    ["plan-needs-human", "Needs Clarification"],
    ["plan-review-unresolved", "Plan Needs Review"],
    ["planning-failed", "Planning Failed"],
  ] as const) {
    expect(() =>
      assertFactoryPlanningLinearEntry({
        source: "linear",
        workItem: {
          ...LINEAR_WORK_ITEM,
          metadata: {
            ...LINEAR_WORK_ITEM.metadata,
            factoryStage,
            linearStatus,
          },
        },
      }),
    ).not.toThrow();
  }

  for (const [factoryStage, linearStatus] of [
    ["incoming", "Backlog"],
    ["ready-to-implement", "Ready to Implement"],
    ["needs-info", "Needs Clarification"],
    ["wait-to-implement", "Parked"],
    ["triaging", "Triaging"],
    ["planning", "Planning"],
  ] as const) {
    expect(() =>
      assertFactoryPlanningLinearEntry({
        source: "linear",
        workItem: {
          ...LINEAR_WORK_ITEM,
          metadata: {
            ...LINEAR_WORK_ITEM.metadata,
            factoryStage,
            linearStatus,
          },
        },
      }),
    ).toThrow(
      new RegExp(
        `${factoryStage}.*${linearStatus}.*Needs Plan, planning-question Needs Clarification, Plan Needs Review, or Planning Failed`,
      ),
    );
  }
});

test("Linear planning entry accepts lifecycle-derived plan-needs-human state", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-planning-input-"));
  const factoryStateRoot = resolveFactoryStateRoot({ workspace });
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: "work_item.imported:linear:ENG-123",
      type: "work_item.imported",
      workItemKey: "linear:ENG-123",
      occurredAt: "2026-07-08T00:00:00.000Z",
      source: "harness",
      data: {
        source: "linear",
        title: "Linear issue",
        tracker: { source: "linear", id: "ENG-123" },
      },
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: "planning.completed:planning-run-1",
      type: "planning.completed",
      workItemKey: "linear:ENG-123",
      occurredAt: "2026-07-08T00:01:00.000Z",
      runId: "planning-run-1",
      source: "harness",
      data: {
        status: "plan-needs-human",
        humanQuestions: ["Which direction should the plan take?"],
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
        fetchWorkItem: async () => LINEAR_WORK_ITEM,
      }),
  });

  expect(() => assertFactoryPlanningLinearEntry(input)).not.toThrow();
  expect(input.workItem.metadata).toMatchObject({
    factoryStage: "plan-needs-human",
    factoryRunId: "planning-run-1",
  });
});

test("Linear planning entry guard preserves item-file planning with Linear tracker metadata", () => {
  expect(() =>
    assertFactoryPlanningLinearEntry({
      source: "item-file",
      workItem: LINEAR_WORK_ITEM,
    }),
  ).not.toThrow();

  expect(() =>
    assertFactoryPlanningLinearEntry({
      source: "linear",
      workItem: LINEAR_WORK_ITEM,
    }),
  ).toThrow(
    /unknown.*Backlog.*Needs Plan, planning-question Needs Clarification, Plan Needs Review, or Planning Failed/,
  );
});

test("Linear planning entry guard rejects disallowed stages without touching runsDir", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-planning-input-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-planning-runs-"));
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
            factoryStage: "ready-to-implement",
            linearStatus: "Ready to Implement",
          },
        }),
      }),
  });
  const before = readdirSync(runsDir);

  expect(() => assertFactoryPlanningLinearEntry(input)).toThrow(
    /ready-to-implement.*Ready to Implement.*Needs Plan, planning-question Needs Clarification, Plan Needs Review, or Planning Failed/,
  );
  expect(readdirSync(runsDir)).toEqual(before);
});
