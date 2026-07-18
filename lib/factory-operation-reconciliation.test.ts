import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { hostname } from "node:os";
import { expect, test, vi } from "vitest";
import { writeFactoryActionResult } from "./factory-action-result.ts";
import { fixture } from "../test/factory-hosted-operation-test-fixtures.ts";
import {
  actionLifecycleEventPath,
  actionLifecycleStatePath,
  appendFactoryActionEvent,
} from "./factory-lifecycle-kernel.ts";
import * as lifecycle from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { factoryWorkItemLockPath } from "./factory-locks.ts";
import * as stateMachine from "./factory-state-machine.ts";
import {
  FACTORY_RECONCILIATION_REASON_MAX_LENGTH,
  reconcileFactoryOperations,
  type FactoryOperationDelivery,
} from "./factory-operation-reconciliation.ts";

function target(value: ReturnType<typeof fixture>) {
  return {
    projectId: value.projectId,
    workItemKey: value.workItemKey,
    factoryStore: value.runtime.factoryStore,
  };
}

function durableState(value: ReturnType<typeof fixture>) {
  return {
    events: readFileSync(
      actionLifecycleEventPath(value.factoryStateRoot, value.workItemKey),
      "utf8",
    ),
    state: readFileSync(
      actionLifecycleStatePath(value.factoryStateRoot, value.workItemKey),
      "utf8",
    ),
    locks: directorySnapshot(join(value.factoryStateRoot, "locks")),
  };
}

function directorySnapshot(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        entries.push(`${name}/`);
        visit(path);
      } else {
        entries.push(`${name}:${readFileSync(path, "utf8")}`);
      }
    }
  };
  visit(root);
  return entries.sort();
}

function seedStaleLock(value: ReturnType<typeof fixture>): void {
  const filename = basename(
    actionLifecycleEventPath(value.factoryStateRoot, value.workItemKey),
    ".jsonl",
  );
  const lockPath = factoryWorkItemLockPath(value.factoryStateRoot, filename);
  mkdirSync(lockPath);
  writeFileSync(
    join(lockPath, "owner.json"),
    `${JSON.stringify({
      pid: 999_999_999,
      hostname: hostname(),
      token: "stale-reconciliation-lock",
      workspace: value.workspace,
      workItemKey: value.workItemKey,
      startedAt: "2020-01-01T00:00:00.000Z",
    })}\n`,
  );
}

function actionDir(value: ReturnType<typeof fixture>): string {
  return join(value.runDir, "actions", "1", "triageWorkItem", value.operation.actionKey);
}

test("rediscovers the exact identifier-only operation without advancing Factory", async () => {
  const value = fixture();
  const before = durableState(value);
  const delivered = vi.fn<FactoryOperationDelivery>(async () => undefined);

  const first = await reconcileFactoryOperations([target(value)], delivered);
  const second = await reconcileFactoryOperations([target(value)], delivered);

  expect(delivered).toHaveBeenNthCalledWith(1, value.request);
  expect(delivered).toHaveBeenNthCalledWith(2, value.request);
  expect(first).toEqual([
    {
      outcome: "delivered",
      projectId: value.projectId,
      workItemKey: value.workItemKey,
      operation: value.operation,
      reason: "triage-requested",
    },
  ]);
  expect(second).toEqual(first);
  expect(Object.keys(delivered.mock.calls[0]![0])).toEqual([
    "projectId",
    "workItemKey",
    "operation",
  ]);
  expect(durableState(value)).toEqual(before);
});

test("returns an exact phase start without phase-run identity or operation delivery", async () => {
  const value = fixture();
  const workItemKey = "linear:IDLE-1";
  const event: FactoryLifecycleEvent = {
    version: 1,
    id: `work_item.imported:${workItemKey}`,
    type: "work_item.imported",
    workItemKey,
    occurredAt: "2026-07-17T00:00:00.000Z",
    data: { source: "linear" },
  };
  appendFactoryActionEvent({
    factoryStateRoot: value.factoryStateRoot,
    event,
    expectedLastEventId: null,
  });
  const delivered = vi.fn<FactoryOperationDelivery>(async () => undefined);

  const results = await reconcileFactoryOperations([{ ...target(value), workItemKey }], delivered);

  expect(results).toEqual([
    {
      outcome: "phase-start",
      projectId: value.projectId,
      workItemKey,
      reaction: { kind: "start-phase", phase: "triage", event },
    },
  ]);
  expect(delivered).not.toHaveBeenCalled();
});

test("a lost send response leaves state unchanged and regenerates the same action", async () => {
  const value = fixture();
  seedStaleLock(value);
  const before = durableState(value);
  const accepted: unknown[] = [];
  const lostResponse = vi.fn<FactoryOperationDelivery>(async (request) => {
    accepted.push(request);
    throw new Error("accepted by transport\nbut response was lost");
  });

  const failed = await reconcileFactoryOperations([target(value)], lostResponse);
  expect(failed).toEqual([
    {
      outcome: "attention",
      projectId: value.projectId,
      workItemKey: value.workItemKey,
      operation: value.operation,
      reason: "accepted by transport but response was lost",
    },
  ]);
  expect(durableState(value)).toEqual(before);

  const delivered = vi.fn<FactoryOperationDelivery>(async () => undefined);
  await reconcileFactoryOperations([target(value)], delivered);
  expect(accepted).toEqual([value.request]);
  expect(delivered).toHaveBeenCalledWith(value.request);
  expect(durableState(value)).toEqual(before);
});

