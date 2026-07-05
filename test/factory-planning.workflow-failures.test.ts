import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentRunInput, AgentSessionRef } from "../lib/agents.ts";
import { createFactoryPlanningRunContextForTest } from "../lib/factory-planning-run-context.ts";
import { run as runFactoryPlanning } from "../workflows/factory-planning.workflow.ts";
import {
  NEEDS_CHANGES_REVIEW,
  PASS_REVIEW,
  WORK_ITEM,
  createWorkspace,
  draft,
  okPlanner,
  writeReview,
} from "./factory-planning-test-helpers.ts";

test("factory planning preserves prior iteration when revision planner fails", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  const calls: AgentRunInput[] = [];
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    outputPlan: "dev/plans/260705-provider-fail.md",
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          calls.push(input);
          if (calls.length === 1) {
            return okPlanner(draft("provider-fail", "# Provider Fail Plan\n"), session);
          }
          return { ok: false, error: "planner crashed", exitCode: 1 };
        },
      };
    },
    async planReviewRunner(reviewCtx) {
      writeReview(reviewCtx, NEEDS_CHANGES_REVIEW);
      return {
        runId: reviewCtx.runId,
        runDir: reviewCtx.runDir,
        status: "completed",
        verdict: "needs_changes",
      };
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("planner crashed");
  expect(meta.iterations).toHaveLength(1);
  expect(meta.iterations[0]?.review).toMatchObject({ verdict: "needs_changes" });
  expect(existsSync(join(workspace, "dev/plans/260705-provider-fail.md"))).toBe(false);
});

test("factory planning maps failed plan-review to planning-failed", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    outputPlan: "dev/plans/260705-failed-review.md",
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return okPlanner(draft("failed-review", "# Failed Review Plan\n"), {
            provider: "cursor",
            id: "planner-session-1",
          });
        },
      };
    },
    async planReviewRunner(reviewCtx) {
      return { runId: reviewCtx.runId, runDir: reviewCtx.runDir, status: "failed" };
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toBe("plan-review failed");
  expect(meta.iterations).toHaveLength(1);
  expect(existsSync(join(workspace, "dev/plans/260705-failed-review.md"))).toBe(false);
});

test("factory planning maps thrown plan-review to planning-failed", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    outputPlan: "dev/plans/260705-thrown-review.md",
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return okPlanner(draft("thrown-review", "# Thrown Review Plan\n"), {
            provider: "cursor",
            id: "planner-session-1",
          });
        },
      };
    },
    async planReviewRunner() {
      throw new Error("review provider unavailable");
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toBe("plan-review failed: review provider unavailable");
  expect(meta.iterations).toHaveLength(1);
  expect(meta.iterations[0]?.review).toMatchObject({ status: "failed" });
  expect(existsSync(join(workspace, "dev/plans/260705-thrown-review.md"))).toBe(false);
});

test("factory planning allows explicit operator runs without triage metadata", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: { ...WORK_ITEM, metadata: undefined },
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    outputPlan: "dev/plans/260705-no-metadata-plan.md",
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return okPlanner(draft("no-metadata-plan", "# No Metadata Plan\n"), {
            provider: "cursor",
            id: "planner-session-1",
          });
        },
      };
    },
    async planReviewRunner(reviewCtx) {
      writeReview(reviewCtx, PASS_REVIEW);
      return {
        runId: reviewCtx.runId,
        runDir: reviewCtx.runDir,
        status: "completed",
        verdict: "pass",
      };
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-approved");
  expect(existsSync(join(workspace, "dev/plans/260705-no-metadata-plan.md"))).toBe(true);
});

test("factory planning derives final dev plan path when outputPlan is omitted", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return okPlanner(draft("Derived Plan", "# Derived Plan\n"), {
            provider: "cursor",
            id: "planner-session-1",
          });
        },
      };
    },
    async planReviewRunner(reviewCtx) {
      writeReview(reviewCtx, PASS_REVIEW);
      return {
        runId: reviewCtx.runId,
        runDir: reviewCtx.runDir,
        status: "completed",
        verdict: "pass",
      };
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-approved");
  expect(meta.outputPlan).toMatch(/\/dev\/plans\/\d{6}-derived-plan\.md$/);
  expect(existsSync(meta.outputPlan!)).toBe(true);
});

test("factory planning fails without overwriting an existing output plan", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const outputPlan = join(workspace, "dev/plans/260705-duplicate-plan.md");
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(outputPlan, "# Existing Plan\n", "utf8");
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    outputPlan,
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return okPlanner(draft("duplicate-plan", "# Replacement Plan\n"), {
            provider: "cursor",
            id: "planner-session-1",
          });
        },
      };
    },
    async planReviewRunner(reviewCtx) {
      writeReview(reviewCtx, PASS_REVIEW);
      return {
        runId: reviewCtx.runId,
        runDir: reviewCtx.runDir,
        status: "completed",
        verdict: "pass",
      };
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("Output plan already exists");
  expect(meta.iterations).toHaveLength(1);
  expect(readFileSync(outputPlan, "utf8")).toBe("# Existing Plan\n");
});

test("factory planning stops unresolved after max completed review iterations", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const calls: AgentRunInput[] = [];
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    outputPlan: "dev/plans/260705-unresolved-plan.md",
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          calls.push(input);
          return okPlanner(draft("unresolved-plan", "# Unresolved Plan\n"), session);
        },
      };
    },
    async planReviewRunner(reviewCtx) {
      writeReview(reviewCtx, NEEDS_CHANGES_REVIEW);
      return {
        runId: reviewCtx.runId,
        runDir: reviewCtx.runDir,
        status: "completed",
        verdict: "needs_changes",
      };
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-review-unresolved");
  expect(meta.error).toContain("max review iterations");
  expect(calls).toHaveLength(1);
  expect(readFileSync(join(ctx.runDir, "iterations/1/review-findings.json"), "utf8")).toContain(
    "spec-001",
  );
});

test("factory planning maps blocked plan-review to needs-human", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    outputPlan: "dev/plans/260705-blocked-plan.md",
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return okPlanner(draft("blocked-plan", "# Blocked Plan\n"), session);
        },
      };
    },
    async planReviewRunner(reviewCtx) {
      writeReview(reviewCtx, { ...NEEDS_CHANGES_REVIEW, verdict: "blocked" });
      return {
        runId: reviewCtx.runId,
        runDir: reviewCtx.runDir,
        status: "completed",
        verdict: "blocked",
      };
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-needs-human");
  expect(meta.humanQuestions).toEqual(["Plan review returned blocked."]);
  expect(meta.iterations[0]?.review).toMatchObject({ verdict: "blocked" });
});

test("factory planning fails before provider calls when triage handoff metadata is incompatible", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let providerCalls = 0;
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: {
      ...WORK_ITEM,
      metadata: { factoryRoute: "ready-to-implement", factoryNextAction: "implement-directly" },
    },
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      providerCalls += 1;
      return {
        name: options.provider,
        async run() {
          throw new Error("provider should not run");
        },
      };
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("factoryRoute must be ready-to-plan");
  expect(providerCalls).toBe(0);
  expect(existsSync(join(ctx.runDir, "meta.json"))).toBe(true);
});

test("factory planning rejects incompatible next action before provider construction", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let providerCalls = 0;
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: {
      ...WORK_ITEM,
      metadata: { factoryRoute: "ready-to-plan", factoryNextAction: "implement-directly" },
    },
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      providerCalls += 1;
      return {
        name: options.provider,
        async run() {
          throw new Error("provider should not run");
        },
      };
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("factoryNextAction must be create-plan");
  expect(providerCalls).toBe(0);
});
