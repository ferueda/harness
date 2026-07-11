import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, expect, test, vi } from "vitest";
import {
  addFactoryCommands,
  runFactoryImplementationWithLinearApply,
  type FactoryCommandOptions,
} from "../bin/factory-commands.ts";
import {
  createFactoryImplementationRunContextForTest,
  type FactoryImplementationRunContext,
} from "../lib/factory-implementation-run-context.ts";
import type { FactoryImplementationInput } from "../lib/factory-implementation-input.ts";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  readFactoryLifecycleEvents,
} from "../lib/factory-lifecycle.ts";
import { createLinearFactoryAdapterForClient } from "../lib/factory-linear-adapter.ts";
import type { LinearImplementationUpdatePlan } from "../lib/factory-linear-implementation-apply.ts";
import type { LinearClientLike, LinearCommentLike } from "../lib/factory-linear-types.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import { fakeLinearAdapter, LINEAR_SETTINGS } from "./factory-linear-test-helpers.ts";

const ORIGINAL_LINEAR_API_KEY = process.env.LINEAR_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (ORIGINAL_LINEAR_API_KEY === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = ORIGINAL_LINEAR_API_KEY;
});

const WORK_ITEM = {
  id: "linear:ENG-123",
  source: "linear",
  title: "Implement Linear apply",
  body: "Project implementation lifecycle to Linear.",
  labels: ["factory"],
  metadata: {
    tracker: { source: "linear" as const, id: "ENG-123" },
    factoryStage: "ready-to-implement" as const,
    factoryRoute: "ready-to-implement" as const,
    factoryNextAction: "implement-directly" as const,
  },
} satisfies FactoryWorkItem;

const STARTED = {
  issueIdentifier: "ENG-123",
  runId: "run",
  runDir: "run-dir",
  stage: "started",
  fromStatus: "Ready to Implement",
  targetStatus: "Implementing",
} satisfies LinearImplementationUpdatePlan;

function context(): {
  ctx: FactoryImplementationRunContext;
  factoryStateRoot: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-apply-workspace-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-implementation-apply-runs-"));
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-implementation-apply-state-"));
  const implementationInput: FactoryImplementationInput = {
    mode: "direct",
    source: "linear",
    workItem: WORK_ITEM,
    metadata: WORK_ITEM.metadata,
    sourceMaterial: {
      title: WORK_ITEM.title,
      body: WORK_ITEM.body,
      labels: WORK_ITEM.labels,
      tracker: WORK_ITEM.metadata.tracker,
    },
  };
  return {
    ctx: createFactoryImplementationRunContextForTest({
      workspace,
      runsDir,
      workItem: WORK_ITEM,
      implementationInput,
      implementerRole: { agent: "cursor" },
      dryRun: false,
      maxRuntimeMs: 5_000,
      linearApplyRequested: true,
      agentProviderFactory: () => {
        throw new Error("provider should be controlled by the test seam");
      },
    }),
    factoryStateRoot,
  };
}

test("start apply failure exports a truthful result with terminal lifecycle", async () => {
  const { ctx, factoryStateRoot } = context();
  const runImplementation = vi.fn();
  const startError = new Error("Linear implementation start mutation failed");

  const result = await runFactoryImplementationWithLinearApply({
    ctx,
    factoryStateRoot,
    issueRef: "ENG-123",
    adapter: fakeLinearAdapter({
      applyImplementationStarted: async () => {
        throw startError;
      },
    }),
    runImplementation,
  });

  expect(runImplementation).not.toHaveBeenCalled();
  expect(result.startApplyError).toBe(startError);
  expect(result.meta).toMatchObject({
    status: "implementation-failed",
  });
  expect(result.meta).not.toHaveProperty("preProviderFailure");
  expect(result.meta.artifacts).not.toHaveProperty("prompt");
  expect(
    readFactoryLifecycleEvents({
      factoryStateRoot,
      workItemKey: deriveFactoryWorkItemKey(WORK_ITEM),
    }).map((event) => event.type),
  ).toEqual(["work_item.imported", "implementation.started", "implementation.start-unresolved"]);
});