test("redelivers an authenticated staged result for normal hosted recovery", async () => {
  const value = fixture();
  writeFactoryActionResult(actionDir(value), value.completed());
  const before = durableState(value);
  const delivered = vi.fn<FactoryOperationDelivery>(async () => undefined);

  const results = await reconcileFactoryOperations([target(value)], delivered);

  expect(results[0]).toMatchObject({ outcome: "delivered", operation: value.operation });
  expect(delivered).toHaveBeenCalledWith(value.request);
  expect(durableState(value)).toEqual(before);
});

test("does not deliver a superseded operation found by the final state read", async () => {
  const value = fixture();
  const events = lifecycle.readFactoryActionEvents(value.factoryStateRoot, value.workItemKey);
  const superseding = value.failed();
  let reads = 0;
  const read = vi.spyOn(lifecycle, "readFactoryActionEvents").mockImplementation(() => {
    reads += 1;
    if (reads >= 3) return [...events, superseding];
    return events;
  });
  const delivered = vi.fn<FactoryOperationDelivery>(async () => undefined);

  const results = await reconcileFactoryOperations([target(value)], delivered);

  expect(results).toEqual([
    {
      outcome: "stale",
      projectId: value.projectId,
      workItemKey: value.workItemKey,
      operation: value.operation,
      reason: "superseded",
    },
  ]);
  expect(delivered).not.toHaveBeenCalled();
  read.mockRestore();
});

test("leaves phase-start and terminal work items untouched", async () => {
  const phaseStart = fixture();
  const completed = phaseStart.completed();
  appendFactoryActionEvent({
    factoryStateRoot: phaseStart.factoryStateRoot,
    event: completed,
    expectedLastEventId: phaseStart.requested.id,
  });
  const failed = fixture();
  const terminalFailure = {
    ...failed.failed(),
    data: { ...failed.failed().data, failureKind: "terminal" as const },
  };
  appendFactoryActionEvent({
    factoryStateRoot: failed.factoryStateRoot,
    event: terminalFailure,
    expectedLastEventId: failed.requested.id,
  });
  const before = [durableState(phaseStart), durableState(failed)];
  const delivered = vi.fn<FactoryOperationDelivery>(async () => undefined);

  const results = await reconcileFactoryOperations([target(phaseStart), target(failed)], delivered);

  expect(results).toEqual([
    {
      outcome: "phase-start",
      projectId: phaseStart.projectId,
      workItemKey: phaseStart.workItemKey,
      reaction: { kind: "start-phase", phase: "planning", event: completed },
    },
    {
      outcome: "waiting",
      projectId: failed.projectId,
      workItemKey: failed.workItemKey,
      reason: "failed",
    },
  ]);
  expect(delivered).not.toHaveBeenCalled();
  expect([durableState(phaseStart), durableState(failed)]).toEqual(before);
});

test.each([
  "human",
  "plan-publication",
  "plan-merge",
  "pr-publication",
  "pr-merge",
  "complete",
  "failed",
  "stale-event",
] as const)("maps the %s wait without delivery", async (reason) => {
  const value = fixture();
  const decide = vi
    .spyOn(stateMachine, "decideNextFactoryAction")
    .mockReturnValue({ kind: "wait", reason });
  const delivered = vi.fn<FactoryOperationDelivery>(async () => undefined);

  const results = await reconcileFactoryOperations([target(value)], delivered);

  expect(results).toEqual([
    reason === "stale-event"
      ? {
          outcome: "stale",
          projectId: value.projectId,
          workItemKey: value.workItemKey,
          reason,
        }
      : {
          outcome: "waiting",
          projectId: value.projectId,
          workItemKey: value.workItemKey,
          reason,
        },
  ]);
  expect(delivered).not.toHaveBeenCalled();
  decide.mockRestore();
});

test("isolates bounded attention across ordered projects", async () => {
  const first = fixture({ projectId: "project-1" });
  const second = fixture({ projectId: "project-2" });
  const unavailable = {
    ...target(first),
    factoryStore: {
      ...first.runtime.factoryStore,
      factoryStateRoot: join(first.factoryStateRoot, "missing"),
    },
  };
  const divergent = { ...target(first), projectId: "unexpected-project" };
  const delivered = vi.fn<FactoryOperationDelivery>(async () => undefined);

  const results = await reconcileFactoryOperations(
    [unavailable, divergent, target(first), target(second)],
    delivered,
  );

  expect(results.map(({ outcome, projectId }) => [outcome, projectId])).toEqual([
    ["attention", first.projectId],
    ["attention", "unexpected-project"],
    ["delivered", "project-1"],
    ["delivered", "project-2"],
  ]);
  const attentionReasons = results
    .filter((result) => result.outcome === "attention")
    .map((result) => result.reason);
  expect(attentionReasons).toHaveLength(2);
  expect(
    attentionReasons.every(
      (reason) =>
        !reason.includes("\n") && reason.length <= FACTORY_RECONCILIATION_REASON_MAX_LENGTH,
    ),
  ).toBe(true);
  expect(delivered).toHaveBeenCalledTimes(2);
  expect(delivered).toHaveBeenNthCalledWith(1, first.request);
  expect(delivered).toHaveBeenNthCalledWith(2, second.request);
});
