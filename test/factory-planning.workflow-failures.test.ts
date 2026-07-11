import { execFileSync } from "node:child_process";
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
  writeDraftPlan,
  writeReview,
} from "./factory-planning-test-helpers.ts";

test("factory planning preserves prior iteration when revision planner fails", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  const calls: AgentRunInput[] = [];
  let draftPath = "";
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
            writeDraftPlan(draftPath, "# Provider Fail Plan\n");
            return okPlanner(draft(), session);
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
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("planner crashed");
  expect(meta.iterations).toHaveLength(2);
  expect(meta.iterations[0]?.review).toMatchObject({ verdict: "needs_changes" });
  expect(meta.iterations[1]).not.toHaveProperty("planPath");
  expect(existsSync(join(workspace, "dev/plans/260705-provider-fail.md"))).toBe(false);
});

test("factory planning maps failed plan-review to planning-failed", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
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
          writeDraftPlan(draftPath, "# Failed Review Plan\n");
          return okPlanner(draft(), {
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
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toBe("plan-review failed");
  expect(meta.iterations).toHaveLength(1);
  expect(existsSync(join(workspace, "dev/plans/260705-failed-review.md"))).toBe(false);
});

test("factory planning fails when planner does not write draft file", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return okPlanner(draft(), { provider: "cursor", id: "planner-session-1" });
        },
      };
    },
    async planReviewRunner() {
      throw new Error("plan-review should not run");
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("Planner did not write draft plan");
});

test("factory planning fails when planner writes empty draft file", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          writeFileSync(draftPath, "", "utf8");
          return okPlanner(draft(), { provider: "cursor", id: "planner-session-1" });
        },
      };
    },
    async planReviewRunner() {
      throw new Error("plan-review should not run");
    },
  });
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("Planner draft is empty");
});

test("factory planning fails when planner draft path is a directory", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          mkdirSync(draftPath);
          return okPlanner(draft(), { provider: "cursor", id: "planner-session-1" });
        },
      };
    },
    async planReviewRunner() {
      throw new Error("plan-review should not run");
    },
  });
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("Planner draft is not a file");
});

