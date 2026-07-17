import { expect, test } from "vitest";
import type { FactoryPlanningRunMeta } from "../lib/factory-planning-run-context.ts";
import { renderFactoryPlanningSummary } from "../lib/factory-planning-summary.ts";

function planningMeta(overrides: Partial<FactoryPlanningRunMeta> = {}): FactoryPlanningRunMeta {
  return {
    runId: "run-1",
    workflow: "factory-planning",
    status: "plan-approved",
    workspace: "/workspace",
    runDir: "/runs/run-1",
    workItem: { id: "linear:FER-188", source: "linear", title: "Remove obsolete paths" },
    iterations: [],
    plannerAgent: { name: "codex", model: "gpt-5" },
    reviewerAgent: { name: "codex", model: "gpt-5" },
    summaryPath: "/runs/run-1/summary.md",
    metaPath: "/runs/run-1/meta.json",
    startedAt: "2026-07-17T02:00:00.000Z",
    durationMs: 42,
    ...overrides,
  };
}

test("renders planning handoff fields and next action exactly", () => {
  const summary = renderFactoryPlanningSummary(
    planningMeta({
      outputPlan: "/workspace/dev/plans/FER-188.md",
      factoryMetadata: {
        factoryStage: "plan-pr-open",
        approvedPlanPath: "dev/plans/FER-188.md",
        approvedPlanPrUrl: "https://github.com/example/harness/pull/188",
      },
    }),
  );

  expect(summary).toBe(`# Factory Planning

## Work item

- linear:FER-188: Remove obsolete paths

## Status

- plan-approved

## Output plan

- /workspace/dev/plans/FER-188.md

## Handoff

- Stage: plan-pr-open
- Approved plan path: dev/plans/FER-188.md
- Plan PR: https://github.com/example/harness/pull/188
- Approved plan commit: None
- Next action: Merge the plan PR, then register the commit with mark-plan-merged.

## Iterations

- None

## Human questions

- None

## Error

- None
`);
});

test("renders reviewed iterations and approved handoff exactly", () => {
  const summary = renderFactoryPlanningSummary(
    planningMeta({
      factoryMetadata: {
        factoryStage: "plan-approved",
        approvedPlanPath: "dev/plans/FER-188.md",
        approvedPlanCommit: "abc1234",
      },
      iterations: [
        {
          index: 1,
          planPath: "/runs/run-1/iterations/1/plan.md",
          review: {
            runId: "review-1",
            runDir: "/runs/reviews/review-1",
            status: "completed",
            verdict: "pass",
            specReviewPath: "/runs/reviews/review-1/spec-review.json",
          },
        },
      ],
    }),
  );

  expect(summary).toBe(`# Factory Planning

## Work item

- linear:FER-188: Remove obsolete paths

## Status

- plan-approved

## Output plan

- None

## Handoff

- Stage: plan-approved
- Approved plan path: dev/plans/FER-188.md
- Plan PR: None
- Approved plan commit: abc1234
- Next action: Ready to implement.

## Iterations

- 1: /runs/run-1/iterations/1/plan.md
  - Review: /runs/reviews/review-1
  - Findings: /runs/reviews/review-1/spec-review.json

## Human questions

- None

## Error

- None
`);
});

test("renders dry-run, questions, and error states exactly", () => {
  const summary = renderFactoryPlanningSummary(
    planningMeta({
      status: "dry_run",
      humanQuestions: ["Which target should be used?", "Who approves it?"],
      error: "provider unavailable",
    }),
  );

  expect(summary).toBe(`# Factory Planning

## Work item

- linear:FER-188: Remove obsolete paths

## Status

- dry_run

## Output plan

- None

## Handoff

- Stage: None
- Approved plan path: None
- Plan PR: None
- Approved plan commit: None
- Next action: None

## Iterations

- Dry-run placeholder; providers and reviewers were not called.

## Human questions

- Which target should be used?
- Who approves it?

## Error

- provider unavailable
`);
});
