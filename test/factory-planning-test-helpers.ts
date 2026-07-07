import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRunResult, AgentSessionRef } from "../lib/agents.ts";
import type { FactoryPlanningReviewContext } from "../lib/factory-planning-run-context.ts";
import type { FactoryPlanningOutput } from "../lib/factory-planning-schemas.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import type { ReviewOutput } from "../lib/schemas.ts";

export const WORK_ITEM = {
  id: "item-1",
  source: "file",
  title: "Fix export crash",
  body: "Export crashes when the output directory is missing.",
  labels: ["bug"],
  metadata: {
    factoryRoute: "ready-to-plan",
    factoryNextAction: "create-plan",
  },
} satisfies FactoryWorkItem;

export const PASS_REVIEW = {
  verdict: "pass",
  summary: "Plan is ready.",
  findings: [],
} satisfies ReviewOutput;

export const NEEDS_CHANGES_REVIEW = {
  verdict: "needs_changes",
  summary: "Plan needs one correction.",
  findings: [
    {
      title: "Add a test gate",
      severity: "Medium",
      location: "Plan",
      issue: "The plan does not include regression test coverage.",
      recommendation: "Add a focused regression test step.",
      rationale: "The requested fix changes behavior.",
      must_fix: true,
    },
  ],
} satisfies ReviewOutput;

export function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "harness-factory-planning-workspace-"));
}

export function draft(overrides: Partial<FactoryPlanningOutput> = {}): FactoryPlanningOutput {
  return {
    outcome: "draft-ready",
    summary: "Plan is ready for review.",
    findingDecisions: [],
    ...overrides,
  };
}

export function writeDraftPlan(draftPath: string, planMarkdown: string): void {
  mkdirSync(dirname(draftPath), { recursive: true });
  writeFileSync(draftPath, planMarkdown, "utf8");
}

export function okPlanner(
  output: FactoryPlanningOutput,
  session?: AgentSessionRef,
): AgentRunResult {
  return {
    ok: true,
    structuredOutput: output,
    raw: { finalResponse: JSON.stringify(output) },
    ...(session ? { session } : {}),
  };
}

export function writeReview(ctx: FactoryPlanningReviewContext, review: ReviewOutput): void {
  writeFileSync(
    join(requiredRunDir(ctx), "spec-review.json"),
    JSON.stringify(review, null, 2),
    "utf8",
  );
  writeFileSync(join(requiredRunDir(ctx), "summary.md"), "# Review\n", "utf8");
}

function requiredRunDir(ctx: FactoryPlanningReviewContext): string {
  if (!ctx.runDir) throw new Error("review context runDir missing");
  return ctx.runDir;
}
