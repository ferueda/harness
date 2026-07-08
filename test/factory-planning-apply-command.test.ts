import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryPlanningCliOutput } from "../bin/factory-planning-cli.ts";
import {
  runFactoryPlanningPublicationWithLinearApply,
  runFactoryPlanningWithLinearApply,
} from "../bin/factory-commands.ts";
import {
  deriveFactoryWorkItemKey,
  loadFactoryLifecycleState,
  resolveFactoryStateRoot,
} from "../lib/factory-lifecycle.ts";
import type {
  FactoryPlanningRunContext,
  FactoryPlanningRunMeta,
} from "../lib/factory-planning-run-context.ts";
import { fakeLinearAdapter, LINEAR_SETTINGS } from "./factory-linear-test-helpers.ts";

const CTX = {
  runId: "run-1",
  runDir: "/tmp/workspace/.harness/runs/factory/run-1",
} as FactoryPlanningRunContext;

const META = {
  runId: "run-1",
  workflow: "factory-planning",
  status: "plan-approved",
  workspace: "/tmp/workspace",
  runDir: "/tmp/workspace/.harness/runs/factory/run-1",
  workItem: {
    id: "linear:ENG-123",
    source: "linear",
    title: "Linear issue",
  },
  outputPlan: "/tmp/workspace/dev/plans/ENG-123.md",
  factoryMetadata: {
    tracker: { source: "linear", id: "ENG-123" },
    factoryStage: "plan-pr-open",
    approvedPlanPath: "dev/plans/ENG-123.md",
  },
  iterations: [{ index: 1 }],
  plannerAgent: { name: "cursor", model: "composer-2.5" },
  reviewerAgent: { name: "cursor", model: "composer-2.5" },
  summaryPath: "/tmp/workspace/.harness/runs/factory/run-1/summary.md",
  metaPath: "/tmp/workspace/.harness/runs/factory/run-1/meta.json",
  startedAt: "2026-07-07T00:00:00.000Z",
  durationMs: 1,
} satisfies FactoryPlanningRunMeta;

function createPublicationRun(
  input: {
    trackerSource?: "linear" | "github";
    trackerId?: string;
  } = {},
) {
  const workspace = mkdtempSync(join(tmpdir(), "harness-planning-publication-workspace-"));
  const runDir = mkdtempSync(join(tmpdir(), "harness-planning-publication-run-"));
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(join(workspace, "dev/plans/ENG-123.md"), "# Plan\n", "utf8");
  const meta = {
    ...META,
    workspace,
    runDir,
    outputPlan: join(workspace, "dev/plans/ENG-123.md"),
    factoryMetadata: {
      tracker: {
        source: input.trackerSource ?? "linear",
        id: input.trackerId ?? "ENG-123",
      },
      factoryStage: "plan-pr-open",
      approvedPlanPath: "dev/plans/ENG-123.md",
    },
    summaryPath: join(runDir, "summary.md"),
    metaPath: join(runDir, "meta.json"),
  } satisfies FactoryPlanningRunMeta;
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  writeFileSync(join(runDir, "summary.md"), "# Old Summary\n", "utf8");
  return { workspace, runDir };
}

test("planning apply returns started and terminal updates on success", async () => {
  const completedInputs: unknown[] = [];
  const adapter = fakeLinearAdapter({
    applyPlanningStarted: async () => ({
      issueIdentifier: "ENG-123",
      runId: "run-1",
      runDir: CTX.runDir,
      stage: "start",
      fromStatus: "Needs Plan",
      targetStatus: "Planning",
    }),
    applyPlanningCompleted: async (input) => {
      completedInputs.push(input);
      return {
        issueIdentifier: "ENG-123",
        runId: "run-1",
        runDir: CTX.runDir,
        stage: "complete",
        fromStatus: "Planning",
        targetStatus: "Planning",
      };
    },
  });

  const result = await runFactoryPlanningWithLinearApply({
    ctx: CTX,
    issueRef: "ENG-123",
    applyAdapter: adapter,
    runPlanning: async () => META,
  });

  expect(completedInputs).toEqual([
    {
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: CTX.runDir,
      status: "plan-approved",
      approvedPlanPath: "dev/plans/ENG-123.md",
      humanQuestions: undefined,
      error: undefined,
    },
  ]);
  expect(result).toMatchObject({
    meta: { runId: "run-1", status: "plan-approved" },
    linearUpdate: {
      started: { stage: "start", targetStatus: "Planning" },
      terminal: { stage: "complete", targetStatus: "Planning" },
    },
  });
  expect(result.terminalApplyError).toBeUndefined();
});