test("factory planning maps thrown plan-review to planning-failed", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
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
          writeDraftPlan(draftPath, "# Thrown Review Plan\n");
          return okPlanner(draft(), {
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
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toBe("plan-review failed: review provider unavailable");
  expect(meta.iterations).toHaveLength(1);
  expect(meta.iterations[0]?.review).toMatchObject({ status: "failed" });
  expect(existsSync(join(workspace, "dev/plans/260705-thrown-review.md"))).toBe(false);
});

test("factory planning derives final dev plan path when outputPlan is omitted", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
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
          writeDraftPlan(draftPath, "# Derived Plan\n");
          return okPlanner(draft(), {
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
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-approved");
  expect(meta.outputPlan).toMatch(/\/dev\/plans\/\d{6}-fix-export-crash\.md$/);
  expect(existsSync(meta.outputPlan!)).toBe(true);
});

test("factory planning includes tracker identity in derived plan path and metadata", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: {
      ...WORK_ITEM,
      id: "github:ferueda/harness#123",
      source: "github",
      metadata: {
        ...WORK_ITEM.metadata,
        tracker: {
          source: "github",
          id: "ferueda/harness#123",
          url: "https://github.com/ferueda/harness/issues/123",
        },
      },
    },
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          writeDraftPlan(draftPath, "# Tracker Plan\n");
          return okPlanner(draft(), {
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
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-approved");
  expect(meta.outputPlan).toBe(join(workspace, "dev/plans/GH-123.md"));
  expect(meta.factoryMetadata).toMatchObject({
    factoryRoute: "ready-to-plan",
    factoryNextAction: "create-plan",
    factoryStage: "plan-pr-open",
    factoryRunId: meta.runId,
    approvedPlanPath: "dev/plans/GH-123.md",
    tracker: {
      source: "github",
      id: "ferueda/harness#123",
      url: "https://github.com/ferueda/harness/issues/123",
    },
  });
});

test("factory planning derives Linear tracker plan path and keeps plan PR gate with output override", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: {
      ...WORK_ITEM,
      id: "linear:eng-123",
      source: "linear",
      metadata: {
        ...WORK_ITEM.metadata,
        tracker: {
          source: "linear",
          id: "eng-123",
          url: "https://linear.app/acme/issue/ENG-123",
        },
      },
    },
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    outputPlan: "dev/plans/custom-replan.md",
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          writeDraftPlan(draftPath, "# Linear Tracker Plan\n");
          return okPlanner(draft(), {
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
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-approved");
  expect(meta.outputPlan).toBe(join(workspace, "dev/plans/custom-replan.md"));
  expect(meta.factoryMetadata).toMatchObject({
    factoryStage: "plan-pr-open",
    approvedPlanPath: "dev/plans/custom-replan.md",
    tracker: {
      source: "linear",
      id: "eng-123",
    },
  });
});

test("factory planning derives default Linear tracker plan path", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: {
      ...WORK_ITEM,
      id: "linear:fer-123",
      source: "linear",
      metadata: {
        ...WORK_ITEM.metadata,
        tracker: {
          source: "linear",
          id: "fer-123",
          url: "https://linear.app/acme/issue/FER-123",
        },
      },
    },
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          writeDraftPlan(draftPath, "# Linear Default Tracker Plan\n");
          return okPlanner(draft(), {
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
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-approved");
  expect(meta.outputPlan).toBe(join(workspace, "dev/plans/FER-123.md"));
  expect(meta.factoryMetadata).toMatchObject({
    factoryStage: "plan-pr-open",
    approvedPlanPath: "dev/plans/FER-123.md",
    tracker: {
      source: "linear",
      id: "fer-123",
    },
  });
});

test("factory planning fails closed for invalid GitHub tracker path metadata", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: {
      ...WORK_ITEM,
      metadata: {
        ...WORK_ITEM.metadata,
        tracker: {
          source: "github",
          id: "repo#123",
        },
      },
    },
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          writeDraftPlan(draftPath, "# Invalid Tracker Plan\n");
          return okPlanner(draft(), {
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
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("Invalid GitHub tracker id for plan path");
  expect(existsSync(join(workspace, "dev/plans"))).toBe(false);
});

test("factory planning fails closed for unsupported tracker sources", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: {
      ...WORK_ITEM,
      metadata: {
        ...WORK_ITEM.metadata,
        tracker: {
          source: "jira",
          id: "PROJ-123",
        },
      },
    },
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          writeDraftPlan(draftPath, "# Unsupported Tracker Plan\n");
          return okPlanner(draft(), {
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
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("Unsupported tracker source for plan path: jira");
  expect(existsSync(join(workspace, "dev/plans"))).toBe(false);
});

test("factory planning fails without overwriting an existing output plan", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const outputPlan = join(workspace, "dev/plans/260705-duplicate-plan.md");
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(outputPlan, "# Existing Plan\n", "utf8");
  let draftPath = "";
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
          writeDraftPlan(draftPath, "# Replacement Plan\n");
          return okPlanner(draft(), {
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
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("Output plan already exists");
  expect(meta.iterations).toHaveLength(1);
  expect(readFileSync(outputPlan, "utf8")).toBe("# Existing Plan\n");
});

test("factory planning fails when planner mutates tracked workspace files", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  writeFileSync(join(workspace, "README.md"), "# Repo\n", "utf8");
  execFileSync("git", ["-C", workspace, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "add", "README.md"], { stdio: "ignore" });
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          writeDraftPlan(draftPath, "# Guarded Plan\n");
          writeFileSync(join(workspace, "README.md"), "# Mutated\n", "utf8");
          return okPlanner(draft(), { provider: "cursor", id: "planner-session-1" });
        },
      };
    },
    async planReviewRunner() {
      throw new Error("plan-review should not run");
    },
  });
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("Planner modified tracked workspace files");
  expect(
    JSON.parse(readFileSync(join(ctx.runDir, "iterations/1/planner.failure.json"), "utf8")),
  ).toMatchObject({ classification: "workspace-guard-failed" });
  expect(existsSync(join(workspace, "dev/plans"))).toBe(false);
});

test("factory planning stops unresolved after max completed review iterations", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const calls: AgentRunInput[] = [];
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  let draftPath = "";
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
          writeDraftPlan(draftPath, "# Unresolved Plan\n");
          return okPlanner(draft(), session);
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
  draftPath = ctx.draftPath;

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
  let draftPath = "";
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
          writeDraftPlan(draftPath, "# Blocked Plan\n");
          return okPlanner(draft(), session);
        },
      };
    },
    async planReviewRunner(reviewCtx) {
      writeReview(reviewCtx, {
        ...NEEDS_CHANGES_REVIEW,
        verdict: "blocked",
        summary: `Review mentioned ${draftPath}`,
        findings: [
          {
            ...NEEDS_CHANGES_REVIEW.findings[0]!,
            recommendation: `Avoid ${draftPath}`,
          },
        ],
      });
      return {
        runId: reviewCtx.runId,
        runDir: reviewCtx.runDir,
        status: "completed",
        verdict: "blocked",
      };
    },
  });
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-needs-human");
  expect(meta.humanQuestions).toEqual([
    `Plan review blocked: Review mentioned [planner-scratch]/draft.md`,
    "Add a test gate: Avoid [planner-scratch]/draft.md",
  ]);
  expect(meta.iterations[0]?.review).toMatchObject({ verdict: "blocked" });
  expect(JSON.stringify(meta)).not.toContain("factory-drafts");
  expect(readFileSync(join(ctx.runDir, "summary.md"), "utf8")).not.toContain("factory-drafts");
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
