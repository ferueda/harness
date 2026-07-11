import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  FactoryImplementationReviewError,
  resolveFactoryImplementationReviewEvidence,
  runFactoryImplementationReview,
  type FactoryImplementationReviewDependencies,
} from "../lib/factory-implementation-review.ts";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  FactoryLifecycleEventSchema,
  factoryLifecycleEventPath,
  loadFactoryLifecycleState,
} from "../lib/factory-lifecycle.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import {
  factoryExecutionProvenance,
  factoryLifecycleExecutionProvenance,
  factoryStoreMetadata,
  resolveFactoryStore,
} from "../lib/factory-store.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

test("reviews completed implementation evidence and projects review-complete", async () => {
  const fixture = createFixture({ approvedPlan: true });
  const result = await runFactoryImplementationReview(
    reviewInput(fixture),
    reviewDependencies("pass", fixture),
  );

  expect(result).toMatchObject({
    implementationRunId: fixture.implementationRunId,
    reviewStatus: "completed",
    outcome: "review-complete",
    verdict: "pass",
  });
  expect(fixture.reviewInput).toEqual({ baseRef: fixture.baseSha, headRef: fixture.headSha });
  expect(fixture.reviewCalls).toBe(1);
  expect(readFileSync(join(result.reviewRunDir, "context/handoff.md"), "utf8")).toContain(
    "Review the completed implementation.",
  );
  expect(readFileSync(join(result.reviewRunDir, "context/plan.md"), "utf8")).toContain("# Plan");
  expect(
    loadFactoryLifecycleState({
      factoryStateRoot: fixture.store.factoryStateRoot,
      workItemKey: deriveFactoryWorkItemKey(fixture.workItem),
      workspace: fixture.workspace,
    }),
  ).toMatchObject({ factoryStage: "review-complete", factoryRunId: result.reviewRunId });
});

test.each(["needs_changes", "blocked"] as const)("maps %s to ready-for-human", async (verdict) => {
  const fixture = createFixture();
  const result = await runFactoryImplementationReview(
    reviewInput(fixture),
    reviewDependencies(verdict, fixture),
  );
  expect(result).toMatchObject({
    reviewStatus: "completed",
    outcome: "ready-for-human",
    verdict,
  });
  expect(fixture.reviewCalls).toBe(1);
  expect(
    loadFactoryLifecycleState({
      factoryStateRoot: fixture.store.factoryStateRoot,
      workItemKey: deriveFactoryWorkItemKey(fixture.workItem),
      workspace: fixture.workspace,
    }),
  ).toMatchObject({ factoryStage: "ready-for-human", factoryRunId: result.reviewRunId });
});

test("maps failed review runs without inventing a verdict", async () => {
  const fixture = createFixture();
  const result = await runFactoryImplementationReview(
    reviewInput(fixture),
    reviewDependencies("failed", fixture),
  );

  expect(result).toMatchObject({
    reviewStatus: "failed",
    outcome: "ready-for-human",
    failedReviews: [{ key: "implementation", error: "review failed" }],
  });
  expect(result).not.toHaveProperty("verdict");
  expect(fixture.reviewCalls).toBe(1);
  expect(
    loadFactoryLifecycleState({
      factoryStateRoot: fixture.store.factoryStateRoot,
      workItemKey: deriveFactoryWorkItemKey(fixture.workItem),
      workspace: fixture.workspace,
    }),
  ).toMatchObject({ factoryStage: "ready-for-human", factoryRunId: result.reviewRunId });
});

test("rejects inconsistent persisted review outcome and verdict", () => {
  expect(
    FactoryLifecycleEventSchema.safeParse({
      version: 1,
      id: "implementation.review.completed:review-run",
      type: "implementation.review.completed",
      workItemKey: "file:ENG-123",
      occurredAt: new Date().toISOString(),
      runId: "review-run",
      source: "harness",
      data: {
        implementationRunId: "implementation-run",
        reviewStatus: "completed",
        outcome: "ready-for-human",
        verdict: "pass",
        summaryPath: "summary.md",
        metaPath: "meta.json",
      },
    }).success,
  ).toBe(false);
});

test("rejects work items outside implementation-complete", () => {
  const fixture = createFixture({ implementationCompleted: false });
  expect(() =>
    resolveFactoryImplementationReviewEvidence({
      workspace: fixture.workspace,
      workItem: fixture.workItem,
      store: fixture.store,
    }),
  ).toThrow(/requires implementation-complete/);
});

