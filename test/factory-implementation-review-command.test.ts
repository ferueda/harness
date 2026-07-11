import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { expect, test, vi } from "vitest";
import {
  addFactoryImplementationReviewCommand,
  runFactoryImplementationReviewCommand,
} from "../bin/factory-implementation-review-command.ts";
import {
  appendFactoryLifecycleEvent,
  loadFactoryLifecycleState,
} from "../lib/factory-lifecycle.ts";
import { resolveFactoryStore } from "../lib/factory-store.ts";
import { run as runImplementationReview } from "../workflows/factory-implementation-review.workflow.ts";
import {
  createReviewContext,
  createReviewFixture,
  MIXED_REVIEW,
  scriptedProvider,
} from "./factory-implementation-review-test-helpers.ts";

test("review CLI emits stable JSON for rejected input", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-command-rejected-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = new Command().exitOverride();
    addFactoryImplementationReviewCommand(program, {
      defaultMaxRuntimeMs: 1_000,
      positiveNumber: Number,
    });

    await program.parseAsync([
      "node",
      "harness",
      "review",
      "--workspace",
      workspace,
      "--item-file",
      join(workspace, "missing-work-item.json"),
    ]);

    expect(process.exitCode).toBe(1);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      workflow: "factory-implementation-review",
      status: "rejected",
      error: expect.stringContaining("item file"),
    });
  } finally {
    process.exitCode = previousExitCode;
    output.mockRestore();
  }
});

test("review command fails closed before allocating a run for a non-Git workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-command-non-git-"));
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: mkdtempSync(join(tmpdir(), "harness-review-command-non-git-store-")),
    factoryStoreProjectId: "test-project",
    env: process.env,
  });

  await expect(
    runFactoryImplementationReviewCommand(
      {
        workspace,
        itemFile: join(workspace, "missing-work-item.json"),
        resume: false,
        factoryStoreRoot: store.storeRoot,
        factoryStoreProjectId: store.projectId,
        maxRuntimeMs: 1_000,
        verbose: false,
      },
      { defaultMaxRuntimeMs: 1_000, positiveNumber: Number },
    ),
  ).rejects.toThrow("Cannot resolve Git top-level");
  expect(existsSync(store.reviewRunsDir)).toBe(false);
});

test("review CLI emits stable JSON for parser rejection", async () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = new Command().exitOverride();
    addFactoryImplementationReviewCommand(program, {
      defaultMaxRuntimeMs: 1_000,
      positiveNumber: Number,
    });

    await expect(
      program.parseAsync(["node", "harness", "review", "--max-review-iterations", "0"]),
    ).rejects.toMatchObject({ code: "commander.invalidArgument" });

    expect(process.exitCode).toBe(1);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      workflow: "factory-implementation-review",
      status: "rejected",
      error: expect.stringContaining("positive"),
    });
  } finally {
    process.exitCode = previousExitCode;
    output.mockRestore();
  }
});

test("review CLI keeps a partial ready-for-human checkpoint terminal", async () => {
  const fixture = createReviewFixture();
  const firstProvider = scriptedProvider({
    workspace: fixture.workspace,
    reviews: [MIXED_REVIEW],
    remediation: {
      edit: "partial command remediation\n",
      output: {
        summary: "Leave the blocking finding for recovery.",
        findingDecisions: ["implementation", "quality", "simplify"].flatMap((role) => [
          {
            findingId: `${role}-001`,
            decision: "decline" as const,
            rationale: "Track the advisory note separately.",
          },
          {
            findingId: `${role}-002`,
            decision: "decline" as const,
            rationale: "Retry the blocking correction.",
          },
        ]),
      },
    },
  });
  const first = await runImplementationReview(createReviewContext(fixture, firstProvider));
  expect(first.status).toBe("ready-for-human");

  await expect(
    runFactoryImplementationReviewCommand(
      {
        workspace: fixture.workspace,
        linearIssue: "ENG-123",
        resume: true,
        factoryStoreRoot: fixture.store.storeRoot,
        factoryStoreProjectId: fixture.store.projectId,
        maxRuntimeMs: 1_000,
        verbose: false,
      },
      { defaultMaxRuntimeMs: 1_000, positiveNumber: Number },
    ),
  ).rejects.toThrow("Factory review is terminal at ready-for-human");
});

test("legacy review input is durably terminalized without invoking a provider", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-command-workspace-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: mkdtempSync(join(tmpdir(), "harness-review-command-store-")),
    factoryStoreProjectId: "test-project",
    env: process.env,
  });
  const itemFile = join(workspace, "work-item.json");
  writeFileSync(
    itemFile,
    `${JSON.stringify({
      id: "linear:ENG-123",
      source: "linear",
      title: "Legacy implementation",
      body: "",
      labels: [],
      metadata: { tracker: { source: "linear", id: "ENG-123" } },
    })}\n`,
    "utf8",
  );
  const execution = {
    workspace,
    runDir: join(store.factoryRunsDir, "implementation-legacy"),
    storeRoot: store.storeRoot,
    projectId: store.projectId,
    factoryStateRoot: store.factoryStateRoot,
    repo: {
      name: "test-project",
      id: "test-project",
      idSource: "config" as const,
    },
  };
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: "work_item.imported:linear:ENG-123",
      type: "work_item.imported",
      workItemKey: "linear:ENG-123",
      occurredAt: "2026-07-11T00:00:00.000Z",
      source: "harness",
      data: { source: "linear", title: "Legacy implementation" },
      execution,
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: "implementation.completed:implementation-legacy",
      type: "implementation.completed",
      workItemKey: "linear:ENG-123",
      occurredAt: "2026-07-11T00:00:01.000Z",
      runId: "implementation-legacy",
      source: "harness",
      data: {
        diffPath: "implementation/diff.patch",
        changeReviewHandoffPath: "implementation/change-review-handoff.md",
        reviewBase: "base",
        reviewHead: "head",
        reviewCommitSha: "commit",
      },
      execution,
    },
  });
  const runner = vi.fn();
  const result = await runFactoryImplementationReviewCommand(
    {
      workspace,
      itemFile,
      resume: false,
      factoryStoreRoot: store.storeRoot,
      factoryStoreProjectId: store.projectId,
      maxRuntimeMs: 1_000,
      verbose: false,
    },
    {
      defaultMaxRuntimeMs: 1_000,
      positiveNumber: Number,
      implementationReviewRunner: runner,
    },
  );

  expect(result.status).toBe("ready-for-human");
  expect("legacyIncomplete" in result && result.missing).toContain("session");
  expect(runner).not.toHaveBeenCalled();
  expect(readFileSync(result.summaryPath, "utf8")).toContain("legacy-incomplete");
  expect(
    loadFactoryLifecycleState({
      factoryStateRoot: store.factoryStateRoot,
      workItemKey: "linear:ENG-123",
      workspace,
    })?.factoryStage,
  ).toBe("ready-for-human");
});
