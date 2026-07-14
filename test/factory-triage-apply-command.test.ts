import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { expect, test, vi } from "vitest";
import { runFactoryTriageWithLinearApply } from "../bin/factory-commands.ts";
import {
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import { writeFactoryActionResult } from "../lib/factory-action-result.ts";
import { createFactoryArtifactRef } from "../lib/factory-artifact-ref.ts";
import { factoryActionKey } from "../lib/factory-action-contract.ts";
import { writeFactoryPhaseRunIdentity } from "../lib/factory-phase-run.ts";
import type { FactoryLifecycleEvent as FactoryActionLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import type { FactoryRunContext, FactoryRunMeta } from "../lib/factory-run-context.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import { fakeLinearAdapter } from "./factory-linear-test-helpers.ts";

type TriageCoordinatorResult = Awaited<ReturnType<typeof runFactoryTriageWithLinearApply>>;

function assertActionResult(
  value: TriageCoordinatorResult,
): asserts value is Extract<TriageCoordinatorResult, { meta: FactoryRunMeta }> {
  if ("waiting" in value) throw new Error("Expected an action result");
}

const WORK_ITEM: FactoryWorkItem = {
  id: "linear:ENG-37",
  source: "linear",
  title: "Lifecycle triage",
  body: "",
  labels: [],
  metadata: { tracker: { source: "linear", id: "ENG-37" } },
};

function context(
  workspace: string,
  dryRun: boolean,
  factoryStateRoot = join(workspace, "state"),
): FactoryRunContext {
  const runDir = join(workspace, "runs/run-new");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, "context"), { recursive: true });
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(WORK_ITEM));
  writeFileSync(join(runDir, "summary.md"), "summary");
  writeFileSync(
    join(runDir, "factory-route.json"),
    JSON.stringify({
      route: "needs-info",
      nextAction: "ask-human",
      statusLabel: "needs-info",
      artifactRelPath: "factory-route.md",
      humanSummary: "Needs human clarification before routing further.",
    }),
  );
  const ctx = {
    runId: "run-new",
    runDir,
    workspace,
    workItem: WORK_ITEM,
    dryRun,
    executionProfile: { provider: "cursor", model: "test" },
    eventSink: () => {},
    invokeTriageAgent: vi.fn(),
    export: vi.fn(),
    exportFailed: vi.fn((error: unknown) => ({
      ...meta(ctx as unknown as FactoryRunContext),
      status: "failed" as const,
      failureKind: "terminal" as const,
      error: error instanceof Error ? error.message : String(error),
    })),
  } as unknown as FactoryRunContext;
  if (!dryRun) {
    ctx.factoryStore = {
      storeRoot: workspace,
      projectId: "repo",
      projectRoot: workspace,
      factoryStateRoot,
      factoryRunsDir: join(workspace, "runs"),
      reviewRunsDir: join(workspace, "reviews"),
      repo: { name: "repo", id: "repo", idSource: "config" },
      overrides: {},
      warnings: [],
    };
    writeFactoryPhaseRunIdentity(runDir, {
      version: 1,
      phaseRunId: ctx.runId,
      phase: "triage",
      workItemKey: "linear:ENG-37",
      workspace,
      projectId: ctx.factoryStore.projectId,
      factoryStateRoot: ctx.factoryStore.factoryStateRoot,
      actions: { triageWorkItem: ctx.executionProfile },
    });
  }
  return ctx;
}

function meta(ctx: FactoryRunContext): FactoryRunMeta {
  return {
    runId: ctx.runId,
    workflow: "factory-triage",
    status: "completed",
    workspace: ctx.workspace,
    runDir: ctx.runDir,
    workItem: { id: WORK_ITEM.id, source: "linear", title: WORK_ITEM.title },
    route: "needs-info",
    nextAction: "ask-human",
    artifacts: {
      triage: "factory-triage.json",
      route: "factory-route.md",
      routeSummary: "factory-route.md",
      summary: "summary.md",
    },
    agent: { name: "cursor", model: "test" },
    startedAt: "2026-07-09T00:00:00.000Z",
    durationMs: 1,
    ...(ctx.factoryStore ? { factoryStore: ctx.factoryStore } : {}),
  };
}

function writeProviderOutcome(
  ctx: FactoryRunContext,
  causationEventId: string,
  value: FactoryRunMeta,
  attempt = 1,
): void {
  const actionKey = factoryActionKey({
    phaseRunId: ctx.runId,
    handler: "triageWorkItem",
    attempt,
    causationEventId,
  });
  const path = join(
    ctx.runDir,
    "actions",
    String(attempt),
    "triageWorkItem",
    actionKey,
    "provider-result.json",
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      action: { phaseRunId: ctx.runId, handler: "triageWorkItem", attempt, causationEventId },
      meta: value,
    }),
  );
}