test("successful implementation records lifecycle before terminal Linear projection", async () => {
  const { ctx, factoryStateRoot } = context();
  const completed = vi.fn(async () => ({
    ...STARTED,
    runId: ctx.runId,
    runDir: ctx.runDir,
    stage: "completed" as const,
    fromStatus: "Implementing",
    targetStatus: "Implementing",
  }));

  const result = await runFactoryImplementationWithLinearApply({
    ctx,
    factoryStateRoot,
    issueRef: "ENG-123",
    adapter: fakeLinearAdapter({
      applyImplementationStarted: async () => ({
        ...STARTED,
        runId: ctx.runId,
        runDir: ctx.runDir,
      }),
      applyImplementationCompleted: completed,
    }),
    runImplementation: completeImplementation,
  });

  expect(result.meta.status).toBe("implementation-complete");
  expect(result.linearUpdate).toMatchObject({
    started: { stage: "started" },
    terminal: { stage: "completed" },
  });
  expect(completed).toHaveBeenCalledWith(
    expect.objectContaining({
      reviewBase: "base-sha",
      reviewHead: "refs/harness/review",
      reviewCommitSha: "review-sha",
    }),
  );
  expect(
    readFactoryLifecycleEvents({
      factoryStateRoot,
      workItemKey: deriveFactoryWorkItemKey(WORK_ITEM),
    }).map((event) => event.type),
  ).toEqual(["work_item.imported", "implementation.started", "implementation.completed"]);
});

test("terminal Linear failure preserves the local terminal result for operator recovery", async () => {
  const { ctx, factoryStateRoot } = context();
  const terminalError = new Error("Linear completion comment failed");

  const result = await runFactoryImplementationWithLinearApply({
    ctx,
    factoryStateRoot,
    issueRef: "ENG-123",
    adapter: fakeLinearAdapter({
      applyImplementationStarted: async () => ({
        ...STARTED,
        runId: ctx.runId,
        runDir: ctx.runDir,
      }),
      applyImplementationCompleted: async () => {
        throw terminalError;
      },
    }),
    runImplementation: completeImplementation,
  });

  expect(result.meta.status).toBe("implementation-complete");
  expect(result.terminalApplyError).toBe(terminalError);
  expect(result.linearUpdate).toEqual({ started: expect.objectContaining({ stage: "started" }) });
});

async function completeImplementation(ctx: FactoryImplementationRunContext) {
  ctx.writePromptArtifact({ prompt: "Implement the work item." });
  ctx.writeLiveArtifacts({
    raw: { ok: true },
    workspaceStatus: { before: "", after: " M file.ts" },
    diff: "diff --git a/file.ts b/file.ts\n",
    changeReviewHandoff: "## Review Handoff\n",
  });
  return ctx.export({
    status: "implementation-complete",
    reviewBase: "base-sha",
    reviewHead: "refs/harness/review",
    reviewCommitSha: "review-sha",
    includeLiveArtifacts: true,
  });
}

async function failedImplementation(ctx: FactoryImplementationRunContext) {
  ctx.writePromptArtifact({ prompt: "Implement the work item." });
  ctx.writeLiveArtifacts({
    raw: { ok: false },
    workspaceStatus: { before: "", after: "" },
    diff: "",
    changeReviewHandoff: "## Review Handoff\n",
  });
  return ctx.export({
    status: "implementation-failed",
    error: "provider failed",
    includeLiveArtifacts: true,
  });
}

type CommandLinearBehavior = {
  update: (input: { stateId: string }) => Promise<{ success: boolean }>;
  comment: (input: { issueId: string; body: string }) => Promise<{ success: boolean }>;
};

