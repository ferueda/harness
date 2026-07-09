import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  FACTORY_IMPLEMENTATION_DRY_RUN_ERROR,
  createFactoryImplementationRunContextForTest,
} from "../lib/factory-implementation-run-context.ts";
import type { FactoryImplementationInput } from "../lib/factory-implementation-input.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import { run as runFactoryImplementation } from "../workflows/factory-implementation.workflow.ts";

const WORK_ITEM = {
  id: "linear:FER-47",
  source: "linear",
  title: "Add factory implementation station shell",
  body: "Build the dry-run shell.",
  url: "https://linear.app/acme/issue/FER-47",
  labels: ["factory"],
  metadata: {
    tracker: { source: "linear", id: "FER-47", url: "https://linear.app/acme/issue/FER-47" },
  },
} satisfies FactoryWorkItem;

test("planned dry-run writes implementation artifacts without events", async () => {
  const workspace = createWorkspaceWithPlan();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const input = plannedInput(workspace);
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    implementationInput: input,
    implementerRole: { agent: "codex", model: "gpt-5.5", modelReasoningEffort: "high" },
    dryRun: true,
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta).toMatchObject({
    workflow: "factory-implementation",
    status: "dry_run",
    mode: "planned",
    workItem: { id: "linear:FER-47", source: "linear" },
    implementerAgent: { name: "codex", model: "gpt-5.5", modelReasoningEffort: "high" },
    artifacts: {
      workItem: "context/work-item.json",
      implementationInput: "context/implementation-input.json",
      planRef: "context/plan-ref.json",
      prompt: "implementation/prompt.md",
      changeReviewHandoff: "implementation/change-review-handoff.md",
      summary: "summary.md",
      meta: "meta.json",
    },
  });
  expect(existsSync(join(ctx.runDir, "context/source-material.json"))).toBe(false);
  expect(existsSync(join(ctx.runDir, "events.jsonl"))).toBe(false);
  expect(readJson(join(ctx.runDir, "context/plan-ref.json"))).toMatchObject({
    approvedPlanPath: "dev/plans/FER-47.md",
    planPath: join(workspace, "dev/plans/FER-47.md"),
    approvedPlanCommit: "abc1234",
  });
  const prompt = readFileSync(join(ctx.runDir, "implementation/prompt.md"), "utf8");
  expect(prompt).toContain("Follow the approved plan");
  expect(prompt).toContain("provenance/readiness marker");
  const summary = readFileSync(join(ctx.runDir, "summary.md"), "utf8");
  expect(summary).toContain("Approved plan path: dev/plans/FER-47.md");
  expect(summary).toContain("Approved plan commit: abc1234");
  const handoff = readFileSync(join(ctx.runDir, "implementation/change-review-handoff.md"), "utf8");
  expectHandoffModel(handoff);
  expect(handoff).toContain("_To be filled after implementation._");
  expect(handoff).toContain("_Not run yet._");
});

test("direct dry-run writes source material artifacts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-implementation-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const input = directInput();
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    implementationInput: input,
    implementerRole: { agent: "cursor", model: "composer-2.5" },
    dryRun: true,
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.mode).toBe("direct");
  expect(meta.artifacts).toMatchObject({ sourceMaterial: "context/source-material.json" });
  expect(existsSync(join(ctx.runDir, "context/plan-ref.json"))).toBe(false);
  expect(existsSync(join(ctx.runDir, "events.jsonl"))).toBe(false);
  expect(readJson(join(ctx.runDir, "context/source-material.json"))).toMatchObject({
    title: "Add factory implementation station shell",
    body: "Build the dry-run shell.",
    labels: ["factory"],
    url: "https://linear.app/acme/issue/FER-47",
    tracker: { source: "linear", id: "FER-47" },
  });
  const prompt = readFileSync(join(ctx.runDir, "implementation/prompt.md"), "utf8");
  expect(prompt).toContain("Mode: direct");
  expect(prompt).toContain("Build the dry-run shell.");
  expect(prompt).toContain("linear");
  const handoff = readFileSync(join(ctx.runDir, "implementation/change-review-handoff.md"), "utf8");
  expect(handoff).toContain("- Labels: factory");
  expect(handoff).toContain("- Body excerpt: Build the dry-run shell.");
  expect(handoff).toContain("- Tracker:");
  const summary = readFileSync(join(ctx.runDir, "summary.md"), "utf8");
  expect(summary).toContain("Source title: Add factory implementation station shell");
  expect(summary).toContain("Tracker:");
});

test("non-dry-run implementation workflow fails before provider support exists", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-implementation-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createFactoryImplementationRunContextForTest({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    implementationInput: directInput(),
    implementerRole: { agent: "cursor" },
    dryRun: false,
  });

  await expect(runFactoryImplementation(ctx)).rejects.toThrow(FACTORY_IMPLEMENTATION_DRY_RUN_ERROR);
});

function createWorkspaceWithPlan(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-implementation-"));
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(join(workspace, "dev/plans/FER-47.md"), "# Plan\n", "utf8");
  return workspace;
}

function plannedInput(workspace: string): FactoryImplementationInput {
  return {
    mode: "planned",
    source: "linear",
    workItem: WORK_ITEM,
    metadata: {
      tracker: { source: "linear", id: "FER-47", url: "https://linear.app/acme/issue/FER-47" },
      factoryStage: "plan-approved",
      approvedPlanPath: "dev/plans/FER-47.md",
      approvedPlanCommit: "abc1234",
    },
    approvedPlanPath: "dev/plans/FER-47.md",
    planPath: join(workspace, "dev/plans/FER-47.md"),
    approvedPlanCommit: "abc1234",
  };
}

function directInput(): FactoryImplementationInput {
  return {
    mode: "direct",
    source: "linear",
    workItem: WORK_ITEM,
    metadata: {
      tracker: { source: "linear", id: "FER-47", url: "https://linear.app/acme/issue/FER-47" },
      factoryStage: "ready-to-implement",
      factoryRoute: "ready-to-implement",
      factoryNextAction: "implement-directly",
    },
    sourceMaterial: {
      title: WORK_ITEM.title,
      body: WORK_ITEM.body,
      labels: WORK_ITEM.labels,
      url: WORK_ITEM.url,
      tracker: { source: "linear", id: "FER-47", url: "https://linear.app/acme/issue/FER-47" },
    },
  };
}

function expectHandoffModel(handoff: string): void {
  expect(handoff).toContain("## Goal");
  expect(handoff).toContain("## Scope");
  expect(handoff).toContain("## Files changed");
  expect(handoff).toContain("## Implementation notes");
  expect(handoff).toContain("## Verification");
  expect(handoff).toContain("## Risks to scrutinize");
  expect(handoff).toContain("## Open items");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
