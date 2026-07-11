import {
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  draft,
  okPlanner,
  writeDraftPlan,
  writeReview,
} from "./factory-planning-test-helpers.ts";

test("real planning loop publishes identical durable bytes and retains scratch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-fer61-smoke-workspace-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-smoke-runs-"));
  const reviewRunsDir = mkdtempSync(join(tmpdir(), "harness-fer61-smoke-reviews-"));
  const calls: AgentRunInput[] = [];
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    reviewRunsDir,
    workItem: { ...WORK_ITEM, id: "smoke-item", title: "Smoke planner artifact ownership" },
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    outputPlan: "dev/plans/smoke.md",
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          calls.push(input);
          writeDraftPlan(draftPath, "# Smoke Plan\n\n1. Preserve artifact ownership.\n");
          return okPlanner(draft(), { provider: "cursor", id: "smoke-session" });
        },
      };
    },
    async planReviewRunner(reviewContext) {
      writeReview(reviewContext, PASS_REVIEW);
      return {
        status: "completed",
        verdict: "pass",
        runId: reviewContext.runId,
        runDir: reviewContext.runDir,
      };
    },
  });
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);
  const snapshot = readFileSync(join(ctx.runDir, "iterations/1/plan.md"), "utf8");

  expect(meta.status).toBe("plan-approved");
  expect(calls).toHaveLength(1);
  expect(readFileSync(ctx.durableDraftPath, "utf8")).toBe(snapshot);
  expect(readFileSync(meta.outputPlan!, "utf8")).toBe(snapshot);
  expect(existsSync(ctx.draftPath)).toBe(true);
  expect(JSON.stringify(meta)).not.toContain("factory-drafts");
  expect(readFileSync(join(ctx.runDir, "summary.md"), "utf8")).not.toContain("factory-drafts");
});

test("non-publishable planner turns retain evidence without touching scratch", async () => {
  const cases = [
    {
      name: "provider failure",
      expected: "provider-failed",
      result: async () => ({
        ok: false as const,
        error: "provider failed in factory-drafts/draft.md",
        exitCode: 1,
        raw: { provider: true },
      }),
    },
    {
      name: "provider abort",
      expected: "provider-aborted",
      result: async () => ({
        ok: false as const,
        error: "aborted",
        exitCode: 130,
        aborted: true,
        raw: { aborted: true },
      }),
    },
    {
      name: "provider timeout",
      expected: "provider-timeout",
      result: async () => ({
        ok: false as const,
        error: "timed out",
        exitCode: 124,
        raw: { timeout: true },
      }),
    },
    {
      name: "structured output",
      expected: "structured-output-invalid",
      result: async () => ({ ok: true as const, structuredOutput: {}, raw: { malformed: true } }),
    },
    {
      name: "invocation throw",
      expected: "invocation-threw",
      result: async () => {
        throw new Error("invocation failed");
      },
    },
  ] as const;

  for (const item of cases) {
    const workspace = mkdtempSync(
      join(tmpdir(), `harness-fer61-${item.name.replaceAll(" ", "-")}-workspace-`),
    );
    const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-failure-runs-"));
    let reviewCalls = 0;
    const ctx = createFactoryPlanningRunContextForTest({
      workspace,
      runsDir,
      workItem: WORK_ITEM,
      plannerRole: { agent: "cursor" },
      reviewerRole: { agent: "cursor" },
      maxReviewIterations: 1,
      maxRuntimeMs: 1_000,
      testHooks: {
        beforeFinalScratchValidation: () => {
          throw new Error("failed planner turn must not validate scratch");
        },
        beforeScratchRead: () => {
          throw new Error("failed planner turn must not read scratch");
        },
      },
      agentProviderFactory(options) {
        return { name: options.provider, run: item.result };
      },
      async planReviewRunner() {
        reviewCalls += 1;
        throw new Error("review must not run");
      },
    });

    const meta = await runFactoryPlanning(ctx);
    const failure = JSON.parse(
      readFileSync(join(ctx.runDir, "iterations/1/planner.failure.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(meta.status).toBe("planning-failed");
    expect(failure.classification).toBe(item.expected);
    expect(reviewCalls).toBe(0);
    expect(existsSync(join(ctx.runDir, "iterations/1/plan.md"))).toBe(false);
    expect(existsSync(ctx.durableDraftPath)).toBe(false);
    expect(existsSync(ctx.scratchRunDir)).toBe(true);
    if (item.name === "provider failure") {
      expect(failure.raw).toEqual({ provider: true });
      expect(JSON.stringify(meta)).not.toContain("factory-drafts");
      expect(JSON.stringify(failure)).not.toContain("factory-drafts");
    }
  }
});

test("structured planner output cannot export scratch paths", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-fer61-structured-workspace-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-structured-runs-"));
  let ctx!: ReturnType<typeof createFactoryPlanningRunContextForTest>;
  ctx = createFactoryPlanningRunContextForTest({
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
          return {
            ok: true,
            structuredOutput: draft({ summary: ctx.draftPath }),
            raw: { "factory-drafts": { path: ctx.draftPath } },
          };
        },
      };
    },
  });

  const meta = await runFactoryPlanning(ctx);
  const failure = JSON.parse(
    readFileSync(join(ctx.runDir, "iterations/1/planner.failure.json"), "utf8"),
  ) as Record<string, unknown>;

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("forbidden scratch path");
  expect(failure).toMatchObject({ classification: "structured-output-invalid" });
  expect(failure.message).not.toContain("factory-drafts");
  expect(JSON.stringify(failure)).not.toContain("factory-drafts");
  expect(existsSync(join(ctx.runDir, "iterations/1/planner.json"))).toBe(false);
});

