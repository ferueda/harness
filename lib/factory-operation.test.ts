import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Agent } from "./agents.ts";
import { createFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { writeFactoryActionResult } from "./factory-action-result.ts";
import {
  actionLifecycleEventPath,
  actionLifecycleStatePath,
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle.ts";
import {
  createFactoryOperationRef,
  executeFactoryOperation,
  resolveFactoryOperation,
  type FactoryOperationRef,
} from "./factory-operation.ts";
import { writeFactoryPhaseRunIdentity } from "./factory-phase-run.ts";

const projectId = "project-1";
const workItemKey = "linear:ITEM-1";
const phaseRunId = "triage-run";
const profile = { provider: "cursor" as const, model: "test-model" };
const inputRef = {
  base: "factory-store" as const,
  path: "inputs/item.json",
  sha256: "0".repeat(64),
};
const workItem = {
  id: "linear:ITEM-1",
  source: "linear" as const,
  title: "Factory operation",
  body: "Execute once",
  labels: [],
};
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "factory-operation-"));
  temporaryRoots.push(projectRoot);
  const factoryStateRoot = join(projectRoot, "factory");
  const runDir = join(projectRoot, "runs", "factory", phaseRunId);
  const workspace = join(projectRoot, "workspace");
  mkdirSync(join(runDir, "context"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(workItem));
  writeFileSync(join(runDir, "factory-triage.prompt.md"), "triage prompt");
  const durableInputRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: "runs/factory/triage-run/context/work-item.json",
  });
  writeFactoryPhaseRunIdentity(runDir, {
    version: 1,
    phaseRunId,
    phase: "triage",
    workItemKey,
    workspace,
    projectId,
    factoryStateRoot,
    actions: { triageWorkItem: profile },
  });
  const imported: FactoryLifecycleEvent = {
    version: 1,
    id: "import:item-1",
    type: "work_item.imported",
    workItemKey,
    occurredAt: "2026-07-15T20:00:00.000Z",
    data: { source: "linear" },
  };
  const requested: FactoryLifecycleEvent = {
    version: 1,
    id: "triage-requested",
    type: "triage.requested",
    workItemKey,
    occurredAt: "2026-07-15T20:01:00.000Z",
    phaseRunId,
    data: {
      expectedPredecessor: imported.id,
      inputRefs: [durableInputRef],
      intent: "start",
    },
  };
  appendFactoryActionEvent({
    factoryStateRoot,
    event: imported,
    expectedLastEventId: null,
  });
  appendFactoryActionEvent({
    factoryStateRoot,
    event: requested,
    expectedLastEventId: imported.id,
  });
  const operation = createFactoryOperationRef({
    phaseRunId,
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: requested.id,
  });
  const factoryStore = {
    storeRoot: projectRoot,
    projectId,
    projectRoot,
    factoryStateRoot,
    factoryRunsDir: join(projectRoot, "runs", "factory"),
    reviewRunsDir: join(projectRoot, "runs", "reviews"),
    repo: { name: "project", id: projectId, idSource: "config" as const },
    overrides: {},
    warnings: [],
  };
  return {
    projectRoot,
    factoryStateRoot,
    runDir,
    workspace,
    requested,
    operation,
    inputRef: durableInputRef,
    factoryStore,
  };
}

function resolveFixture(
  value: ReturnType<typeof fixture>,
  operation: FactoryOperationRef = value.operation,
) {
  return resolveFactoryOperation({
    projectId,
    projectRoot: value.projectRoot,
    factoryStateRoot: value.factoryStateRoot,
    workItemKey,
    operation,
  });
}

function completedEvent(
  value: ReturnType<typeof fixture>,
): Extract<FactoryLifecycleEvent, { type: "triage.work_item.completed" }> {
  return {
    version: 1,
    id: `triage.work_item.completed:${value.operation.actionKey}`,
    type: "triage.work_item.completed",
    workItemKey,
    occurredAt: "2026-07-15T20:02:00.000Z",
    phaseRunId,
    data: {
      handler: "triageWorkItem",
      handlerVersion: 1,
      attempt: 1,
      causationEventId: value.requested.id,
      execution: { workspaceRef: "unused", runRef: value.inputRef },
      evidence: [value.inputRef],
      route: "ready-to-plan",
      rationale: "Ready",
    },
  };
}

function actionDir(value: ReturnType<typeof fixture>): string {
  return join(value.runDir, "actions", "1", "triageWorkItem", value.operation.actionKey);
}

test("resolves the exact durable reaction as current without workspace access", () => {
  const value = fixture();
  const before = durableFiles(value.projectRoot);

  expect(resolveFixture(value)).toMatchObject({
    status: "current",
    operation: value.operation,
    reaction: {
      kind: "invoke",
      handler: "triageWorkItem",
      attempt: 1,
      causationEventId: value.requested.id,
    },
  });
  expect(durableFiles(value.projectRoot)).toEqual(before);
});

