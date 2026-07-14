import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  createFactoryPlanningRunContextForTest,
  DraftValidationError,
  FactoryPlanningIterationCollisionError,
} from "../lib/factory-planning-run-context.ts";
import { draft, WORK_ITEM, okPlanner } from "./factory-planning-test-helpers.ts";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "harness-fer61-workspace-"));
}

function options(inputWorkspace: string, runsDir: string, testHooks = {}) {
  return {
    workspace: inputWorkspace,
    runsDir,
    workItem: WORK_ITEM,
    plannerRole: { agent: "cursor" as const },
    reviewerRole: { agent: "cursor" as const },
    maxRuntimeMs: 1_000,
    testHooks,
    agentProviderFactory(providerOptions: { provider: "cursor" | "codex" }) {
      return {
        name: providerOptions.provider,
        async run() {
          return okPlanner(draft(), { provider: "cursor", id: "planner" });
        },
      };
    },
  };
}

test("planning context separates lazy workspace scratch from external durable evidence", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest(options(inputWorkspace, runsDir));

  expect(ctx.draftPath).toBe(
    join(inputWorkspace, ".harness/factory-drafts", ctx.runId, "draft.md"),
  );
  expect(ctx.durableDraftPath).toBe(join(ctx.runDir, "planning/draft.md"));
  expect(existsSync(ctx.draftPath)).toBe(false);
  expect(existsSync(join(inputWorkspace, ".harness/factory-drafts"))).toBe(false);

  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# Stable plan\n", "utf8");
  ctx.writePlannerEvidence({ index: 1, prompt: "write locally", raw: { ok: true } });
  ctx.writePlannerStructuredArtifact(1, draft());
  const planPath = ctx.publishPlannerDraft(1);

  expect(readFileSync(planPath, "utf8")).toBe("# Stable plan\n");
  expect(readFileSync(ctx.durableDraftPath, "utf8")).toBe("# Stable plan\n");
  expect(lstatSync(ctx.scratchRunDir).isDirectory()).toBe(true);
  ctx.preparePlannerScratch();
  expect(existsSync(ctx.draftPath)).toBe(true);
});

test("live planning rejects workspace-local durable run roots while dry-run keeps compatibility", () => {
  const inputWorkspace = workspace();
  const localRuns = join(inputWorkspace, ".harness/local-runs");
  expect(() => createFactoryPlanningRunContextForTest(options(inputWorkspace, localRuns))).toThrow(
    /outside workspace/,
  );

  const dryCtx = createFactoryPlanningRunContextForTest({
    ...options(inputWorkspace, localRuns),
    dryRun: true,
  });
  expect(dryCtx.runDir).toContain(localRuns);
});

test("prospective scratch/run overlap through a symlink alias is rejected", () => {
  const inputWorkspace = workspace();
  const external = mkdtempSync(join(tmpdir(), "harness-fer61-overlap-"));
  symlinkSync(external, join(inputWorkspace, ".harness"));

  expect(() =>
    createFactoryPlanningRunContextForTest(
      options(inputWorkspace, join(external, "factory-drafts"), { runIdGenerator: () => "same" }),
    ),
  ).toThrow(/overlap/);
});

test("pre-existing scratch parent symlink is rejected at lazy preparation", () => {
  const inputWorkspace = workspace();
  const external = mkdtempSync(join(tmpdir(), "harness-fer61-symlink-"));
  symlinkSync(external, join(inputWorkspace, ".harness"));
  const ctx = createFactoryPlanningRunContextForTest(
    options(inputWorkspace, mkdtempSync(join(tmpdir(), "harness-fer61-runs-")), {
      runIdGenerator: () => "symlinked",
    }),
  );

  expect(() => ctx.preparePlannerScratch()).toThrow(/parent-unsafe/);
});

test("run id collisions allocate a new id without merging existing durable evidence", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const fixed = join(runsDir, "fixed");
  mkdirSync(fixed, { recursive: true });
  writeFileSync(join(fixed, "sentinel"), "keep\n", "utf8");
  let calls = 0;
  const ctx = createFactoryPlanningRunContextForTest(
    options(inputWorkspace, runsDir, {
      runIdGenerator: () => (calls++ === 0 ? "fixed" : "fresh"),
    }),
  );

  expect(ctx.runId).toBe("fresh");
  expect(readFileSync(join(fixed, "sentinel"), "utf8")).toBe("keep\n");
  expect(existsSync(join(fixed, "context/work-item.json"))).toBe(false);
});

test("eight run id collisions fail closed", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  mkdirSync(join(runsDir, "fixed"), { recursive: true });
  let calls = 0;
  expect(() =>
    createFactoryPlanningRunContextForTest(
      options(inputWorkspace, runsDir, {
        runIdGenerator: () => {
          calls += 1;
          return "fixed";
        },
      }),
    ),
  ).toThrow("Unable to allocate unique factory planning run directory after 8 attempts");
  expect(calls).toBe(8);
});