function commandFixture(
  overrides: {
    behavior?: Partial<CommandLinearBehavior>;
    runner?: FactoryCommandOptions["implementationRunner"];
    lease?: FactoryCommandOptions["implementationExecutionLease"];
  } = {},
) {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-command-workspace-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "harness-implementation-command-store-"));
  const factoryStateRoot = join(storeRoot, "projects/test-project/factory");
  let linearState = "Ready to Implement";
  const comments: LinearCommentLike[] = [];
  const updates: Array<{ stateId: string }> = [];
  const commentInputs: Array<{ issueId: string; body: string }> = [];
  const runner = vi.fn(overrides.runner ?? completeImplementation);
  const behavior: CommandLinearBehavior = {
    async update(input) {
      linearState = input.stateId.replace(/^state-/, "");
      return { success: true };
    },
    async comment(input) {
      comments.push({ id: `comment-${comments.length + 1}`, body: input.body });
      return { success: true };
    },
    ...overrides.behavior,
  };
  const issue = () => ({
    id: "issue-1",
    identifier: "ENG-123",
    number: 123,
    title: WORK_ITEM.title,
    description: WORK_ITEM.body,
    url: "https://linear.app/acme/issue/ENG-123",
    state: Promise.resolve({ id: `state-${linearState}`, name: linearState }),
    team: Promise.resolve(TEAM),
    labels: async () => ({ nodes: [{ name: "factory" }] }),
    comments: async () => ({ nodes: comments, pageInfo: { hasPreviousPage: false } }),
  });
  const TEAM = {
    id: "team-1",
    key: "ENG",
    name: "Engineering",
    states: async () => ({
      nodes: Object.values(LINEAR_SETTINGS.statuses).map((name) => ({
        id: `state-${name}`,
        name,
      })),
    }),
  };
  const client: LinearClientLike = {
    issue: async () => issue(),
    issues: async () => ({ nodes: [issue()] }),
    teams: async () => ({ nodes: [TEAM] }),
    createIssue: async () => ({ success: false }),
    updateIssue: async (_id, input) => {
      updates.push(input);
      return behavior.update(input);
    },
    createComment: async (input) => {
      commentInputs.push(input);
      return behavior.comment(input);
    },
  };
  writeFileSync(
    join(workspace, "harness.json"),
    `${JSON.stringify({
      defaultAgent: "cursor",
      agents: { cursor: { model: "grok-4.5" } },
      factory: {
        linear: { teamKey: "ENG", statuses: LINEAR_SETTINGS.statuses },
        implementation: { roles: { implementer: { agent: "cursor", model: "grok-4.5" } } },
      },
    })}\n`,
    "utf8",
  );
  mkdirSync(factoryStateRoot, { recursive: true });
  seedReadyLifecycle(factoryStateRoot);
  process.env.LINEAR_API_KEY = "test-key";
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => output.push(String(value)));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const program = new Command().exitOverride();
  addFactoryCommands(program, {
    positiveNumber: Number,
    defaultMaxRuntimeMs: 5_000,
    writeVerboseWorkflowEvent: () => undefined,
    implementationLinearAdapterFactory: ({ settings }) =>
      createLinearFactoryAdapterForClient({ client, settings }),
    implementationAgentProviderFactory: () => ({
      name: "cursor",
      async run() {
        throw new Error("provider must be controlled by implementationRunner");
      },
    }),
    implementationRunner: runner,
    ...(overrides.lease ? { implementationExecutionLease: overrides.lease } : {}),
  });
  return {
    program,
    workspace,
    storeRoot,
    factoryStateRoot,
    output,
    runner,
    updates,
    commentInputs,
    setLinearState(value: string) {
      linearState = value;
    },
  };
}

function commandArgs(fixture: ReturnType<typeof commandFixture>): string[] {
  return [
    "node",
    "harness",
    "factory",
    "implementation",
    "run",
    "--workspace",
    fixture.workspace,
    "--linear-issue",
    "ENG-123",
    "--apply",
    "--factory-store-root",
    fixture.storeRoot,
    "--factory-store-project-id",
    "test-project",
  ];
}

