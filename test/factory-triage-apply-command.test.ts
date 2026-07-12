import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runFactoryTriageWithLinearApply } from "../bin/factory-commands.ts";
import { appendFactoryActionEvent } from "../lib/factory-lifecycle-kernel.ts";
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
  const triageRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: "runs/factory/run-recovery/factory-triage.json",
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
    data: { expectedPredecessor: imported.id, inputRefs: [inputRef] },
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
  const actionKey = factoryActionKey({
    phaseRunId: runId,
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: request.id,
  });
  terminal.id = `${terminal.type}:${actionKey}`;
  writeFactoryActionResult(join(runDir, "actions", "1", "triageWorkItem", actionKey), terminal);
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      ...meta(context(projectRoot, false)),
      runId,
      runDir,
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

  writeFileSync(join(runDir, "factory-triage.json"), "{}\n");
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
    data: { expectedPredecessor: imported.id, inputRefs: [inputRef] },
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

test("persists a terminal failure when Linear phase start fails", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "triage-start-failure-"));
  const root = join(workspace, "state");
  const ctx = context(workspace, false);
  const startError = new Error("Linear unavailable");
  ctx.exportFailed = vi.fn(
    (): FactoryRunMeta => ({
      ...meta(ctx),
      status: "failed",
      error: startError.message,
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
    applyAdapter: fakeLinearAdapter({
      applyTriageStarted: vi.fn(async () => Promise.reject(startError)),
    }),
  });
  assertActionResult(result);

  expect(runTriage).not.toHaveBeenCalled();
  expect(result.terminalApplyError).toBe(startError);
  expect(result.next).toMatchObject({ kind: "wait", reason: "failed" });

  const createContext = vi.fn();
  const repeated = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext,
    applyAdapter: fakeLinearAdapter(),
  });
  expect(repeated).toEqual({
    waiting: true,
    phaseRunId: ctx.runId,
    next: expect.objectContaining({ kind: "wait", reason: "failed" }),
  });
  expect(createContext).not.toHaveBeenCalled();
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
  const first = await runFactoryTriageWithLinearApply({
    factoryStateRoot: root,
    workItem: WORK_ITEM,
    rerun: false,
    issueRef: "ENG-37",
    createContext: () => ctx,
    runTriage: failedRun,
  });
  assertActionResult(first);
  expect(first.next).toMatchObject({ kind: "invoke", scheduling: "retry", attempt: 1 });

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