test.each([
  { prior: false, dryRun: true, expected: false },
  { prior: false, dryRun: false, expected: true },
])(
  "passes rerun guidance and apply intent with external tracker evidence: $prior/$dryRun",
  async ({ prior, dryRun, expected }) => {
    const workspace = mkdtempSync(join(tmpdir(), "triage-apply-run-"));
    const root = join(workspace, "state");
    const ctx = context(workspace, dryRun);
    writeFileSync(
      join(ctx.runDir, "factory-triage.json"),
      JSON.stringify({
        route: "needs-info",
        confidence: "high",
        rationale: "Question",
        evidence: [{ kind: "tracker", path: "linear:ENG-37", summary: "Missing detail" }],
        questions: ["Which target?"],
        reconsiderWhen: null,
      }),
    );
    const started = vi.fn(async () => ({
      issueIdentifier: "ENG-37",
      runId: ctx.runId,
      runDir: ctx.runDir,
      stage: "start" as const,
      targetStatus: "Triaging",
    }));
    const runTriage = vi.fn(async () => meta(ctx));
    const completedApply = vi.fn(async () => ({
      issueIdentifier: "ENG-37",
      runId: ctx.runId,
      runDir: ctx.runDir,
      stage: "complete" as const,
      targetStatus: "Needs Clarification",
    }));
    await runFactoryTriageWithLinearApply({
      factoryStateRoot: root,
      workItem: WORK_ITEM,
      rerun: prior,
      issueRef: "ENG-37",
      createContext: () => ctx,
      announceRunStarted: () => {},
      runTriage,
      applyAdapter: fakeLinearAdapter({
        applyTriageStarted: started,
        applyTriageCompleted: completedApply,
      }),
    });
    expect(runTriage).toHaveBeenCalledWith(ctx, { nextLiveRunRequiresRerun: expected });
    if (dryRun) {
      expect(started).not.toHaveBeenCalled();
      expect(completedApply).not.toHaveBeenCalled();
    } else {
      expect(started).toHaveBeenCalledWith(expect.objectContaining({ rerun: prior }));
      expect(completedApply).toHaveBeenCalledWith(
        expect.not.objectContaining({ rerun: expect.anything() }),
      );
    }
  },
);

test("new triage action invokes one handler and returns the next reaction", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-action-run-"));
  const root = join(workspace, "factory");
  const ctx = context(workspace, false, root);
  ctx.factoryStore = {
    storeRoot: workspace,
    projectId: "repo",
    projectRoot: workspace,
    factoryStateRoot: root,
    factoryRunsDir: join(workspace, "runs"),
    reviewRunsDir: join(workspace, "reviews"),
    repo: { name: "repo", id: "repo", idSource: "config" },
    overrides: {},
    warnings: [],
  };
  writeFileSync(join(ctx.runDir, "summary.md"), "summary");
  writeFileSync(
    join(ctx.runDir, "factory-route.json"),
    JSON.stringify({
      route: "ready-to-plan",
      nextAction: "create-plan",
      statusLabel: "ready-to-plan",
      artifactRelPath: "factory-route.md",
      humanSummary: "Needs an implementation plan before coding.",
    }),
  );
  writeFileSync(
    join(ctx.runDir, "factory-triage.json"),
    JSON.stringify({
      route: "ready-to-plan",
      confidence: "high",
      rationale: "Needs plan",
      evidence: [{ kind: "repo-state", path: null, summary: "Needs design" }],
      questions: [],
      reconsiderWhen: null,
    }),
  );
  const runTriage = vi.fn(async () => ({
    ...meta(ctx),
    route: "ready-to-plan" as const,
    nextAction: "create-plan" as const,
  }));
  const result = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext: () => ctx,
    runTriage,
  });
  assertActionResult(result);
  expect(result.meta.error).toBeUndefined();
  expect(result.meta).toMatchObject({ status: "completed" });
  expect(runTriage).toHaveBeenCalledOnce();
  expect(result.action).toMatchObject({ handler: "triageWorkItem", attempt: 1 });
  expect(result.next).toEqual({
    kind: "wait",
    reason: "phase-command",
    command: `harness factory planning run --workspace ${workspace} --linear-issue ENG-37 --apply`,
  });
});