test("workflow classifies publication failures after preserving planner evidence", async () => {
  const cases = [
    {
      name: "stage",
      hooks: {
        stageFailure: () => {
          throw new Error("stage failed");
        },
      },
      expectedStage: "stage",
    },
    {
      name: "iteration-link",
      hooks: {
        linkFailure: () => {
          throw new Error("link failed");
        },
      },
      expectedStage: "iteration-link",
    },
    {
      name: "canonical-rename",
      hooks: {
        canonicalRenameFailure: () => {
          throw new Error("rename failed");
        },
      },
      expectedStage: "canonical-rename",
    },
    {
      name: "rollback",
      hooks: {
        canonicalRenameFailure: () => {
          throw new Error("rename failed");
        },
        rollbackFailure: () => {
          throw new Error("rollback failed");
        },
      },
      expectedStage: "rollback",
    },
  ] as const;

  for (const item of cases) {
    const workspace = mkdtempSync(join(tmpdir(), `harness-fer61-${item.name}-workspace-`));
    const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-publication-runs-"));
    let draftPath = "";
    let reviewCalls = 0;
    const ctx = createFactoryPlanningRunContextForTest({
      workspace,
      runsDir,
      workItem: WORK_ITEM,
      plannerRole: { agent: "cursor" },
      reviewerRole: { agent: "cursor" },
      maxReviewIterations: 1,
      maxRuntimeMs: 1_000,
      testHooks: item.hooks,
      agentProviderFactory(options) {
        return {
          name: options.provider,
          async run() {
            writeDraftPlan(draftPath, "# Publication failure\n");
            return okPlanner(draft());
          },
        };
      },
      async planReviewRunner() {
        reviewCalls += 1;
        throw new Error("review must not run");
      },
    });
    draftPath = ctx.draftPath;

    const meta = await runFactoryPlanning(ctx);
    const failure = JSON.parse(
      readFileSync(join(ctx.runDir, "iterations/1/planner.failure.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(meta.status).toBe("planning-failed");
    expect(meta.iterations).toEqual([{ index: 1 }]);
    expect(reviewCalls).toBe(0);
    expect(failure).toMatchObject({
      classification: "publication-failed",
      publicationStage: item.expectedStage,
    });
    expect(existsSync(join(ctx.runDir, "iterations/1/planner.json"))).toBe(true);
    expect(existsSync(ctx.durableDraftPath)).toBe(false);
  }
});

test("workflow rejects durable symlink parents before provider evidence writes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-fer61-parent-workspace-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-parent-runs-"));
  const outside = mkdtempSync(join(tmpdir(), "harness-fer61-parent-outside-"));
  let providerCalls = 0;
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
          providerCalls += 1;
          throw new Error("provider must not run");
        },
      };
    },
  });
  symlinkSync(outside, join(ctx.runDir, "iterations"));

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("planning-failed");
  expect(providerCalls).toBe(0);
  expect(existsSync(join(outside, "1", "planner.prompt.md"))).toBe(false);
  expect(JSON.stringify(meta)).not.toContain("factory-drafts");
});