test("planning apply cleanup preserves original planning error", async () => {
  const failedInputs: unknown[] = [];
  const adapter = fakeLinearAdapter({
    applyPlanningStarted: async () => ({
      issueIdentifier: "ENG-123",
      runId: "run-1",
      runDir: CTX.runDir,
      stage: "start",
      fromStatus: "Needs Plan",
      targetStatus: "Planning",
    }),
    applyPlanningFailed: async (input) => {
      failedInputs.push(input);
      throw new Error("Linear cleanup failed");
    },
  });

  await expect(
    runFactoryPlanningWithLinearApply({
      ctx: CTX,
      issueRef: "ENG-123",
      applyAdapter: adapter,
      runPlanning: async () => {
        throw new Error("Planner exploded");
      },
    }),
  ).rejects.toThrow(/Planner exploded/);

  expect(failedInputs).toEqual([
    {
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: CTX.runDir,
      error: "Planner exploded",
    },
  ]);
});

test("planning apply cleanup calls failed apply after planning error", async () => {
  const failedInputs: unknown[] = [];
  const adapter = fakeLinearAdapter({
    applyPlanningStarted: async () => ({
      issueIdentifier: "ENG-123",
      runId: "run-1",
      runDir: CTX.runDir,
      stage: "start",
      fromStatus: "Needs Plan",
      targetStatus: "Planning",
    }),
    applyPlanningFailed: async (input) => {
      failedInputs.push(input);
      return {
        issueIdentifier: "ENG-123",
        runId: "run-1",
        runDir: CTX.runDir,
        stage: "failed",
        fromStatus: "Planning",
        targetStatus: "Planning Failed",
      };
    },
  });

  await expect(
    runFactoryPlanningWithLinearApply({
      ctx: CTX,
      issueRef: "ENG-123",
      applyAdapter: adapter,
      runPlanning: async () => {
        throw new Error("Planner exploded");
      },
    }),
  ).rejects.toThrow(/Planner exploded/);

  expect(failedInputs).toEqual([
    {
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: CTX.runDir,
      error: "Planner exploded",
    },
  ]);
});

test("planning terminal apply failure keeps local metadata printable", async () => {
  const adapter = fakeLinearAdapter({
    applyPlanningStarted: async () => ({
      issueIdentifier: "ENG-123",
      runId: "run-1",
      runDir: CTX.runDir,
      stage: "start",
      fromStatus: "Needs Plan",
      targetStatus: "Planning",
    }),
    applyPlanningCompleted: async () => {
      throw new Error("Linear terminal update failed");
    },
  });

  const result = await runFactoryPlanningWithLinearApply({
    ctx: CTX,
    issueRef: "ENG-123",
    applyAdapter: adapter,
    runPlanning: async () => META,
  });
  const output = factoryPlanningCliOutput(result.meta, {
    linearApplied: true,
    linearUpdate: result.linearUpdate,
  });

  expect(result.terminalApplyError).toBeInstanceOf(Error);
  expect((result.terminalApplyError as Error).message).toBe("Linear terminal update failed");
  expect(output).toMatchObject({
    runId: "run-1",
    status: "plan-approved",
    linearApplied: true,
    linearUpdate: {
      started: { targetStatus: "Planning" },
    },
  });
  expect(output.linearUpdate?.terminal).toBeUndefined();
});

