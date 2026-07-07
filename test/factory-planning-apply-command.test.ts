import { expect, test } from "vitest";
import { factoryPlanningCliOutput } from "../bin/factory-planning-cli.ts";
import { runFactoryPlanningWithLinearApply } from "../bin/factory-commands.ts";
import type {
  FactoryPlanningRunContext,
  FactoryPlanningRunMeta,
} from "../lib/factory-planning-run-context.ts";
import { fakeLinearAdapter } from "./factory-linear-test-helpers.ts";

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