test.each(["missing", "malformed"] as const)(
  "publishes terminal failure evidence for a %s completed route artifact",
  async (failure) => {
    const workspace = mkdtempSync(join(tmpdir(), "triage-route-failure-"));
    const root = join(workspace, "state");
    const ctx = context(workspace, false);
    writeFileSync(
      join(ctx.runDir, "factory-triage.json"),
      JSON.stringify({
        route: "needs-info",
        confidence: "high",
        rationale: "Need detail",
        evidence: [{ kind: "tracker", path: null, summary: "Missing detail" }],
        questions: ["Which target?"],
        reconsiderWhen: null,
      }),
    );
    if (failure === "missing") unlinkSync(join(ctx.runDir, "factory-route.json"));
    else writeFileSync(join(ctx.runDir, "factory-route.json"), "{not-json");
    const runProvider = vi.fn(async () => meta(ctx));

    const result = await runFactoryTriageWithLinearApply({
      factoryStateRoot: root,
      workItem: WORK_ITEM,
      rerun: false,
      issueRef: "ENG-37",
      createContext: () => ctx,
      runTriage: runProvider,
    });
    assertActionResult(result);
    expect(result.next).toEqual({ kind: "wait", reason: "failed" });
    expect(runProvider).toHaveBeenCalledOnce();
    const terminal = readFactoryActionEvents(root, "linear:ENG-37").at(-1)!;
    expect(terminal.type).toBe("factory.action.failed");
    if (terminal.type !== "factory.action.failed") throw new Error("Expected failure event");
    const failureRef = terminal.data.execution.runRef;
    expect(failureRef.path).toMatch(/\/evidence\/failure\.json$/);
    expect(existsSync(join(workspace, failureRef.path))).toBe(true);
  },
);

test("continues from an imported-only crash without replacing the import", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-imported-crash-"));
  const root = join(workspace, "state");
  const ctx = context(workspace, false);
  appendFactoryActionEvent({
    factoryStateRoot: root,
    expectedLastEventId: null,
    event: {
      version: 1,
      id: "work_item.imported:linear:ENG-37",
      type: "work_item.imported",
      workItemKey: "linear:ENG-37",
      occurredAt: "2026-07-11T00:00:00.000Z",
      data: { source: "linear" },
    },
  });
  writeFileSync(
    join(ctx.runDir, "factory-triage.json"),
    JSON.stringify({
      route: "needs-info",
      confidence: "high",
      rationale: "Need detail",
      evidence: [{ kind: "tracker", path: null, summary: "Missing detail" }],
      questions: ["Which target?"],
      reconsiderWhen: null,
    }),
  );
  const runTriage = vi.fn(async () => meta(ctx));
  const result = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext: () => ctx,
    runTriage,
  });
  assertActionResult(result);
  expect(runTriage).toHaveBeenCalledOnce();
  expect(result.next).toMatchObject({ kind: "wait", reason: "human" });
  expect(
    readFactoryActionEvents(root, "linear:ENG-37").filter(
      (event) => event.type === "work_item.imported",
    ),
  ).toHaveLength(1);
});

test("rejects a divergent deterministic imported event", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-divergent-import-"));
  const root = join(workspace, "state");
  const ctx = context(workspace, false);
  const createContext = vi.fn(() => {
    appendFactoryActionEvent({
      factoryStateRoot: root,
      expectedLastEventId: null,
      event: {
        version: 1,
        id: "work_item.imported:linear:ENG-37",
        type: "work_item.imported",
        workItemKey: "linear:ENG-37",
        occurredAt: "2026-07-11T00:00:00.000Z",
        data: { source: "github" },
      },
    });
    return ctx;
  });

  await expect(
    runFactoryTriageWithLinearApply({
      factoryStateRoot: root,
      workItem: WORK_ITEM,
      rerun: false,
      issueRef: "ENG-37",
      createContext,
    }),
  ).rejects.toThrow("already exists with different content");
});

test("reports a stale request cursor without executing a handler", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-stale-cursor-"));
  const root = join(workspace, "state");
  const ctx = context(workspace, false);
  const runTriage = vi.fn();
  const createContext = vi.fn(() => {
    const imported = appendFactoryActionEvent({
      factoryStateRoot: root,
      expectedLastEventId: null,
      event: {
        version: 1,
        id: "work_item.imported:linear:ENG-37",
        type: "work_item.imported",
        workItemKey: "linear:ENG-37",
        occurredAt: "2026-07-11T00:00:00.000Z",
        data: { source: "linear" },
      },
    });
    appendFactoryActionEvent({
      factoryStateRoot: root,
      expectedLastEventId: imported.event.id,
      event: {
        version: 1,
        id: "triage.requested:other-run",
        type: "triage.requested",
        workItemKey: "linear:ENG-37",
        occurredAt: "2026-07-11T00:01:00.000Z",
        phaseRunId: "other-run",
        data: {
          expectedPredecessor: imported.event.id,
          intent: "start",
          inputRefs: [
            createFactoryArtifactRef({
              base: "factory-store",
              root: workspace,
              path: relative(workspace, join(ctx.runDir, "context/work-item.json")),
            }),
          ],
        },
      },
    });
    return ctx;
  });

  await expect(
    runFactoryTriageWithLinearApply({
      factoryStateRoot: root,
      workItem: WORK_ITEM,
      rerun: false,
      issueRef: "ENG-37",
      createContext,
      runTriage,
    }),
  ).rejects.toThrow("lost the durable CAS");
  expect(runTriage).not.toHaveBeenCalled();
});