test("stale scratch is never reused", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  mkdirSync(join(inputWorkspace, ".harness/factory-drafts/fixed"), { recursive: true });
  writeFileSync(join(inputWorkspace, ".harness/factory-drafts/fixed/draft.md"), "stale\n", "utf8");
  const ctx = createFactoryPlanningRunContextForTest(
    options(inputWorkspace, runsDir, { runIdGenerator: () => "fixed" }),
  );

  expect(() => ctx.preparePlannerScratch()).toThrow(DraftValidationError);
  expect(readFileSync(join(inputWorkspace, ".harness/factory-drafts/fixed/draft.md"), "utf8")).toBe(
    "stale\n",
  );
});

test("publication rejects scratch that this context did not prepare", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest(options(inputWorkspace, runsDir));
  mkdirSync(ctx.scratchRunDir, { recursive: true });
  writeFileSync(ctx.draftPath, "# Untrusted\n", "utf8");

  expect(() => ctx.publishPlannerDraft(1)).toThrowError(
    expect.objectContaining({ reason: "parent-unsafe" }),
  );
  expect(existsSync(ctx.durableDraftPath)).toBe(false);
});

test("publication rejects draft bytes that echo the scratch path", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest(options(inputWorkspace, runsDir));
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, `# ${ctx.draftPath}\n`, "utf8");

  expect(() => ctx.publishPlannerDraft(1)).toThrowError(
    expect.objectContaining({ reason: "read-failed" }),
  );
  expect(existsSync(ctx.durableDraftPath)).toBe(false);
});