test("workflow classifies a final draft symlink without publishing", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-fer61-final-symlink-workspace-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-final-symlink-runs-"));
  const outside = mkdtempSync(join(tmpdir(), "harness-fer61-final-symlink-outside-"));
  const externalDraft = join(outside, "draft.md");
  writeFileSync(externalDraft, "# External\n", "utf8");
  let draftPath = "";
  let reviewCalls = 0;
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    testHooks: {
      beforeScratchRead: () => {
        unlinkSync(draftPath);
        symlinkSync(externalDraft, draftPath);
      },
    },
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          writeDraftPlan(draftPath, "# Local\n");
          return okPlanner(draft());
        },
      };
    },
    async planReviewRunner() {
      reviewCalls += 1;
      throw new Error("review must not run");
    },
  });
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);
  const failure = JSON.parse(
    readFileSync(join(ctx.runDir, "iterations/1/planner.failure.json"), "utf8"),
  ) as Record<string, unknown>;

  expect(meta.status).toBe("planning-failed");
  expect(failure).toMatchObject({ classification: "draft-invalid", raw: { reason: "symlinked" } });
  expect(reviewCalls).toBe(0);
  expect(existsSync(ctx.durableDraftPath)).toBe(false);
  expect(existsSync(ctx.scratchRunDir)).toBe(true);
  expect(JSON.stringify(meta)).not.toContain("factory-drafts");
});

test("real planning loop revises the same scratch path and preserves snapshot one", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-fer61-smoke-workspace-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-smoke-runs-"));
  const session = { provider: "cursor", id: "smoke-session" } satisfies AgentSessionRef;
  let draftPath = "";
  let plannerCalls = 0;
  let reviewCalls = 0;
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    outputPlan: "dev/plans/smoke-revision.md",
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          plannerCalls += 1;
          writeDraftPlan(draftPath, plannerCalls === 1 ? "# One\n" : "# Two\n");
          return okPlanner(
            plannerCalls === 1
              ? draft()
              : draft({
                  findingDecisions: [
                    { findingId: "spec-001", decision: "implement", rationale: "Added coverage." },
                  ],
                }),
            session,
          );
        },
      };
    },
    async planReviewRunner(reviewContext) {
      reviewCalls += 1;
      writeReview(reviewContext, reviewCalls === 1 ? NEEDS_CHANGES_REVIEW : PASS_REVIEW);
      return {
        status: "completed",
        verdict: reviewCalls === 1 ? "needs_changes" : "pass",
        runId: reviewContext.runId,
        runDir: reviewContext.runDir,
      };
    },
  });
  draftPath = ctx.draftPath;
  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-approved");
  expect(plannerCalls).toBe(2);
  expect(readFileSync(join(ctx.runDir, "iterations/1/plan.md"), "utf8")).toBe("# One\n");
  expect(readFileSync(join(ctx.runDir, "iterations/2/plan.md"), "utf8")).toBe("# Two\n");
  expect(readFileSync(meta.outputPlan!, "utf8")).toBe("# Two\n");
  expect(ctx.draftPath).toBe(draftPath);
  expect(JSON.stringify(meta)).not.toContain("factory-drafts");
});

test("draft validation failure redacts scratch from Harness-rendered failure evidence", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-fer61-smoke-workspace-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-smoke-runs-"));
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
          return { ...okPlanner(draft()), raw: { diagnosticDraftPath: ctx.draftPath } };
        },
      };
    },
    async planReviewRunner() {
      throw new Error("review must not run");
    },
  });

  const meta = await runFactoryPlanning(ctx);
  const failure = JSON.parse(
    readFileSync(join(ctx.runDir, "iterations/1/planner.failure.json"), "utf8"),
  ) as Record<string, unknown>;
  const durableText = [
    JSON.stringify(meta),
    readFileSync(join(ctx.runDir, "summary.md"), "utf8"),
    readFileSync(join(ctx.runDir, "events.jsonl"), "utf8"),
    JSON.stringify(failure),
  ].join("\n");

  expect(meta.status).toBe("planning-failed");
  expect(meta.error).toContain("missing");
  expect(failure).toMatchObject({ classification: "draft-invalid", raw: { reason: "missing" } });
  expect(durableText).not.toContain("factory-drafts");
  expect(readFileSync(join(ctx.runDir, "iterations/1/planner.prompt.md"), "utf8")).toContain(
    ctx.draftPath,
  );
  expect(readFileSync(join(ctx.runDir, "iterations/1/planner.raw.json"), "utf8")).toContain(
    ctx.draftPath,
  );
});
