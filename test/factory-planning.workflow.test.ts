import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentRunInput, AgentSessionRef } from "../lib/agents.ts";
import {
  createFactoryPlanningRunContextForTest,
  type FactoryPlanningReviewContext,
} from "../lib/factory-planning-run-context.ts";
import type { FactoryPlanningOutput } from "../lib/factory-planning-schemas.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";
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

test("factory planning dry-run writes placeholder artifacts without provider or reviewer calls", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let providerCalls = 0;
  let reviewCalls = 0;
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" },
    reviewerRole: { agent: "cursor" },
    dryRun: true,
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      providerCalls += 1;
      return {
        name: options.provider,
        async run() {
          throw new Error("dry-run should not call provider");
        },
      };
    },
    async planReviewRunner() {
      reviewCalls += 1;
      throw new Error("dry-run should not call plan-review");
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("dry_run");
  expect(meta.iterations).toHaveLength(1);
  expect(providerCalls).toBe(0);
  expect(reviewCalls).toBe(0);
  expect(existsSync(join(ctx.runDir, "events.jsonl"))).toBe(false);
  expect(readFileSync(join(ctx.runDir, "iterations/1/plan.md"), "utf8")).toContain("Dry Run Plan");
});

test("factory planning approves a reviewed plan and writes final dev plan", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const outputPlan = "dev/plans/260705-approved-plan.md";
  const calls: AgentRunInput[] = [];
  const reviews: FactoryPlanningReviewContext[] = [];
  const events: WorkflowEvent[] = [];
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  const planMarkdown = "# Approved Plan\n\nImplement the fix.\n";
  const plannerOutput = draft();
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor", model: "composer-2.5" },
    reviewerRole: { agent: "codex", model: "gpt-5.6-sol", modelReasoningEffort: "high" },
    outputPlan,
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    eventSink(event) {
      events.push(event);
    },
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          calls.push(input);
          writeDraftPlan(draftPath, planMarkdown);
          return okPlanner(plannerOutput, session);
        },
      };
    },
    async planReviewRunner(reviewCtx) {
      reviews.push(reviewCtx);
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
  expect(meta.outputPlan).toBe(join(workspace, outputPlan));
  expect(readFileSync(join(workspace, outputPlan), "utf8")).toBe(planMarkdown);
  expect(meta.iterations).toHaveLength(1);
  expect(meta.iterations[0]?.review).toMatchObject({ status: "completed", verdict: "pass" });
  expect(meta.plannerSession).toEqual(session);
  expect(meta.plannerAgent).toMatchObject({ name: "cursor", model: "composer-2.5" });
  expect(meta.reviewerAgent).toMatchObject({ name: "codex", model: "gpt-5.6-sol" });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.schemaPath).toMatch(/schemas\/factory-planning-output\.schema\.json$/);
  expect(calls[0]?.logPath).toBe(join(ctx.runDir, "iterations/1/planner.stream.jsonl"));
  expect(existsSync(join(ctx.runDir, "iterations/1"))).toBe(true);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]?.runDir).toContain(".harness/runs/reviews");
  expect(readFileSync(join(ctx.runDir, "summary.md"), "utf8")).toContain("plan-approved");
  expect(events.map((event) => event.type)).toContain("run:start");
  expect(events.map((event) => event.type)).toContain("run:end");
});

test("factory planning allows explicit operator runs without triage metadata", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let draftPath = "";
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
          writeDraftPlan(draftPath, "# No Metadata Plan\n");
          return okPlanner(draft(), { provider: "cursor", id: "planner-session-1" });
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
  expect(meta.outputPlan).toBe(join(workspace, "dev/plans/260705-no-metadata-plan.md"));
  expect(meta.factoryMetadata).toMatchObject({ factoryStage: "plan-approved" });
  expect(meta.factoryMetadata).not.toHaveProperty("approvedPlanPrUrl");
  expect(meta.factoryMetadata).not.toHaveProperty("approvedPlanCommit");
});

test("factory planning loops on needs_changes and resumes the same planner session", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  const calls: AgentRunInput[] = [];
  let reviewCount = 0;
  let draftPath = "";
  const planMarkdowns = [
    "# Loop Plan\n\nInitial draft.\n",
    "# Loop Plan\n\nRevised draft with tests.\n",
  ];
  const outputs = [
    draft(),
    {
      ...draft(),
      findingDecisions: [
        {
          findingId: "spec-001",
          decision: "implement",
          rationale: "The revised plan adds the missing regression test.",
        },
      ],
    },
  ] satisfies FactoryPlanningOutput[];
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor", model: "composer-2.5" },
    reviewerRole: { agent: "cursor", model: "composer-2.5" },
    outputPlan: "dev/plans/260705-loop-plan.md",
    maxReviewIterations: 3,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          calls.push(input);
          writeDraftPlan(draftPath, planMarkdowns[calls.length - 1] ?? "# Unexpected Plan\n");
          const output = outputs[calls.length - 1];
          if (!output) throw new Error("unexpected planner call");
          return okPlanner(output, session);
        },
      };
    },
    async planReviewRunner(reviewCtx) {
      reviewCount += 1;
      writeReview(reviewCtx, reviewCount === 1 ? NEEDS_CHANGES_REVIEW : PASS_REVIEW);
      return {
        runId: reviewCtx.runId,
        runDir: reviewCtx.runDir,
        status: "completed",
        verdict: reviewCount === 1 ? "needs_changes" : "pass",
      };
    },
  });
  draftPath = ctx.draftPath;

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-approved");
  expect(meta.iterations).toHaveLength(2);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.session).toBeUndefined();
  expect(calls[1]?.session).toEqual(session);
  expect(readFileSync(join(ctx.runDir, "iterations/1/review-findings.json"), "utf8")).toContain(
    "spec-001",
  );
  expect(readFileSync(join(ctx.runDir, "iterations/2/planner.json"), "utf8")).toContain(
    "findingDecisions",
  );
  expect(calls[1]?.prompt).not.toContain("Initial draft.");
});