test("recovers an authenticated completed result before lifecycle append", () => {
  const value = fixture();
  const event = completedEvent(value);
  writeFactoryActionResult(actionDir(value), event);

  expect(resolveFixture(value)).toEqual({ status: "completed", operation: value.operation, event });
});

test("rejects a schema-valid result type owned by another handler", () => {
  const value = fixture();
  const event: Extract<FactoryLifecycleEvent, { type: "implementation.candidate.produced" }> = {
    version: 1,
    id: `implementation.candidate.produced:${value.operation.actionKey}`,
    type: "implementation.candidate.produced",
    workItemKey,
    occurredAt: "2026-07-15T20:02:00.000Z",
    phaseRunId,
    data: {
      handler: "triageWorkItem",
      handlerVersion: 1,
      attempt: 1,
      causationEventId: value.requested.id,
      execution: { workspaceRef: "unused", runRef: inputRef },
      evidence: [inputRef],
      commit: "candidate-commit",
      tree: "candidate-tree",
      candidate: inputRef,
      effectiveSession: { provider: "test", id: "session-1" },
    },
  };
  writeFactoryActionResult(actionDir(value), event);

  expect(() => resolveFixture(value)).toThrow(/result type does not match handler/);
});

test("recovers a failed result when its handler and action identity match", () => {
  const value = fixture();
  const event: Extract<FactoryLifecycleEvent, { type: "factory.action.failed" }> = {
    version: 1,
    id: `factory.action.failed:${value.operation.actionKey}`,
    type: "factory.action.failed",
    workItemKey,
    occurredAt: "2026-07-15T20:02:00.000Z",
    phaseRunId,
    data: {
      handler: "triageWorkItem",
      handlerVersion: 1,
      attempt: 1,
      causationEventId: value.requested.id,
      execution: { workspaceRef: "unused", runRef: inputRef },
      evidence: [inputRef],
      phase: "triage",
      failureKind: "terminal",
      message: "Provider failed",
    },
  };
  writeFactoryActionResult(actionDir(value), event);

  expect(resolveFixture(value)).toEqual({ status: "completed", operation: value.operation, event });
});

test("distinguishes a stale operation from the current invocation", () => {
  const value = fixture();
  const stale = createFactoryOperationRef({
    ...value.operation,
    causationEventId: "older-request",
  });

  expect(resolveFixture(value, stale)).toMatchObject({
    status: "stale",
    reaction: { kind: "invoke", causationEventId: value.requested.id },
  });
});

test("returns wait when durable state has no invocation", () => {
  const value = fixture();
  const event = completedEvent(value);
  appendFactoryActionEvent({
    factoryStateRoot: value.factoryStateRoot,
    event,
    expectedLastEventId: value.requested.id,
  });

  expect(resolveFixture(value)).toMatchObject({
    status: "wait",
    reaction: { kind: "wait", reason: "phase-command" },
  });
});

test("executes the authenticated triage handler once and returns its persisted result", async () => {
  const value = fixture();
  const eventPath = actionLifecycleEventPath(value.factoryStateRoot, workItemKey);
  const statePath = actionLifecycleStatePath(value.factoryStateRoot, workItemKey);
  const lifecycleBefore = readFileSync(eventPath, "utf8");
  const stateBefore = readFileSync(statePath, "utf8");
  const providerRun = vi.fn<Agent["run"]>();
  const runProvider = vi.fn(async () => ({
    runId: phaseRunId,
    workflow: "factory-triage" as const,
    status: "failed" as const,
    workspace: value.workspace,
    runDir: value.runDir,
    workItem: { id: workItem.id, source: workItem.source, title: workItem.title },
    agent: { name: "cursor" as const, model: profile.model },
    startedAt: "2026-07-15T20:02:00.000Z",
    durationMs: 1,
    error: "retry later",
    failureKind: "retryable" as const,
    factoryStore: value.factoryStore,
  }));

  const result = await executeFactoryOperation({
    operation: value.operation,
    factoryStore: value.factoryStore,
    workspace: value.workspace,
    workItem,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
    triage: { nextLiveRunRequiresRerun: true, runProvider },
  });

  expect(result.event).toMatchObject({
    type: "factory.action.failed",
    data: { handler: "triageWorkItem", failureKind: "retryable" },
  });
  expect(result.state.lastEventId).toBe(result.event.id);
  expect(runProvider).toHaveBeenCalledOnce();
  expect(providerRun).not.toHaveBeenCalled();
  expect(readFactoryActionEvents(value.factoryStateRoot, workItemKey)).toHaveLength(3);

  // Simulate a crash after the action result was staged but before its lifecycle append.
  writeFileSync(eventPath, lifecycleBefore);
  writeFileSync(statePath, stateBefore);
  const recovered = await executeFactoryOperation({
    operation: value.operation,
    factoryStore: value.factoryStore,
    workspace: value.workspace,
    workItem,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
    triage: { nextLiveRunRequiresRerun: true, runProvider },
  });
  expect(recovered.event.id).toBe(result.event.id);
  expect(runProvider).toHaveBeenCalledOnce();
  expect(readFactoryActionEvents(value.factoryStateRoot, workItemKey)).toHaveLength(3);
});