function seedReadyLifecycle(factoryStateRoot: string): void {
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: "work_item.imported:linear:ENG-123",
      type: "work_item.imported",
      workItemKey: "linear:ENG-123",
      occurredAt: "2026-07-10T00:00:00.000Z",
      source: "harness",
      data: { source: "linear", title: WORK_ITEM.title },
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: "triage.completed:seed",
      type: "triage.completed",
      workItemKey: "linear:ENG-123",
      runId: "seed",
      occurredAt: "2026-07-10T00:01:00.000Z",
      source: "harness",
      data: {
        route: "ready-to-implement",
        nextAction: "implement-directly",
        rationale: "Ready for direct implementation.",
        routeArtifactPath: "seed/factory-route.md",
        triageArtifactPath: "seed/factory-triage.json",
      },
    },
  });
}

function implementationEventTypes(fixture: ReturnType<typeof commandFixture>): string[] {
  return readFactoryLifecycleEvents({
    factoryStateRoot: fixture.factoryStateRoot,
    workItemKey: "linear:ENG-123",
  })
    .map((event) => event.type)
    .filter((type) => type.startsWith("implementation."));
}

test("real command prints truthful output before resolved-false start mutation error", async () => {
  const fixture = commandFixture({
    behavior: { update: async () => ({ success: false }) },
  });

  await expect(fixture.program.parseAsync(commandArgs(fixture))).rejects.toThrow(
    /Linear implementation start failed/,
  );

  expect(fixture.runner).not.toHaveBeenCalled();
  expect(fixture.commentInputs).toEqual([]);
  expect(implementationEventTypes(fixture)).toEqual([
    "implementation.started",
    "implementation.start-unresolved",
  ]);
  expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
    status: "implementation-failed",
    linearApplied: false,
  });
});

test("real command treats a falsy start rejection as an apply failure", async () => {
  const fixture = commandFixture({
    behavior: { update: async () => Promise.reject(undefined) },
  });

  await expect(fixture.program.parseAsync(commandArgs(fixture))).rejects.toBeUndefined();

  expect(fixture.runner).not.toHaveBeenCalled();
  expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
    status: "implementation-failed",
    linearApplied: false,
  });
});

test("real command rejects success-true start when fresh state did not change", async () => {
  const fixture = commandFixture({
    behavior: { update: async () => ({ success: true }) },
  });

  await expect(fixture.program.parseAsync(commandArgs(fixture))).rejects.toThrow(
    /postcondition requires Implementing/,
  );

  expect(fixture.runner).not.toHaveBeenCalled();
  expect(fixture.commentInputs).toEqual([]);
  expect(implementationEventTypes(fixture)).toEqual([
    "implementation.started",
    "implementation.start-unresolved",
  ]);
  expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({ linearApplied: false });
});

test("real command preserves local completion when terminal comment resolves false", async () => {
  const fixture = commandFixture({
    behavior: { comment: async () => ({ success: false }) },
  });

  await expect(fixture.program.parseAsync(commandArgs(fixture))).rejects.toThrow(
    /implementation completion comment failed/,
  );

  expect(fixture.runner).toHaveBeenCalledTimes(1);
  expect(implementationEventTypes(fixture)).toEqual([
    "implementation.started",
    "implementation.completed",
  ]);
  expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
    status: "implementation-complete",
    linearApplied: false,
    linearUpdate: {
      started: { stage: "started" },
      terminal: {
        stage: "completed",
        statusMutationCompleted: false,
        statusPostconditionVerified: true,
        commentPresent: false,
        commentMarker: expect.stringContaining("harness-factory:implementation:"),
        commentBody: expect.stringContaining(
          "Factory implementation complete; durable Factory review is ready.",
        ),
      },
    },
  });
});

test("real command treats a wrapped falsy terminal rejection as an apply failure", async () => {
  const fixture = commandFixture({
    behavior: { comment: async () => Promise.reject(undefined) },
  });

  await expect(fixture.program.parseAsync(commandArgs(fixture))).rejects.toThrow("undefined");

  expect(fixture.runner).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
    status: "implementation-complete",
    linearApplied: false,
  });
});