test("rejects a persisted implementation event for another work item", () => {
  const fixture = createFixture();
  const workItemKey = deriveFactoryWorkItemKey(fixture.workItem);
  const eventPath = factoryLifecycleEventPath(fixture.store.factoryStateRoot, workItemKey);
  const events = readFileSync(eventPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  events.at(-1)!.workItemKey = "file:OTHER-999";
  writeFileSync(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

  expect(() =>
    resolveFactoryImplementationReviewEvidence({
      workspace: fixture.workspace,
      workItem: fixture.workItem,
      store: fixture.store,
    }),
  ).toThrow(/event does not match the requested work item/);
});

test("rejects moved implementation refs and reviews by recorded commit SHA", () => {
  const fixture = createFixture();
  git(fixture.workspace, ["update-ref", fixture.reviewHead, fixture.baseSha]);

  expect(() =>
    resolveFactoryImplementationReviewEvidence({
      workspace: fixture.workspace,
      workItem: fixture.workItem,
      store: fixture.store,
    }),
  ).toThrow(/no longer matches the recorded commit SHA/);
});

test("rejects missing implementation refs", () => {
  const fixture = createFixture();
  git(fixture.workspace, ["update-ref", "-d", fixture.reviewHead]);

  expect(() =>
    resolveFactoryImplementationReviewEvidence({
      workspace: fixture.workspace,
      workItem: fixture.workItem,
      store: fixture.store,
    }),
  ).toThrow(/Invalid implementation Git review evidence/);
});

test("rejects malformed completed implementation metadata", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.runDir, "meta.json"), '{"status":"implementation-complete"}\n');

  expect(() =>
    resolveFactoryImplementationReviewEvidence({
      workspace: fixture.workspace,
      workItem: fixture.workItem,
      store: fixture.store,
    }),
  ).toThrow(/Invalid implementation meta/);
});

test("rejects relative persisted implementation run directories", () => {
  const fixture = createFixture({ relativeExecutionRunDir: true });
  expect(() =>
    resolveFactoryImplementationReviewEvidence({
      workspace: fixture.workspace,
      workItem: fixture.workItem,
      store: fixture.store,
    }),
  ).toThrow(/execution\.runDir must be absolute/);
});

test("rejects unreadable persisted handoff evidence before provider creation", () => {
  const fixture = createFixture();
  chmodSync(join(fixture.runDir, "implementation/change-review-handoff.md"), 0o000);
  expect(() =>
    resolveFactoryImplementationReviewEvidence({
      workspace: fixture.workspace,
      workItem: fixture.workItem,
      store: fixture.store,
    }),
  ).toThrow(/Invalid change-review handoff/);
  expect(fixture.reviewCalls).toBe(0);
});

test("rejects malformed failed-review diagnostics", async () => {
  const fixture = createFixture();
  await expect(
    runFactoryImplementationReview(reviewInput(fixture), {
      ...reviewDependencies("failed", fixture),
      async reviewRunner(ctx) {
        const context = ctx as typeof ctx & { runId: string; runDir: string };
        writeFileSync(join(context.runDir, "summary.md"), "# Review\n", "utf8");
        writeFileSync(join(context.runDir, "meta.json"), "{}\n", "utf8");
        return { runId: context.runId, status: "failed", failedReviews: [] };
      },
    }),
  ).rejects.toThrow(/invalid failed-review evidence/);
});

test("rejects traversal in persisted handoff paths", () => {
  const fixture = createFixture({ metaHandoffPath: "../outside.md" });
  writeFileSync(join(fixture.store.factoryRunsDir, "outside.md"), "outside", "utf8");

  expect(() =>
    resolveFactoryImplementationReviewEvidence({
      workspace: fixture.workspace,
      workItem: fixture.workItem,
      store: fixture.store,
    }),
  ).toThrow(/escapes the implementation run/);
});

test("reports preserved review paths when lifecycle append fails", async () => {
  const fixture = createFixture();
  await expect(
    runFactoryImplementationReview(reviewInput(fixture), {
      ...reviewDependencies("pass", fixture),
      appendResult() {
        throw new Error("disk full");
      },
    }),
  ).rejects.toThrow(new RegExp(`lifecycle append failed: disk full.*reviewRunDir=.*metaPath=`));
});

type Fixture = ReturnType<typeof createFixture>;