test("parent replacement before final validation fails without publishing sentinel bytes", () => {
  const inputWorkspace = workspace();
  const outside = mkdtempSync(join(tmpdir(), "harness-fer61-outside-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  let swapped = false;
  const ctx = createFactoryPlanningRunContextForTest(
    options(inputWorkspace, runsDir, {
      beforeFinalScratchValidation: () => {
        if (swapped) return;
        swapped = true;
        renameSync(join(inputWorkspace, ".harness"), join(outside, "harness-moved"));
        symlinkSync(outside, join(inputWorkspace, ".harness"));
      },
    }),
  );
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# Unsafe\n", "utf8");
  ctx.writePlannerEvidence({ index: 1, prompt: ctx.draftPath, raw: {} });
  ctx.writePlannerStructuredArtifact(1, draft());

  expect(() => ctx.publishPlannerDraft(1)).toThrow(DraftValidationError);
  expect(existsSync(ctx.durableDraftPath)).toBe(false);
  expect(existsSync(join(outside, "harness-moved", "factory-drafts", ctx.runId, "draft.md"))).toBe(
    true,
  );
});

test("final draft symlink is rejected after the final parent check", () => {
  const inputWorkspace = workspace();
  const outside = mkdtempSync(join(tmpdir(), "harness-fer61-outside-"));
  const externalDraft = join(outside, "draft.md");
  writeFileSync(externalDraft, "# External\n", "utf8");
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  let draftPath = "";
  const ctx = createFactoryPlanningRunContextForTest(
    options(inputWorkspace, runsDir, {
      beforeScratchRead: () => {
        unlinkSync(draftPath);
        symlinkSync(externalDraft, draftPath);
      },
    }),
  );
  draftPath = ctx.draftPath;
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# Unsafe\n", "utf8");

  expect(() => ctx.publishPlannerDraft(1)).toThrowError(
    expect.objectContaining({ reason: "symlinked" }),
  );
  expect(existsSync(ctx.durableDraftPath)).toBe(false);
});

test("regular parent replacement is rejected by the prepared scratch identity", () => {
  const inputWorkspace = workspace();
  const outside = mkdtempSync(join(tmpdir(), "harness-fer61-outside-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  let scratchRunDir = "";
  const ctx = createFactoryPlanningRunContextForTest(
    options(inputWorkspace, runsDir, {
      beforeScratchRead: () => {
        renameSync(join(inputWorkspace, ".harness"), join(outside, "harness-moved"));
        mkdirSync(scratchRunDir, { recursive: true });
        writeFileSync(join(scratchRunDir, "draft.md"), "# Replacement\n", "utf8");
      },
    }),
  );
  scratchRunDir = ctx.scratchRunDir;
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# Unsafe\n", "utf8");

  expect(() => ctx.publishPlannerDraft(1)).toThrowError(
    expect.objectContaining({ reason: "parent-unsafe" }),
  );
  expect(existsSync(ctx.durableDraftPath)).toBe(false);
});

test("immutable iteration collision preserves existing plan and canonical bytes", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest(options(inputWorkspace, runsDir));
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# New\n", "utf8");
  mkdirSync(ctx.iterationDir(1), { recursive: true });
  writeFileSync(join(ctx.iterationDir(1), "plan.md"), "# Existing\n", "utf8");
  writeFileSync(ctx.durableDraftPath, "# Canonical\n", "utf8");

  expect(() => ctx.publishPlannerDraft(1)).toThrow(FactoryPlanningIterationCollisionError);
  expect(readFileSync(join(ctx.iterationDir(1), "plan.md"), "utf8")).toBe("# Existing\n");
  expect(readFileSync(ctx.durableDraftPath, "utf8")).toBe("# Canonical\n");
});

test("durable final-plan validation rejects a symlinked iteration parent", () => {
  const inputWorkspace = workspace();
  const outside = mkdtempSync(join(tmpdir(), "harness-fer61-outside-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest({
    ...options(inputWorkspace, runsDir),
    outputPlan: "dev/plans/symlink-parent.md",
  });
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# Snapshot\n", "utf8");
  const planPath = ctx.publishPlannerDraft(1);
  renameSync(ctx.iterationDir(1), join(outside, "iteration"));
  symlinkSync(join(outside, "iteration"), ctx.iterationDir(1));

  expect(() => ctx.writeFinalPlan(planPath)).toThrow(/symlinked/);
});

test("publication rejects symlinked durable parents before staging", () => {
  const inputWorkspace = workspace();
  const outside = mkdtempSync(join(tmpdir(), "harness-fer61-outside-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest(options(inputWorkspace, runsDir));
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# Snapshot\n", "utf8");
  renameSync(join(ctx.runDir, "planning"), join(outside, "planning"));
  symlinkSync(join(outside, "planning"), join(ctx.runDir, "planning"));

  expect(() => ctx.publishPlannerDraft(1)).toThrow(/publication parent is unsafe/);
  expect(existsSync(join(outside, "planning", "draft.md"))).toBe(false);
});

test("publication failures leave no temporary files and preserve prior evidence", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest(
    options(inputWorkspace, runsDir, {
      canonicalRenameFailure: () => {
        throw new Error("rename failed");
      },
    }),
  );
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# New\n", "utf8");
  writeFileSync(ctx.durableDraftPath, "# Old\n", "utf8");

  expect(() => ctx.publishPlannerDraft(1)).toThrow(/rename failed/);
  expect(readFileSync(ctx.durableDraftPath, "utf8")).toBe("# Old\n");
  expect(existsSync(join(ctx.iterationDir(1), "plan.md"))).toBe(false);
});

test.each([
  [
    "stage",
    {
      stageFailure: () => {
        throw new Error("stage failed");
      },
    },
  ],
  [
    "iteration-link",
    {
      linkFailure: () => {
        throw new Error("link failed");
      },
    },
  ],
] as const)("publication reports %s failures without publishing", (stage, testHooks) => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest(options(inputWorkspace, runsDir, testHooks));
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# New\n", "utf8");

  expect(() => ctx.publishPlannerDraft(1)).toThrowError(expect.objectContaining({ stage }));
  expect(existsSync(join(ctx.iterationDir(1), "plan.md"))).toBe(false);
  expect(existsSync(ctx.durableDraftPath)).toBe(false);
});

test("publication rolls back a linked snapshot when iteration cleanup fails", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest(
    options(inputWorkspace, runsDir, {
      iterationCleanupFailure: () => {
        throw new Error("cleanup failed");
      },
    }),
  );
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# New\n", "utf8");

  expect(() => ctx.publishPlannerDraft(1)).toThrowError(
    expect.objectContaining({ stage: "rollback" }),
  );
  expect(existsSync(join(ctx.iterationDir(1), "plan.md"))).toBe(false);
  expect(existsSync(ctx.durableDraftPath)).toBe(false);
});

test("publication reports rollback failures while preserving the linked sentinel", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest(
    options(inputWorkspace, runsDir, {
      canonicalRenameFailure: () => {
        throw new Error("rename failed");
      },
      rollbackFailure: () => {
        throw new Error("rollback failed");
      },
    }),
  );
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# New\n", "utf8");

  expect(() => ctx.publishPlannerDraft(1)).toThrowError(
    expect.objectContaining({ stage: "rollback" }),
  );
  expect(existsSync(join(ctx.iterationDir(1), "plan.md"))).toBe(true);
});

test("durable final plan accepts only an immutable iteration snapshot", () => {
  const inputWorkspace = workspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-fer61-runs-"));
  const ctx = createFactoryPlanningRunContextForTest({
    ...options(inputWorkspace, runsDir),
    outputPlan: "dev/plans/snapshot.md",
  });
  ctx.preparePlannerScratch();
  writeFileSync(ctx.draftPath, "# Snapshot\n", "utf8");
  const planPath = ctx.publishPlannerDraft(1);
  expect(ctx.writeFinalPlan(planPath)).toBe(join(inputWorkspace, "dev/plans/snapshot.md"));
  expect(() => ctx.writeFinalPlan(ctx.draftPath)).toThrow(/iterations directory/);
});