test("apply result records a falsy terminal rejection by presence", async () => {
  const { ctx, factoryStateRoot } = context();
  const result = await runFactoryImplementationWithLinearApply({
    ctx,
    factoryStateRoot,
    issueRef: "ENG-123",
    adapter: fakeLinearAdapter({
      applyImplementationStarted: async () => ({
        ...STARTED,
        runId: ctx.runId,
        runDir: ctx.runDir,
      }),
      applyImplementationCompleted: async () => Promise.reject(undefined),
    }),
    runImplementation: completeImplementation,
  });

  expect(result.terminalApplyFailed).toBe(true);
  expect(result.terminalApplyError).toBeUndefined();
});

test("real command reports verified failed-status progress when its retry comment resolves false", async () => {
  const fixture = commandFixture({
    runner: failedImplementation,
    behavior: { comment: async () => ({ success: false }) },
  });

  await expect(fixture.program.parseAsync(commandArgs(fixture))).rejects.toThrow(
    /implementation failure comment failed/,
  );

  expect(fixture.updates).toEqual([
    { stateId: "state-Implementing" },
    { stateId: "state-Implementation Failed" },
  ]);
  expect(implementationEventTypes(fixture)).toEqual([
    "implementation.started",
    "implementation.failed",
  ]);
  expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
    status: "implementation-failed",
    linearApplied: false,
    linearUpdate: {
      started: { stage: "started" },
      terminal: {
        stage: "failed",
        targetStatus: "Implementation Failed",
        statusMutationCompleted: true,
        statusPostconditionVerified: true,
        commentPresent: false,
        commentBody: expect.stringContaining("provider failed"),
      },
    },
  });
});

test("real command reports accepted failed-status write when postcondition is not verified", async () => {
  let fixture!: ReturnType<typeof commandFixture>;
  let updateCount = 0;
  fixture = commandFixture({
    runner: failedImplementation,
    behavior: {
      update: async () => {
        updateCount += 1;
        if (updateCount === 1) fixture.setLinearState("Implementing");
        return { success: true };
      },
    },
  });

  await expect(fixture.program.parseAsync(commandArgs(fixture))).rejects.toThrow(
    /postcondition requires Implementation Failed/,
  );

  expect(fixture.updates).toEqual([
    { stateId: "state-Implementing" },
    { stateId: "state-Implementation Failed" },
  ]);
  expect(fixture.commentInputs).toEqual([]);
  expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
    status: "implementation-failed",
    linearApplied: false,
    linearUpdate: {
      started: { stage: "started" },
      terminal: {
        stage: "failed",
        targetStatus: "Implementation Failed",
        statusMutationCompleted: true,
        statusPostconditionVerified: false,
        commentPresent: false,
        commentBody: expect.stringContaining("provider failed"),
      },
    },
  });
});

test("real command preserves local completion when Linear drifts before terminal apply", async () => {
  let fixture!: ReturnType<typeof commandFixture>;
  fixture = commandFixture({
    runner: async (ctx) => {
      fixture.setLinearState("Ready to Implement");
      return completeImplementation(ctx);
    },
  });

  await expect(fixture.program.parseAsync(commandArgs(fixture))).rejects.toThrow(
    /completion requires Implementing/,
  );

  expect(fixture.updates).toHaveLength(1);
  expect(fixture.commentInputs).toEqual([]);
  expect(implementationEventTypes(fixture)).toEqual([
    "implementation.started",
    "implementation.completed",
  ]);
  expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({ linearApplied: false });
});

