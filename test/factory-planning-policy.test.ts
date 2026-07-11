import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveFactoryRoleAgent } from "../lib/config.ts";
import { createFactoryPlanningRunContextForTest } from "../lib/factory-planning-run-context.ts";
import { run as runFactoryPlanning } from "../workflows/factory-planning.workflow.ts";
import {
  PASS_REVIEW,
  WORK_ITEM,
  draft,
  okPlanner,
  writeDraftPlan,
  writeReview,
} from "./factory-planning-test-helpers.ts";

test("resolved default Codex planner receives workspace-write and effective never policy", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-fer61-policy-workspace-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-policy-runs-"));
  writeFileSync(join(workspace, "harness.json"), '{ "defaultAgent": "codex" }\n', "utf8");
  const plannerRole = resolveFactoryRoleAgent(
    { workspace, station: "planning", role: "planner" },
    "/",
  );
  const captured: Array<{
    workspace: string;
    sandboxMode?: string;
    approvalPolicy?: string;
    prompt: string;
  }> = [];
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole,
    reviewerRole: { agent: "cursor" },
    outputPlan: "dev/plans/policy.md",
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          captured.push(input);
          writeDraftPlan(draftPath, "# Policy plan\n");
          return okPlanner(draft(), { provider: "codex", id: "policy-session" });
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

  expect(meta.status).toBe("plan-approved");
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({
    workspace,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  expect(captured[0]?.sandboxMode).not.toBe("danger-full-access");
  expect(captured[0]?.prompt).toContain(ctx.draftPath);
  expect(captured[0]?.prompt).not.toContain(ctx.durableDraftPath);
});

test("explicit planning role policy overrides remain unchanged", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-fer61-policy-workspace-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-policy-runs-"));
  writeFileSync(
    join(workspace, "harness.json"),
    JSON.stringify({
      defaultAgent: "codex",
      factory: {
        planning: {
          roles: { planner: { sandboxMode: "read-only", approvalPolicy: "on-request" } },
        },
      },
    }),
    "utf8",
  );
  const plannerRole = resolveFactoryRoleAgent(
    { workspace, station: "planning", role: "planner" },
    "/",
  );
  const captured: Array<{ sandboxMode?: string; approvalPolicy?: string }> = [];
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole,
    reviewerRole: { agent: "cursor" },
    maxReviewIterations: 1,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          captured.push(input);
          writeDraftPlan(draftPath, "# Override\n");
          return okPlanner(draft(), { provider: "codex", id: "override-session" });
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
  await runFactoryPlanning(ctx);
  expect(captured[0]).toEqual(
    expect.objectContaining({ sandboxMode: "read-only", approvalPolicy: "on-request" }),
  );
});