test("planning publication apply returns terminal Linear update", async () => {
  const { runDir } = createPublicationRun();
  const publishedInputs: unknown[] = [];

  const result = await runFactoryPlanningPublicationWithLinearApply({
    mode: "publish",
    runDir,
    issueRef: "eng-123",
    prUrl: "https://github.com/owner/repo/pull/123",
    apply: true,
    env: { LINEAR_API_KEY: "test-key" },
    resolveLinearSettings: () => LINEAR_SETTINGS,
    adapterFactory: () =>
      fakeLinearAdapter({
        applyPlanningPublished: async (input) => {
          publishedInputs.push(input);
          return {
            issueIdentifier: "ENG-123",
            runId: "run-1",
            runDir,
            stage: "publish",
            fromStatus: "Needs Plan",
            targetStatus: "Plan Needs Review",
            commentMarker: "<!-- harness-factory:planning:run-1 -->",
            commentBody: "Factory plan ready.",
          };
        },
      }),
  });

  expect(publishedInputs).toEqual([
    {
      issueRef: "eng-123",
      runId: "run-1",
      runDir,
      approvedPlanPath: "dev/plans/ENG-123.md",
      approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    },
  ]);
  expect(result.output).toMatchObject({
    linearApplied: true,
    linearUpdate: { terminal: { stage: "publish", targetStatus: "Plan Needs Review" } },
    factoryMetadata: {
      factoryStage: "plan-pr-open",
      approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    },
  });
  expect(
    loadFactoryLifecycleState({
      factoryStateRoot: resolveFactoryStateRoot({ workspace: result.output.workspace }),
      workItemKey: deriveFactoryWorkItemKey({
        id: "linear:ENG-123",
        source: "linear",
        title: "Linear issue",
        body: "",
        labels: [],
        metadata: result.output.factoryMetadata,
      }),
    }),
  ).toMatchObject({
    factoryStage: "plan-pr-open",
    approvedPlanPath: "dev/plans/ENG-123.md",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
  });
  expect(result.terminalApplyError).toBeUndefined();
});

test("planning mark-merged apply returns terminal Linear update", async () => {
  const { runDir } = createPublicationRun();
  await runFactoryPlanningPublicationWithLinearApply({
    mode: "publish",
    runDir,
    prUrl: "https://github.com/owner/repo/pull/123",
    apply: false,
  });

  const result = await runFactoryPlanningPublicationWithLinearApply({
    mode: "mark-plan-merged",
    runDir,
    issueRef: "ENG-123",
    commit: "abc1234",
    apply: true,
    env: { LINEAR_API_KEY: "test-key" },
    resolveLinearSettings: () => LINEAR_SETTINGS,
    adapterFactory: () =>
      fakeLinearAdapter({
        applyPlanningMerged: async () => ({
          issueIdentifier: "ENG-123",
          runId: "run-1",
          runDir,
          stage: "merged",
          fromStatus: "Plan Needs Review",
          targetStatus: "Ready to Implement",
          commentMarker: "<!-- harness-factory:planning-approved:run-1 -->",
          commentBody: "Factory plan approved.",
        }),
      }),
  });

  expect(result.output).toMatchObject({
    linearApplied: true,
    linearUpdate: { terminal: { stage: "merged", targetStatus: "Ready to Implement" } },
    factoryMetadata: {
      factoryStage: "plan-approved",
      approvedPlanCommit: "abc1234",
    },
  });
  expect(
    loadFactoryLifecycleState({
      factoryStateRoot: resolveFactoryStateRoot({ workspace: result.output.workspace }),
      workItemKey: deriveFactoryWorkItemKey({
        id: "linear:ENG-123",
        source: "linear",
        title: "Linear issue",
        body: "",
        labels: [],
        metadata: result.output.factoryMetadata,
      }),
    }),
  ).toMatchObject({
    factoryStage: "plan-approved",
    approvedPlanPath: "dev/plans/ENG-123.md",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    approvedPlanCommit: "abc1234",
  });
});

test("planning publication apply rejects mismatched Linear issue before metadata write", async () => {
  const { runDir } = createPublicationRun();

  await expect(
    runFactoryPlanningPublicationWithLinearApply({
      mode: "publish",
      runDir,
      issueRef: "ENG-999",
      prUrl: "https://github.com/owner/repo/pull/123",
      apply: true,
      env: { LINEAR_API_KEY: "test-key" },
      resolveLinearSettings: () => LINEAR_SETTINGS,
      adapterFactory: () => fakeLinearAdapter(),
    }),
  ).rejects.toThrow(/does not match planning run tracker ENG-123/);

  expect(readFileSync(join(runDir, "meta.json"), "utf8")).not.toContain("approvedPlanPrUrl");
});