test("real command preserves local failure when Linear drifts before terminal apply", async () => {
  let fixture!: ReturnType<typeof commandFixture>;
  fixture = commandFixture({
    runner: async (ctx) => {
      fixture.setLinearState("Ready to Implement");
      return failedImplementation(ctx);
    },
  });

  await expect(fixture.program.parseAsync(commandArgs(fixture))).rejects.toThrow(
    /failure requires Implementing/,
  );

  expect(fixture.updates).toHaveLength(1);
  expect(fixture.commentInputs).toEqual([]);
  expect(implementationEventTypes(fixture)).toEqual([
    "implementation.started",
    "implementation.failed",
  ]);
  expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
    status: "implementation-failed",
    linearApplied: false,
  });
});

test("real command re-fetches Linear inside the execution lease before context creation", async () => {
  let fixture!: ReturnType<typeof commandFixture>;
  fixture = commandFixture({
    lease: async (input) => {
      fixture.setLinearState("Planning");
      return input.action();
    },
  });

  await expect(fixture.program.parseAsync(commandArgs(fixture))).rejects.toThrow(
    /implementation accepts Ready to Implement/,
  );

  expect(fixture.runner).not.toHaveBeenCalled();
  expect(fixture.output).toEqual([]);
  expect(fixture.updates).toEqual([]);
  expect(implementationEventTypes(fixture)).toEqual([]);
});

test("item-file identity change releases and reacquires the refreshed work-item lease", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-item-swap-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "harness-implementation-item-swap-store-"));
  const itemPath = join(workspace, "item.json");
  const itemA = directItem("local:A");
  const itemB = directItem("local:B");
  writeFileSync(itemPath, `${JSON.stringify(itemA)}\n`, "utf8");
  writeFileSync(
    join(workspace, "harness.json"),
    JSON.stringify({
      defaultAgent: "cursor",
      agents: { cursor: { model: "grok-4.5" } },
      factory: {
        implementation: { roles: { implementer: { agent: "cursor", model: "grok-4.5" } } },
      },
    }),
    "utf8",
  );
  const leasedIds: string[] = [];
  const lease: NonNullable<FactoryCommandOptions["implementationExecutionLease"]> = async (
    input,
  ) => {
    leasedIds.push(input.workItem.id);
    if (leasedIds.length === 1) writeFileSync(itemPath, `${JSON.stringify(itemB)}\n`, "utf8");
    return input.action();
  };
  const runner = vi.fn(completeImplementation);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const program = new Command().exitOverride();
  addFactoryCommands(program, {
    positiveNumber: Number,
    defaultMaxRuntimeMs: 5_000,
    writeVerboseWorkflowEvent: () => undefined,
    implementationExecutionLease: lease,
    implementationRunner: runner,
    implementationAgentProviderFactory: () => ({
      name: "cursor",
      async run() {
        throw new Error("provider must be controlled by implementationRunner");
      },
    }),
  });

  await program.parseAsync([
    "node",
    "harness",
    "factory",
    "implementation",
    "run",
    "--workspace",
    workspace,
    "--item-file",
    itemPath,
    "--factory-store-root",
    storeRoot,
    "--factory-store-project-id",
    "test-project",
  ]);

  expect(leasedIds).toEqual(["local:A", "local:B"]);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0]![0].workItem.id).toBe("local:B");
  const factoryStateRoot = join(storeRoot, "projects/test-project/factory");
  expect(
    readFactoryLifecycleEvents({
      factoryStateRoot,
      workItemKey: deriveFactoryWorkItemKey(itemA),
    }),
  ).toEqual([]);
  expect(
    readFactoryLifecycleEvents({
      factoryStateRoot,
      workItemKey: deriveFactoryWorkItemKey(itemB),
    }).map((event) => event.type),
  ).toEqual(["work_item.imported", "implementation.started", "implementation.completed"]);
});

function directItem(id: string): FactoryWorkItem {
  return {
    id,
    source: "file",
    title: `Implement ${id}`,
    body: "Direct implementation.",
    labels: [],
    metadata: {
      factoryStage: "ready-to-implement",
      factoryRoute: "ready-to-implement",
      factoryNextAction: "implement-directly",
    },
  };
}
