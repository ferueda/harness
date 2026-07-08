import { expect, test } from "vitest";
import { factoryPlanningCliOutput } from "../bin/factory-planning-cli.ts";
import type { FactoryPlanningRunMeta } from "../lib/factory-planning-run-context.ts";

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
  iterations: [{ index: 1, planPath: "/tmp/workspace/.harness/runs/factory/run-1/plan.md" }],
  plannerAgent: { name: "cursor", model: "composer-2.5" },
  reviewerAgent: { name: "cursor", model: "composer-2.5" },
  summaryPath: "/tmp/workspace/.harness/runs/factory/run-1/summary.md",
  metaPath: "/tmp/workspace/.harness/runs/factory/run-1/meta.json",
  startedAt: "2026-07-07T00:00:00.000Z",
  durationMs: 1,
} satisfies FactoryPlanningRunMeta;

test("factoryPlanningCliOutput omits linearApplied unless provided", () => {
  expect(factoryPlanningCliOutput(META)).not.toHaveProperty("linearApplied");
});

test("factoryPlanningCliOutput includes read-only Linear marker", () => {
  expect(factoryPlanningCliOutput(META, { linearApplied: false })).toMatchObject({
    linearApplied: false,
  });
});

test("factoryPlanningCliOutput includes Linear apply details", () => {
  expect(
    factoryPlanningCliOutput(META, {
      linearApplied: true,
      linearUpdate: {
        started: {
          issueIdentifier: "ENG-123",
          runId: "run-1",
          runDir: "/tmp/workspace/.harness/runs/factory/run-1",
          stage: "start",
          fromStatus: "Needs Plan",
          targetStatus: "Planning",
        },
        terminal: {
          issueIdentifier: "ENG-123",
          runId: "run-1",
          runDir: "/tmp/workspace/.harness/runs/factory/run-1",
          stage: "complete",
          fromStatus: "Planning",
          targetStatus: "Planning",
          commentMarker: "<!-- harness-factory:planning-apply:run-1 -->",
          commentBody: "Factory planning complete.",
        },
      },
    }),
  ).toMatchObject({
    linearApplied: true,
    linearUpdate: {
      started: { targetStatus: "Planning" },
      terminal: { targetStatus: "Planning" },
    },
  });
});