test("the handler rejects an injected command in a recovered PR 1 result", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "triage-recovery-"));
  const root = join(projectRoot, "factory");
  const runId = "run-recovery";
  const runDir = join(projectRoot, "runs", "factory", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "summary.md"), "recovered summary");
  writeFileSync(
    join(runDir, "factory-triage.json"),
    JSON.stringify({
      route: "ready-to-plan",
      confidence: "high",
      rationale: "Needs plan",
      evidence: [{ kind: "tracker", path: null, summary: "Needs design" }],
      questions: [],
      reconsiderWhen: null,
    }),
  );
  mkdirSync(join(runDir, "context"), { recursive: true });
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(WORK_ITEM));
  const inputRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: "runs/factory/run-recovery/context/work-item.json",
  });
  const actionKey = factoryActionKey({
    phaseRunId: runId,
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: `triage.requested:${runId}`,
  });
  const immutableTriagePath = join(
    runDir,
    "actions",
    "1",
    "triageWorkItem",
    actionKey,
    "evidence/factory-triage.json",
  );
  const immutableSummaryPath = join(dirname(immutableTriagePath), "summary.md");
  mkdirSync(dirname(immutableTriagePath), { recursive: true });
  writeFileSync(immutableTriagePath, readFileSync(join(runDir, "factory-triage.json")));
  writeFileSync(immutableSummaryPath, readFileSync(join(runDir, "summary.md")));
  const runRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: relative(projectRoot, immutableSummaryPath),
  });
  const triageRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: relative(projectRoot, immutableTriagePath),
  });
  const imported: FactoryActionLifecycleEvent = {
    version: 1,
    id: "work_item.imported:linear:ENG-37",
    type: "work_item.imported",
    workItemKey: "linear:ENG-37",
    occurredAt: "2026-07-11T00:00:00.000Z",
    data: { source: "linear" },
  };
  appendFactoryActionEvent({ factoryStateRoot: root, event: imported, expectedLastEventId: null });
  const request: Extract<FactoryActionLifecycleEvent, { type: "triage.requested" }> = {
    version: 1,
    id: `triage.requested:${runId}`,
    type: "triage.requested",
    workItemKey: "linear:ENG-37",
    occurredAt: "2026-07-11T00:01:00.000Z",
    phaseRunId: runId,
    data: { expectedPredecessor: imported.id, inputRefs: [inputRef], intent: "start" },
  };
  appendFactoryActionEvent({
    factoryStateRoot: root,
    event: request,
    expectedLastEventId: imported.id,
  });
  mkdirSync(join(runDir, "context"), { recursive: true });
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(WORK_ITEM));
  writeFactoryPhaseRunIdentity(runDir, {
    version: 1,
    phaseRunId: runId,
    phase: "triage",
    workItemKey: "linear:ENG-37",
    workspace: projectRoot,
    projectId: "repo",
    factoryStateRoot: root,
    actions: { triageWorkItem: { provider: "cursor", model: "grok-4.5" } },
  });
  const terminal: Extract<FactoryActionLifecycleEvent, { type: "triage.work_item.completed" }> = {
    version: 1,
    id: "placeholder",
    type: "triage.work_item.completed",
    workItemKey: "linear:ENG-37",
    occurredAt: "2026-07-11T00:02:00.000Z",
    phaseRunId: runId,
    data: {
      handler: "triageWorkItem",
      handlerVersion: 1,
      attempt: 1,
      causationEventId: request.id,
      execution: {
        workspaceRef: "repo",
        runRef,
      },
      evidence: [runRef, triageRef],
      route: "ready-to-plan",
      nextCommand: "harness factory planning run",
      rationale: "Needs plan",
    },
  };
  terminal.id = `${terminal.type}:${actionKey}`;
  writeFactoryActionResult(join(runDir, "actions", "1", "triageWorkItem", actionKey), terminal);
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      ...meta(context(projectRoot, false)),
      runId,
      runDir,
      route: "ready-to-plan",
      nextAction: "create-plan",
      factoryStore: { factoryStateRoot: root },
    }),
  );
  const recoveredContext = context(projectRoot, false);
  recoveredContext.runId = runId;
  recoveredContext.runDir = runDir;
  recoveredContext.factoryStore = {
    ...recoveredContext.factoryStore!,
    projectRoot,
    factoryStateRoot: root,
  };
  const createContext = vi.fn(() => recoveredContext);
  await expect(
    runFactoryTriageWithLinearApply({
      factoryStateRoot: root,
      workItem: WORK_ITEM,
      rerun: false,
      issueRef: "ENG-37",
      createContext,
    }),
  ).rejects.toThrow("Recovered PR 1 triage completion cannot contain a next command");
  expect(createContext).toHaveBeenCalledOnce();
});