test("factory planning needs-human skips plan-review and preserves planner iteration", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  let reviewCalls = 0;
  const humanOutput = {
    outcome: "needs-human",
    summary: "Need one product decision.",
    humanQuestions: ["Should export overwrite existing files?"],
    findingDecisions: [],
  } satisfies FactoryPlanningOutput;
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
          return okPlanner(humanOutput, { provider: "cursor", id: "planner-session-1" });
        },
      };
    },
    async planReviewRunner() {
      reviewCalls += 1;
      throw new Error("plan-review should not run");
    },
  });

  const meta = await runFactoryPlanning(ctx);

  expect(meta.status).toBe("plan-needs-human");
  expect(meta.humanQuestions).toEqual(["Should export overwrite existing files?"]);
  expect(meta.iterations).toEqual([{ index: 1 }]);
  expect(reviewCalls).toBe(0);
  expect(readFileSync(join(ctx.runDir, "iterations/1/planner.json"), "utf8")).toContain(
    "needs-human",
  );
});

test("factory planning allows revision turn to request human input", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  const calls: AgentRunInput[] = [];
  let draftPath = "";
  const revisionNeedsHuman = {
    outcome: "needs-human",
    summary: "Need a product decision before revising.",
    humanQuestions: ["Should the plan preserve backward compatibility?"],
    findingDecisions: [],
  } satisfies FactoryPlanningOutput;
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
        async run(input) {
          calls.push(input);
          if (calls.length === 1) {
            writeDraftPlan(draftPath, "# Initial Plan\n");
            return okPlanner(draft(), session);
          }
          return okPlanner(revisionNeedsHuman, session);
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

  expect(meta.status).toBe("plan-needs-human");
  expect(meta.humanQuestions).toEqual(["Should the plan preserve backward compatibility?"]);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.session).toEqual(session);
  expect(meta.iterations).toEqual([expect.objectContaining({ index: 1 }), { index: 2 }]);
});

test("factory planning fails when revision omits required finding decisions", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  const outputs = [draft(), draft()];
  let callCount = 0;
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
          const output = outputs[callCount];
          writeDraftPlan(draftPath, callCount === 0 ? "# Initial Plan\n" : "# Revised Plan\n");
          callCount += 1;
          if (!output) throw new Error("unexpected planner call");
          return okPlanner(output, session);
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
  expect(meta.error).toContain("Missing finding decision id: spec-001");
  expect(meta.iterations).toHaveLength(1);
  expect(meta.iterations[0]?.review).toMatchObject({ verdict: "needs_changes" });
});

test("factory planning fails when revision includes unknown finding decision", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  const outputs = [
    draft(),
    {
      ...draft(),
      findingDecisions: [
        { findingId: "spec-001", decision: "implement", rationale: "Covered." },
        { findingId: "spec-999", decision: "decline", rationale: "Unknown." },
      ],
    },
  ] satisfies FactoryPlanningOutput[];
  let callCount = 0;
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
          const output = outputs[callCount];
          writeDraftPlan(draftPath, callCount === 0 ? "# Initial Plan\n" : "# Revised Plan\n");
          callCount += 1;
          if (!output) throw new Error("unexpected planner call");
          return okPlanner(output, session);
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
  expect(meta.error).toContain("Unknown finding decision id: spec-999");
});

test("factory planning fails when revision duplicates finding decision", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const session = { provider: "cursor", id: "planner-session-1" } satisfies AgentSessionRef;
  const outputs = [
    draft(),
    {
      ...draft(),
      findingDecisions: [
        { findingId: "spec-001", decision: "implement", rationale: "Covered once." },
        { findingId: "spec-001", decision: "adapt", rationale: "Covered twice." },
      ],
    },
  ] satisfies FactoryPlanningOutput[];
  let callCount = 0;
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
          const output = outputs[callCount];
          writeDraftPlan(draftPath, callCount === 0 ? "# Initial Plan\n" : "# Revised Plan\n");
          callCount += 1;
          if (!output) throw new Error("unexpected planner call");
          return okPlanner(output, session);
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
  expect(meta.error).toContain("Duplicate finding decision id: spec-001");
});

test("factory planning fails when planner session is missing before revision", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-planning-runs-"));
  const calls: AgentRunInput[] = [];
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
        async run(input) {
          calls.push(input);
          writeDraftPlan(draftPath, "# Missing Session Plan\n");
          return okPlanner(draft());
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
  expect(meta.error).toContain("Planner session was not captured");
  expect(calls).toHaveLength(1);
});