test("rejects stale and waiting operations before invoking a provider", async () => {
  const staleValue = fixture();
  const providerRun = vi.fn<Agent["run"]>();
  const stale = createFactoryOperationRef({
    ...staleValue.operation,
    causationEventId: "older-request",
  });
  const beforeStale = durableFiles(staleValue.projectRoot);
  await expect(
    executeFactoryOperation({
      operation: stale,
      factoryStore: staleValue.factoryStore,
      workspace: staleValue.workspace,
      workItem,
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
      triage: { nextLiveRunRequiresRerun: true },
    }),
  ).rejects.toThrow(/stale/);
  expect(providerRun).not.toHaveBeenCalled();
  expect(durableFiles(staleValue.projectRoot)).toEqual(beforeStale);

  const waitingValue = fixture();
  appendFactoryActionEvent({
    factoryStateRoot: waitingValue.factoryStateRoot,
    event: completedEvent(waitingValue),
    expectedLastEventId: waitingValue.requested.id,
  });
  const beforeWait = durableFiles(waitingValue.projectRoot);
  await expect(
    executeFactoryOperation({
      operation: waitingValue.operation,
      factoryStore: waitingValue.factoryStore,
      workspace: waitingValue.workspace,
      workItem,
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
      triage: { nextLiveRunRequiresRerun: true },
    }),
  ).rejects.toThrow(/waiting/);
  expect(providerRun).not.toHaveBeenCalled();
  expect(durableFiles(waitingValue.projectRoot)).toEqual(beforeWait);
});

test("rejects mismatched execution identity before invoking a provider", async () => {
  const value = fixture();
  const providerRun = vi.fn<Agent["run"]>();
  const base = {
    factoryStore: value.factoryStore,
    workspace: value.workspace,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor" as const, run: providerRun }),
    triage: { nextLiveRunRequiresRerun: true },
  };
  const mismatches = [
    { operation: { ...value.operation, actionKey: "f".repeat(64) }, workItem },
    { operation: value.operation, workItem: { ...workItem, id: "linear:OTHER-1" } },
    {
      operation: createFactoryOperationRef({
        phaseRunId,
        handler: "producePlanCandidate",
        attempt: 1,
        causationEventId: value.requested.id,
      }),
      workItem,
    },
  ];

  for (const mismatch of mismatches) {
    await expect(executeFactoryOperation({ ...base, ...mismatch })).rejects.toThrow(/mismatch/);
  }
  expect(providerRun).not.toHaveBeenCalled();
  expect(readFactoryActionEvents(value.factoryStateRoot, workItemKey)).toHaveLength(2);
});

test("fails closed for divergent project, work-item, action-key, and result identity", () => {
  const value = fixture();
  expect(() =>
    resolveFactoryOperation({
      projectId: "other-project",
      projectRoot: value.projectRoot,
      factoryStateRoot: value.factoryStateRoot,
      workItemKey,
      operation: value.operation,
    }),
  ).toThrow(/phase-run identity mismatch/);
  expect(() =>
    resolveFactoryOperation({
      projectId,
      projectRoot: value.projectRoot,
      factoryStateRoot: value.factoryStateRoot,
      workItemKey: "linear:OTHER-1",
      operation: value.operation,
    }),
  ).toThrow(/phase-run identity mismatch/);
  expect(() => resolveFixture(value, { ...value.operation, actionKey: "f".repeat(64) })).toThrow(
    /action identity mismatch/,
  );

  const event = completedEvent(value);
  writeFactoryActionResult(actionDir(value), event);
  writeFileSync(
    join(actionDir(value), "action-result.json"),
    `${JSON.stringify({ ...event, workItemKey: "linear:OTHER-1" })}\n`,
  );
  expect(() => resolveFixture(value)).toThrow(/result identity mismatch/);
});

function durableFiles(root: string): Array<[string, string]> {
  const visit = (dir: string): Array<[string, string]> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? visit(path)
        : [[path.slice(root.length), readFileSync(path, "utf8")]];
    });
  return visit(root);
}