async function assertCompletedProviderMetaRecovery(
  canonicalMeta: "missing" | "stale",
  mismatch?: "failed-status" | "wrong-route",
) {
  const projectRoot = mkdtempSync(join(tmpdir(), "triage-resume-"));
  const root = join(projectRoot, "factory");
  const runId = "run-active";
  const runDir = join(projectRoot, "runs", "factory", runId);
  mkdirSync(join(runDir, "context"), { recursive: true });
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(WORK_ITEM));
  const inputRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: "runs/factory/run-active/context/work-item.json",
  });
  const imported: FactoryActionLifecycleEvent = {
    version: 1,
    id: "work_item.imported:linear:ENG-37",
    type: "work_item.imported",
    workItemKey: "linear:ENG-37",
    occurredAt: "2026-07-11T00:00:00.000Z",
    data: { source: "linear" },
  };
  appendFactoryActionEvent({
    factoryStateRoot: root,
    event: imported,
    expectedLastEventId: null,
  });
  const request: Extract<FactoryActionLifecycleEvent, { type: "triage.requested" }> = {
    version: 1,
    id: `triage.requested:${runId}`,
    type: "triage.requested",
    workItemKey: imported.workItemKey,
    occurredAt: "2026-07-11T00:01:00.000Z",
    phaseRunId: runId,
    data: { expectedPredecessor: imported.id, inputRefs: [inputRef], intent: "start" },
  };
  appendFactoryActionEvent({
    factoryStateRoot: root,
    event: request,
    expectedLastEventId: imported.id,
  });
  const ctx = context(projectRoot, false);
  ctx.runId = runId;
  ctx.runDir = runDir;
  ctx.factoryStore = {
    ...ctx.factoryStore!,
    projectRoot,
    projectId: "repo",
    factoryStateRoot: root,
    repo: { name: "repo", id: "repo", idSource: "config" },
  };
  mkdirSync(join(runDir, "context"), { recursive: true });
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(WORK_ITEM));
  writeFileSync(join(runDir, "summary.md"), "summary");
  writeFileSync(
    join(runDir, "factory-route.json"),
    JSON.stringify({
      route: "needs-info",
      nextAction: "ask-human",
      statusLabel: "needs-info",
      artifactRelPath: "factory-route.md",
      humanSummary: "Needs human clarification before routing further.",
    }),
  );
  writeFileSync(
    join(runDir, "factory-triage.json"),
    JSON.stringify({
      route: "needs-info",
      confidence: "high",
      rationale: "Need answer",
      evidence: [{ kind: "tracker", path: null, summary: "Needs clarification" }],
      questions: ["Which target?"],
      reconsiderWhen: null,
    }),
  );
  writeFactoryPhaseRunIdentity(runDir, {
    version: 1,
    phaseRunId: runId,
    phase: "triage",
    workItemKey: imported.workItemKey,
    workspace: projectRoot,
    projectId: "repo",
    factoryStateRoot: root,
    actions: { triageWorkItem: ctx.executionProfile },
  });
  const createContext = vi.fn((_signal: AbortSignal, existingRunId?: string) => {
    expect(existingRunId).toBe(runId);
    return ctx;
  });
  const runTriage = vi.fn(async () => ({ ...meta(ctx), runId, runDir }));
  if (canonicalMeta === "stale") {
    writeFileSync(
      join(runDir, "meta.json"),
      JSON.stringify({
        ...meta(ctx),
        status: "failed",
        error: "prior retry failed",
        failureKind: "retryable",
      }),
    );
  }
  const providerMeta: FactoryRunMeta = {
    ...meta(ctx),
    runId,
    runDir,
    ...(mismatch === "failed-status"
      ? { status: "failed", error: "provider failed", failureKind: "terminal" }
      : mismatch === "wrong-route"
        ? { route: "ready-to-plan", nextAction: "create-plan" }
        : {}),
  };
  writeProviderOutcome(ctx, request.id, providerMeta);

  if (mismatch) {
    const actionKey = factoryActionKey({
      phaseRunId: runId,
      handler: "triageWorkItem",
      attempt: 1,
      causationEventId: request.id,
    });
    const actionDir = join(runDir, "actions/1/triageWorkItem", actionKey);
    const summaryPath = join(actionDir, "evidence/summary.md");
    const triagePath = join(actionDir, "evidence/factory-triage.json");
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, readFileSync(join(runDir, "summary.md")));
    writeFileSync(triagePath, readFileSync(join(runDir, "factory-triage.json")));
    const summaryRef = createFactoryArtifactRef({
      base: "factory-store",
      root: projectRoot,
      path: relative(projectRoot, summaryPath),
    });
    const triageRef = createFactoryArtifactRef({
      base: "factory-store",
      root: projectRoot,
      path: relative(projectRoot, triagePath),
    });
    writeFactoryActionResult(actionDir, {
      version: 1,
      id: `triage.work_item.completed:${actionKey}`,
      type: "triage.work_item.completed",
      workItemKey: imported.workItemKey,
      occurredAt: "2026-07-11T00:02:00.000Z",
      phaseRunId: runId,
      data: {
        handler: "triageWorkItem",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: request.id,
        execution: { workspaceRef: "repo", runRef: summaryRef },
        evidence: [summaryRef, triageRef],
        route: "needs-info",
        rationale: "Need answer",
      },
    });

    await expect(
      runFactoryTriageWithLinearApply({
        factoryStateRoot: root,
        workspace: projectRoot,
        projectId: "repo",
        workItem: WORK_ITEM,
        rerun: false,
        issueRef: "ENG-37",
        createContext,
        runTriage,
      }),
    ).rejects.toThrow("conflicts with action-bound provider metadata");
    expect(existsSync(join(runDir, "meta.json"))).toBe(false);
    expect(readFactoryActionEvents(root, imported.workItemKey).at(-1)?.id).toBe(request.id);
    expect(runTriage).not.toHaveBeenCalled();
    return;
  }

  const result = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workspace: projectRoot,
    projectId: "repo",
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext,
    runTriage,
  });
  assertActionResult(result);

  expect(createContext).toHaveBeenCalledOnce();
  expect(runTriage).not.toHaveBeenCalled();
  expect(result.phaseRunId).toBe(runId);

  const repeated = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workspace: projectRoot,
    projectId: "repo",
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext,
    runTriage,
  });
  expect(repeated).toMatchObject({
    waiting: true,
    phaseRunId: runId,
    next: { kind: "wait", reason: "human" },
  });
  expect(JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"))).toMatchObject({
    status: "completed",
    runId,
  });
  expect(runTriage).not.toHaveBeenCalled();
}

