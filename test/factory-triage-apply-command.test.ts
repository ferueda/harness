import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function context(workspace: string, dryRun: boolean): FactoryRunContext {
  const runDir = join(workspace, "runs/run-new");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, "context"), { recursive: true });
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(WORK_ITEM));
  writeFileSync(join(runDir, "summary.md"), "summary");
  writeFileSync(join(runDir, "factory-route.json"), JSON.stringify({ command: "wait" }));
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
    exportFailed: vi.fn(),
  } as unknown as FactoryRunContext;
  if (!dryRun) {
    ctx.factoryStore = {
      storeRoot: workspace,
      projectId: "repo",
      projectRoot: workspace,
      factoryStateRoot: join(workspace, "state"),
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
  };
}

test.each([
  { prior: false, dryRun: true, expected: false },
  { prior: false, dryRun: false, expected: true },
])(
  "passes rerun guidance and apply intent: $prior/$dryRun",
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
        evidence: [{ kind: "tracker", path: null, summary: "Missing detail" }],
        questions: ["Which target?"],
        reconsiderWhen: null,
        suggestedNext: { action: "ask-human", command: null, artifact: null },
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
  const ctx = context(workspace, false);
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
  writeFileSync(join(ctx.runDir, "factory-route.json"), JSON.stringify({}));
  writeFileSync(
    join(ctx.runDir, "factory-triage.json"),
    JSON.stringify({
      route: "ready-to-plan",
      confidence: "high",
      rationale: "Needs plan",
      evidence: [{ kind: "repo-state", path: null, summary: "Needs design" }],
      questions: [],
      reconsiderWhen: null,
      suggestedNext: { action: "create-plan", command: null, artifact: null },
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
  expect(result.action).toMatchObject({ handler: "triageWorkItem", attempt: 1 });
  expect(result.next).toEqual({ kind: "wait", reason: "phase-command" });
});

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
      suggestedNext: { action: "ask-human", command: null, artifact: null },
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
});

test("recovers a persisted triage result without invoking the handler", async () => {
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
      suggestedNext: { action: "create-plan", command: null, artifact: null },
    }),
  );
  mkdirSync(join(runDir, "context"), { recursive: true });
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(WORK_ITEM));
  const inputRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: "runs/factory/run-recovery/context/work-item.json",
  });
  const runRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: "runs/factory/run-recovery/summary.md",
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
  mkdirSync(dirname(immutableTriagePath), { recursive: true });
  writeFileSync(immutableTriagePath, readFileSync(join(runDir, "factory-triage.json")));
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
  const createContext = vi.fn();
  const result = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext,
  });
  assertActionResult(result);
  expect(createContext).not.toHaveBeenCalled();
  expect(result.action.eventId).toBe(terminal.id);
  expect(result.next).toMatchObject({ kind: "wait", reason: "phase-command" });

  const repeated = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext,
  });
  expect(repeated).toEqual({
    waiting: true,
    phaseRunId: runId,
    next: expect.objectContaining({ kind: "wait", reason: "phase-command" }),
  });

  const applyTriageCompleted = vi.fn(async () => ({
    issueIdentifier: "ENG-37",
    runId,
    runDir,
    stage: "complete" as const,
    targetStatus: "Needs Plan",
  }));
  const retry = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext,
    applyAdapter: fakeLinearAdapter({ applyTriageCompleted }),
  });
  assertActionResult(retry);
  expect(createContext).not.toHaveBeenCalled();
  expect(applyTriageCompleted).toHaveBeenCalledOnce();
  expect(retry.terminalApplyError).toBeUndefined();

  writeFileSync(immutableTriagePath, "{}\n");
  await expect(
    runFactoryTriageWithLinearApply({
      factoryStateRoot: root,
      workItem: WORK_ITEM,
      rerun: false,
      issueRef: "ENG-37",
      createContext,
      applyAdapter: fakeLinearAdapter({ applyTriageCompleted }),
    }),
  ).rejects.toThrow(/hash mismatch/);
  expect(applyTriageCompleted).toHaveBeenCalledOnce();
});

test("recovers completed active-run artifacts without rerunning the provider", async () => {
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
  appendFactoryActionEvent({ factoryStateRoot: root, event: imported, expectedLastEventId: null });
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
  writeFileSync(join(runDir, "factory-route.json"), JSON.stringify({ command: "wait" }));
  writeFileSync(
    join(runDir, "factory-triage.json"),
    JSON.stringify({
      route: "needs-info",
      confidence: "high",
      rationale: "Need answer",
      evidence: [{ kind: "tracker", path: null, summary: "Needs clarification" }],
      questions: ["Which target?"],
      reconsiderWhen: null,
      suggestedNext: { action: "ask-human", command: null, artifact: null },
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
    actions: { triageWorkItem: { provider: "cursor", model: "grok-4.5" } },
  });
  const createContext = vi.fn((_signal: AbortSignal, existingRunId?: string) => {
    expect(existingRunId).toBe(runId);
    return ctx;
  });
  const runTriage = vi.fn(async () => ({ ...meta(ctx), runId, runDir }));
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      ...meta(ctx),
      runId,
      runDir,
      factoryStore: { factoryStateRoot: root },
    }),
  );

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
});

test("recovers failed provider metadata without rerunning the provider", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-failed-meta-"));
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
  writeFileSync(
    join(ctx.runDir, "meta.json"),
    JSON.stringify({
      ...meta(ctx),
      status: "failed",
      error: "provider failed",
      failureKind: "terminal",
      factoryStore: ctx.factoryStore,
    }),
  );
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
      suggestedNext: { action: "ask-human", command: null, artifact: null },
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
      factoryStore: { factoryStateRoot: root } as FactoryRunMeta["factoryStore"],
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
