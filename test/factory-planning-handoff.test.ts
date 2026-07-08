import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  loadFactoryPlanningRunMeta,
  updateFactoryPlanningHandoff,
  validatePlannedWorkHandoff,
} from "../lib/factory-planning-handoff.ts";

function createPlanningRun() {
  const workspace = mkdtempSync(join(tmpdir(), "harness-planning-handoff-workspace-"));
  const runDir = mkdtempSync(join(tmpdir(), "harness-planning-handoff-run-"));
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(join(workspace, "dev/plans/FER-123.md"), "# Plan\n", "utf8");
  const meta = {
    runId: "20260707-120000",
    workflow: "factory-planning",
    status: "plan-approved",
    workspace,
    runDir,
    workItem: { id: "linear:FER-123", source: "linear", title: "Plan issue" },
    outputPlan: join(workspace, "dev/plans/FER-123.md"),
    factoryMetadata: {
      tracker: { source: "linear", id: "FER-123" },
      factoryStage: "plan-pr-open",
      approvedPlanPath: "dev/plans/FER-123.md",
    },
    iterations: [{ index: 1, planPath: join(runDir, "iterations/1/plan.md") }],
    plannerAgent: { name: "cursor", model: "composer-2.5" },
    reviewerAgent: { name: "cursor", model: "composer-2.5" },
    summaryPath: join(runDir, "summary.md"),
    metaPath: join(runDir, "meta.json"),
    startedAt: "2026-07-07T12:00:00.000Z",
    durationMs: 42,
  };
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  writeFileSync(join(runDir, "summary.md"), "# Old Summary\n", "utf8");
  return { workspace, runDir };
}

test("planning handoff publish and merge patch run metadata and summary", () => {
  const { runDir } = createPlanningRun();

  const published = updateFactoryPlanningHandoff(runDir, {
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    factoryStage: "plan-pr-open",
  });

  expect(published.factoryMetadata).toMatchObject({
    factoryStage: "plan-pr-open",
    approvedPlanPath: "dev/plans/FER-123.md",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
  });
  expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("mark-plan-merged");

  const merged = updateFactoryPlanningHandoff(runDir, {
    approvedPlanCommit: "abc1234",
    factoryStage: "plan-approved",
  });

  expect(merged.factoryMetadata).toMatchObject({
    factoryStage: "plan-approved",
    approvedPlanCommit: "abc1234",
  });
  expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("Ready to implement");
});

test("planning handoff rejects incompatible run metadata before writing", () => {
  const { runDir } = createPlanningRun();
  const before = readFileSync(join(runDir, "meta.json"), "utf8");

  expect(() =>
    updateFactoryPlanningHandoff(runDir, {
      approvedPlanPrUrl: "not a url",
      factoryStage: "plan-pr-open",
    }),
  ).toThrow(/Invalid plan PR URL/);
  expect(readFileSync(join(runDir, "meta.json"), "utf8")).toBe(before);
});

test("planning handoff rejects publish after merge without mutating metadata", () => {
  const { runDir } = createPlanningRun();
  updateFactoryPlanningHandoff(runDir, {
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    factoryStage: "plan-pr-open",
  });
  updateFactoryPlanningHandoff(runDir, {
    approvedPlanCommit: "abc1234",
    factoryStage: "plan-approved",
  });
  const before = readFileSync(join(runDir, "meta.json"), "utf8");

  expect(() =>
    updateFactoryPlanningHandoff(runDir, {
      approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
      factoryStage: "plan-pr-open",
    }),
  ).toThrow(/already has approvedPlanCommit/);
  expect(readFileSync(join(runDir, "meta.json"), "utf8")).toBe(before);
});

test("planning handoff rejects empty commit and mark before publish", () => {
  const { runDir } = createPlanningRun();

  expect(() =>
    updateFactoryPlanningHandoff(runDir, {
      approvedPlanCommit: "",
      factoryStage: "plan-approved",
    }),
  ).toThrow(/approvedPlanCommit must be non-empty/);

  expect(() =>
    updateFactoryPlanningHandoff(runDir, {
      approvedPlanCommit: "abc1234",
      factoryStage: "plan-approved",
    }),
  ).toThrow(/missing approvedPlanPrUrl/);
});

test("planning handoff rejects publication for local manual runs", () => {
  const { runDir } = createPlanningRun();
  const meta = loadFactoryPlanningRunMeta(runDir);
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        ...meta,
        factoryMetadata: {
          factoryStage: "plan-approved",
          approvedPlanPath: "dev/plans/FER-123.md",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  expect(() =>
    updateFactoryPlanningHandoff(runDir, {
      approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
      factoryStage: "plan-pr-open",
    }),
  ).toThrow(/requires tracker-backed metadata/);
});

test("planned work handoff validation fails closed until plan is approved and present", () => {
  const { workspace, runDir } = createPlanningRun();
  const published = updateFactoryPlanningHandoff(runDir, {
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    factoryStage: "plan-pr-open",
  });

  expect(() => validatePlannedWorkHandoff(published.factoryMetadata!, workspace)).toThrow(
    /not ready to implement/,
  );

  const merged = updateFactoryPlanningHandoff(runDir, {
    approvedPlanCommit: "abc1234",
    factoryStage: "plan-approved",
  });

  expect(validatePlannedWorkHandoff(merged.factoryMetadata!, workspace)).toMatchObject({
    planPath: join(workspace, "dev/plans/FER-123.md"),
    approvedPlanCommit: "abc1234",
  });
  expect(existsSync(join(workspace, "dev/plans/FER-123.md"))).toBe(true);
});

test("loadFactoryPlanningRunMeta validates required meta shape", () => {
  const runDir = mkdtempSync(join(tmpdir(), "harness-planning-handoff-invalid-"));
  writeFileSync(join(runDir, "meta.json"), JSON.stringify({ workflow: "factory-planning" }));

  expect(() => loadFactoryPlanningRunMeta(runDir)).toThrow(/Invalid factory planning meta/);
});