test("recovers action-bound provider metadata when canonical meta is missing", async () => {
  await expect(assertCompletedProviderMetaRecovery("missing")).resolves.toBeUndefined();
});

test("replaces stale canonical meta with validated action-bound provider metadata", async () => {
  await expect(assertCompletedProviderMetaRecovery("stale")).resolves.toBeUndefined();
});

test.each(["failed-status", "wrong-route"] as const)(
  "rejects completed action-result joined to %s provider metadata",
  async (mismatch) => {
    await expect(assertCompletedProviderMetaRecovery("missing", mismatch)).resolves.toBeUndefined();
  },
);

test("recovers immutable finalization failure without rerunning the provider", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-failed-meta-"));
  const root = join(workspace, "state");
  const ctx = context(workspace, false);
  ctx.runDir = join(workspace, "runs", "factory", ctx.runId);
  mkdirSync(join(ctx.runDir, "context"), { recursive: true });
  writeFileSync(join(ctx.runDir, "context/work-item.json"), JSON.stringify(WORK_ITEM));
  writeFactoryPhaseRunIdentity(ctx.runDir, {
    version: 1,
    phaseRunId: ctx.runId,
    phase: "triage",
    workItemKey: "linear:ENG-37",
    workspace,
    projectId: ctx.factoryStore!.projectId,
    factoryStateRoot: root,
    actions: { triageWorkItem: ctx.executionProfile },
  });
  const inputRef = createFactoryArtifactRef({
    base: "factory-store",
    root: workspace,
    path: relative(workspace, join(ctx.runDir, "context/work-item.json")),
  });
  const imported: FactoryActionLifecycleEvent = {
    version: 1,
    id: "work_item.imported:linear:ENG-37",
    type: "work_item.imported",
    workItemKey: "linear:ENG-37",
    occurredAt: "2026-07-11T00:00:00.000Z",
    data: { source: "linear" },
  };
  appendFactoryActionEvent({ factoryStateRoot: root, event: imported, expectedLastEventId: null });
  appendFactoryActionEvent({
    factoryStateRoot: root,
    expectedLastEventId: imported.id,
    event: {
      version: 1,
      id: `triage.requested:${ctx.runId}`,
      type: "triage.requested",
      workItemKey: "linear:ENG-37",
      occurredAt: "2026-07-11T00:01:00.000Z",
      phaseRunId: ctx.runId,
      data: { expectedPredecessor: imported.id, inputRefs: [inputRef], intent: "start" },
    },
  });
  const failedMeta: FactoryRunMeta = {
    ...meta(ctx),
    status: "failed",
    error: "provider failed",
    failureKind: "terminal",
    factoryStore: ctx.factoryStore,
  };
  const causationEventId = `triage.requested:${ctx.runId}`;
  writeProviderOutcome(ctx, causationEventId, meta(ctx));
  const actionKey = factoryActionKey({
    phaseRunId: ctx.runId,
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId,
  });
  const failurePath = join(
    ctx.runDir,
    "actions/1/triageWorkItem",
    actionKey,
    "evidence/failure.json",
  );
  mkdirSync(dirname(failurePath), { recursive: true });
  writeFileSync(failurePath, `${JSON.stringify(failedMeta, null, 2)}\n`);
  const runTriage = vi.fn();
  const result = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext: (_signal, existingRunId) => {
      expect(existingRunId).toBe(ctx.runId);
      return ctx;
    },
    runTriage,
  });
  assertActionResult(result);
  expect(runTriage).not.toHaveBeenCalled();
  expect(result.meta.status).toBe("failed");
  expect(readFactoryActionEvents(root, "linear:ENG-37").at(-1)).toMatchObject({
    type: "factory.action.failed",
    data: { message: "provider failed" },
  });
  expect(ctx.exportFailed).not.toHaveBeenCalled();

  const repeated = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext: () => ctx,
    runTriage,
  });
  expect(repeated).toMatchObject({
    waiting: true,
    phaseRunId: ctx.runId,
    next: { kind: "wait", reason: "failed" },
  });
  expect(runTriage).not.toHaveBeenCalled();
});