function createFixture(
  options: {
    approvedPlan?: boolean;
    implementationCompleted?: boolean;
    metaHandoffPath?: string;
    relativeExecutionRunDir?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "harness-factory-review-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  git(workspace, ["init"]);
  git(workspace, ["config", "user.name", "Harness Test"]);
  git(workspace, ["config", "user.email", "harness@example.com"]);
  writeFileSync(join(workspace, "file.txt"), "base\n", "utf8");
  git(workspace, ["add", "file.txt"]);
  git(workspace, ["commit", "-m", "base"]);
  const baseSha = git(workspace, ["rev-parse", "HEAD"]);
  writeFileSync(join(workspace, "file.txt"), "candidate\n", "utf8");
  git(workspace, ["commit", "-am", "candidate"]);
  const headSha = git(workspace, ["rev-parse", "HEAD"]);
  const reviewHead = "refs/harness/factory/implementation-run/implementation";
  git(workspace, ["update-ref", reviewHead, headSha]);

  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: join(root, "store"),
    factoryStoreProjectId: "test-project",
    env: {},
  });
  const implementationRunId = "implementation-run";
  const runDir = join(store.factoryRunsDir, implementationRunId);
  mkdirSync(join(runDir, "implementation"), { recursive: true });
  writeFileSync(
    join(runDir, "implementation/change-review-handoff.md"),
    "Review the completed implementation.",
    "utf8",
  );
  if (options.approvedPlan) {
    mkdirSync(join(workspace, "dev/plans"), { recursive: true });
    writeFileSync(join(workspace, "dev/plans/ENG-123.md"), "# Plan\n", "utf8");
  }
  writeFileSync(
    join(runDir, "meta.json"),
    `${JSON.stringify({
      runId: implementationRunId,
      workflow: "factory-implementation",
      status: "implementation-complete",
      mode: "direct",
      workspace,
      runDir,
      workItem: { id: "ENG-123", source: "file", title: "Review me" },
      implementerAgent: { provider: "codex", model: "test" },
      artifacts: {
        workItem: "context/work-item.json",
        implementationInput: "context/implementation-input.json",
        summary: "summary.md",
        meta: "meta.json",
        prompt: "implementation/prompt.md",
        changeReviewHandoff: options.metaHandoffPath ?? "implementation/change-review-handoff.md",
      },
      summaryPath: join(runDir, "summary.md"),
      metaPath: join(runDir, "meta.json"),
      startedAt: new Date().toISOString(),
      durationMs: 1,
      reviewBase: baseSha,
      reviewHead,
      reviewCommitSha: headSha,
    })}\n`,
    "utf8",
  );

  const workItem: FactoryWorkItem = {
    id: "ENG-123",
    source: "file",
    title: "Review me",
    body: "",
    labels: [],
  };
  const workItemKey = deriveFactoryWorkItemKey(workItem);
  const absoluteExecution = factoryLifecycleExecutionProvenance(
    factoryExecutionProvenance(workspace, runDir),
    factoryStoreMetadata(store),
  );
  const execution = options.relativeExecutionRunDir
    ? { ...absoluteExecution, runDir: implementationRunId }
    : absoluteExecution;
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: new Date().toISOString(),
      source: "harness",
      execution,
      data: {
        source: workItem.source,
        title: workItem.title,
        ...(options.approvedPlan ? { approvedPlanPath: "dev/plans/ENG-123.md" } : {}),
      },
    },
  });
  if (options.implementationCompleted !== false) {
    appendFactoryLifecycleEvent({
      factoryStateRoot: store.factoryStateRoot,
      event: {
        version: 1,
        id: `implementation.completed:${implementationRunId}`,
        type: "implementation.completed",
        workItemKey,
        occurredAt: new Date().toISOString(),
        runId: implementationRunId,
        source: "harness",
        execution,
        data: {
          diffPath: "implementation/diff.patch",
          changeReviewHandoffPath: "implementation/change-review-handoff.md",
          reviewBase: baseSha,
          reviewHead,
          reviewCommitSha: headSha,
        },
      },
    });
  }
  return {
    workspace,
    store,
    workItem,
    implementationRunId,
    runDir,
    baseSha,
    headSha,
    reviewHead,
    reviewInput: {} as Record<string, string | undefined>,
    reviewCalls: 0,
  };
}

function reviewInput(fixture: Fixture) {
  return {
    workspace: fixture.workspace,
    workItem: fixture.workItem,
    store: fixture.store,
    agentProvider: "codex" as const,
    maxRuntimeMs: 5_000,
  };
}

function reviewDependencies(
  verdict: "pass" | "needs_changes" | "blocked" | "failed",
  fixture: Fixture,
): FactoryImplementationReviewDependencies {
  return {
    agentProviderFactory: () => ({
      name: "codex",
      async run() {
        throw new Error("review runner is injected");
      },
    }),
    async reviewRunner(ctx) {
      fixture.reviewCalls += 1;
      const context = ctx as typeof ctx & {
        scope?: { baseRef: string; headRef: string };
        runId: string;
        runDir: string;
      };
      fixture.reviewInput = {
        baseRef: context.scope?.baseRef,
        headRef: context.scope?.headRef,
      };
      const meta =
        verdict === "failed"
          ? {
              runId: context.runId,
              status: "failed",
              failedReviews: [
                { key: "implementation", stage: "implementation", error: "review failed" },
              ],
            }
          : { runId: context.runId, status: "completed", verdict };
      writeFileSync(join(context.runDir, "summary.md"), "# Review\n", "utf8");
      writeFileSync(join(context.runDir, "meta.json"), `${JSON.stringify(meta)}\n`, "utf8");
      return meta;
    },
  };
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}