test("planning publication apply rejects missing Linear issue before metadata write", async () => {
  const { runDir } = createPublicationRun();

  await expect(
    runFactoryPlanningPublicationWithLinearApply({
      mode: "publish",
      runDir,
      prUrl: "https://github.com/owner/repo/pull/123",
      apply: true,
      env: { LINEAR_API_KEY: "test-key" },
      resolveLinearSettings: () => LINEAR_SETTINGS,
      adapterFactory: () => fakeLinearAdapter(),
    }),
  ).rejects.toThrow(/--apply requires --linear-issue/);

  expect(readFileSync(join(runDir, "meta.json"), "utf8")).not.toContain("approvedPlanPrUrl");
});

test("planning publication apply rejects missing Linear API key before metadata write", async () => {
  const { runDir } = createPublicationRun();

  await expect(
    runFactoryPlanningPublicationWithLinearApply({
      mode: "publish",
      runDir,
      issueRef: "ENG-123",
      prUrl: "https://github.com/owner/repo/pull/123",
      apply: true,
      env: { LINEAR_API_KEY: "" },
      resolveLinearSettings: () => LINEAR_SETTINGS,
      adapterFactory: () => fakeLinearAdapter(),
    }),
  ).rejects.toThrow(/LINEAR_API_KEY is required/);

  expect(readFileSync(join(runDir, "meta.json"), "utf8")).not.toContain("approvedPlanPrUrl");
});

test("planning publication apply rejects missing Linear config before metadata write", async () => {
  const { runDir } = createPublicationRun();

  await expect(
    runFactoryPlanningPublicationWithLinearApply({
      mode: "publish",
      runDir,
      issueRef: "ENG-123",
      prUrl: "https://github.com/owner/repo/pull/123",
      apply: true,
      env: { LINEAR_API_KEY: "test-key" },
      adapterFactory: () => fakeLinearAdapter(),
    }),
  ).rejects.toThrow(/factory\.linear is required/);

  expect(readFileSync(join(runDir, "meta.json"), "utf8")).not.toContain("approvedPlanPrUrl");
});

test("planning publication apply rejects non-Linear tracker before metadata write", async () => {
  const { runDir } = createPublicationRun({ trackerSource: "github", trackerId: "owner/repo#1" });

  await expect(
    runFactoryPlanningPublicationWithLinearApply({
      mode: "publish",
      runDir,
      issueRef: "ENG-123",
      prUrl: "https://github.com/owner/repo/pull/123",
      apply: true,
      env: { LINEAR_API_KEY: "test-key" },
      resolveLinearSettings: () => LINEAR_SETTINGS,
      adapterFactory: () => fakeLinearAdapter(),
    }),
  ).rejects.toThrow(/requires linear tracker metadata/);

  expect(readFileSync(join(runDir, "meta.json"), "utf8")).not.toContain("approvedPlanPrUrl");
});

test("planning publication terminal apply failure prints local metadata as not applied", async () => {
  const { runDir } = createPublicationRun();

  const result = await runFactoryPlanningPublicationWithLinearApply({
    mode: "publish",
    runDir,
    issueRef: "ENG-123",
    prUrl: "https://github.com/owner/repo/pull/123",
    apply: true,
    env: { LINEAR_API_KEY: "test-key" },
    resolveLinearSettings: () => LINEAR_SETTINGS,
    adapterFactory: () =>
      fakeLinearAdapter({
        applyPlanningPublished: async () => {
          throw new Error("Linear terminal update failed");
        },
      }),
  });

  expect(result.terminalApplyError).toBeInstanceOf(Error);
  expect(result.output).toMatchObject({
    linearApplied: false,
    factoryMetadata: {
      factoryStage: "plan-pr-open",
      approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    },
  });
  expect(readFileSync(join(runDir, "meta.json"), "utf8")).toContain("approvedPlanPrUrl");
});