test("rejects a recovered triage artifact outside the phase run", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-escaped-meta-"));
  const root = join(workspace, "state");
  const ctx = context(workspace, false);
  const inputRef = createFactoryArtifactRef({
    base: "factory-store",
    root: workspace,
    path: relative(workspace, join(ctx.runDir, "context/work-item.json")),
  });
  const imported: FactoryActionLifecycleEvent = {
    version: 1,
    id: "work_item.imported:linear:ENG-37",
    type: "work_item.imported",
    workItemKey: "linear:ENG-37",
    occurredAt: "2026-07-11T00:00:00.000Z",
    data: { source: "linear" },
  };
  appendFactoryActionEvent({ factoryStateRoot: root, event: imported, expectedLastEventId: null });
  appendFactoryActionEvent({
    factoryStateRoot: root,
    expectedLastEventId: imported.id,
    event: {
      version: 1,
      id: `triage.requested:${ctx.runId}`,
      type: "triage.requested",
      workItemKey: "linear:ENG-37",
      occurredAt: "2026-07-11T00:01:00.000Z",
      phaseRunId: ctx.runId,
      data: { expectedPredecessor: imported.id, inputRefs: [inputRef], intent: "start" },
    },
  });
  const completed = { ...meta(ctx), factoryStore: ctx.factoryStore };
  completed.artifacts = { ...completed.artifacts!, triage: "../secret.json" };
  writeFileSync(join(ctx.runDir, "meta.json"), JSON.stringify(completed));
  writeProviderOutcome(ctx, `triage.requested:${ctx.runId}`, completed);
  ctx.exportFailed = vi.fn(
    (error: unknown): FactoryRunMeta => ({
      ...completed,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      failureKind: "terminal",
    }),
  );
  const runTriage = vi.fn();
  const result = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext: () => ctx,
    runTriage,
  });
  assertActionResult(result);
  expect(runTriage).not.toHaveBeenCalled();
  expect(result.meta.error).toMatch(/must be factory-triage.json/);
  expect(result.next).toMatchObject({ kind: "wait", reason: "failed" });
});

test("leaves the durable triage request pending when Linear phase start fails", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-start-failure-"));
  const root = join(workspace, "state");
  const ctx = context(workspace, false);
  const startError = new Error("Linear unavailable");
  ctx.exportFailed = vi.fn(
    (error: unknown): FactoryRunMeta => ({
      ...meta(ctx),
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      failureKind: "terminal",
    }),
  );
  const runTriage = vi.fn();

  await expect(
    runFactoryTriageWithLinearApply({
      factoryStateRoot: root,
      workItem: WORK_ITEM,
      rerun: false,
      issueRef: "ENG-37",
      createContext: () => ctx,
      runTriage,
      applyAdapter: fakeLinearAdapter({
        applyTriageStarted: vi.fn(async () => Promise.reject(startError)),
      }),
    }),
  ).rejects.toThrow(/Linear start projection failed: Linear unavailable/);
  expect(runTriage).not.toHaveBeenCalled();
  expect(readFactoryActionEvents(root, "linear:ENG-37").at(-1)).toMatchObject({
    type: "triage.requested",
    phaseRunId: ctx.runId,
  });

  const createContext = vi.fn(() => ctx);
  const resumedStart = vi.fn(async () => ({
    issueIdentifier: "ENG-37",
    runId: ctx.runId,
    runDir: ctx.runDir,
    stage: "start" as const,
    targetStatus: "Triaging",
  }));
  const repeated = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext,
    applyAdapter: fakeLinearAdapter({
      applyTriageStarted: resumedStart,
    }),
  });
  assertActionResult(repeated);
  expect(repeated.phaseRunId).toBe(ctx.runId);
  expect(createContext).toHaveBeenCalledOnce();
  expect(resumedStart).toHaveBeenCalledWith(expect.objectContaining({ resume: true }));
});

