import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { writeFactoryActionResult } from "./factory-action-result.ts";
import { appendFactoryActionEvent } from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle.ts";
import {
  createFactoryOperationRef,
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
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "factory-operation-"));
  temporaryRoots.push(projectRoot);
  const factoryStateRoot = join(projectRoot, "factory");
  const runDir = join(projectRoot, "runs", "factory", phaseRunId);
  const workspace = join(projectRoot, "workspace-does-not-exist");
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
      inputRefs: [inputRef],
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
  return { projectRoot, factoryStateRoot, runDir, requested, operation };
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
      execution: { workspaceRef: "unused", runRef: inputRef },
      evidence: [inputRef],
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