test("retries the same triage action and phase run after a retryable failure", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-retry-"));
  const root = join(workspace, "state");
  const ctx = context(workspace, false);
  ctx.exportFailed = vi.fn(
    (): FactoryRunMeta => ({
      ...meta(ctx),
      status: "failed",
      error: "provider unavailable",
      failureKind: "retryable",
    }),
  );
  const failedRun = vi.fn(async () => Promise.reject(new Error("provider unavailable")));
  const applyTriageFailed = vi.fn();
  const applyTriageStarted = vi.fn(async () => ({
    issueIdentifier: "ENG-37",
    runId: ctx.runId,
    runDir: ctx.runDir,
    stage: "start" as const,
    targetStatus: "Triaging",
  }));
  const first = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext: () => ctx,
    runTriage: failedRun,
    applyAdapter: fakeLinearAdapter({ applyTriageStarted, applyTriageFailed }),
  });
  assertActionResult(first);
  expect(first.next).toMatchObject({ kind: "invoke", scheduling: "retry", attempt: 1 });
  expect(applyTriageFailed).not.toHaveBeenCalled();

  writeFileSync(
    join(ctx.runDir, "factory-triage.json"),
    JSON.stringify({
      route: "needs-info",
      confidence: "high",
      rationale: "Need answer",
      evidence: [{ kind: "tracker", path: null, summary: "Need clarification" }],
      questions: ["Which target?"],
      reconsiderWhen: null,
    }),
  );
  const successfulRun = vi.fn(async () => meta(ctx));
  const second = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext: (_signal, existingRunId) => {
      expect(existingRunId).toBe(ctx.runId);
      return ctx;
    },
    runTriage: successfulRun,
  });
  assertActionResult(second);
  expect(successfulRun).toHaveBeenCalledOnce();
  expect(second.phaseRunId).toBe(first.phaseRunId);
  expect(second.action.attempt).toBe(1);
});

test("retries a failed terminal projection without rerunning the provider", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-failed-projection-"));
  const root = join(workspace, "state");
  const ctx = context(workspace, false);
  ctx.runDir = join(workspace, "runs", "factory", ctx.runId);
  ctx.factoryStore = { ...ctx.factoryStore!, factoryStateRoot: root, projectRoot: workspace };
  mkdirSync(join(ctx.runDir, "context"), { recursive: true });
  writeFileSync(join(ctx.runDir, "context/work-item.json"), JSON.stringify(WORK_ITEM));
  writeFactoryPhaseRunIdentity(ctx.runDir, {
    version: 1,
    phaseRunId: ctx.runId,
    phase: "triage",
    workItemKey: "linear:ENG-37",
    workspace,
    projectId: ctx.factoryStore.projectId,
    factoryStateRoot: root,
    actions: { triageWorkItem: ctx.executionProfile },
  });
  writeFileSync(join(ctx.runDir, "summary.md"), "summary");
  writeFileSync(join(ctx.runDir, "factory-route.json"), JSON.stringify({ command: null }));
  ctx.exportFailed = vi.fn(
    (error: unknown): FactoryRunMeta => ({
      ...meta(ctx),
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      failureKind: "terminal",
    }),
  );
  const runTriage = vi.fn(async () => Promise.reject(new Error("invalid output")));
  const projectionError = new Error("Linear unavailable");
  const failedProjection = vi.fn(async () => Promise.reject(projectionError));
  const first = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext: () => ctx,
    runTriage,
    applyAdapter: fakeLinearAdapter({
      applyTriageStarted: async () => ({
        issueIdentifier: "ENG-37",
        runId: ctx.runId,
        runDir: ctx.runDir,
        stage: "start",
        targetStatus: "Triaging",
      }),
      applyTriageFailed: failedProjection,
    }),
  });
  assertActionResult(first);
  expect(first.terminalApplyError).toBe(projectionError);
  writeFileSync(join(ctx.runDir, "meta.json"), JSON.stringify(first.meta));

  writeFileSync(
    join(ctx.runDir, "meta.json"),
    JSON.stringify({ ...first.meta, error: "tampered failure" }),
  );
  await expect(
    runFactoryTriageWithLinearApply({
      factoryStateRoot: root,
      workItem: WORK_ITEM,
      rerun: false,
      issueRef: "ENG-37",
      createContext: vi.fn(),
      applyAdapter: fakeLinearAdapter({ applyTriageFailed: vi.fn() }),
    }),
  ).rejects.toThrow(/failure metadata conflicts/);
  writeFileSync(join(ctx.runDir, "meta.json"), JSON.stringify(first.meta));

  const recoveredProjection = vi.fn(async () => ({
    issueIdentifier: "ENG-37",
    runId: ctx.runId,
    runDir: ctx.runDir,
    stage: "failed" as const,
    targetStatus: "Triage Failed",
  }));
  const createContext = vi.fn();
  const second = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext,
    applyAdapter: fakeLinearAdapter({ applyTriageFailed: recoveredProjection }),
  });
  assertActionResult(second);
  expect(createContext).not.toHaveBeenCalled();
  expect(runTriage).toHaveBeenCalledOnce();
  expect(recoveredProjection).toHaveBeenCalledOnce();
  expect(second.terminalApplyError).toBeUndefined();
});
