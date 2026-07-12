import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  FactoryArtifactRefSchema,
  createFactoryArtifactRef,
  verifyFactoryArtifactRef,
} from "../lib/factory-artifact-ref.ts";
import { readFactoryActionResult, writeFactoryActionResult } from "../lib/factory-action-result.ts";
import {
  FactoryLifecycleConflictError,
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import { ensureFactoryStoreFormat, FactoryStoreFormatError } from "../lib/factory-store-format.ts";
import {
  decideNextFactoryAction,
  FactoryLifecycleStateSchema,
  reduceFactoryLifecycleEvents,
} from "../lib/factory-state-machine.ts";

const root = () => mkdtempSync(join(tmpdir(), "factory-action-"));
const imported = (
  occurredAt = "2026-07-11T00:00:00.000Z",
): Extract<FactoryLifecycleEvent, { type: "work_item.imported" }> => ({
  version: 1,
  id: "import:item-1",
  type: "work_item.imported",
  workItemKey: "item-1",
  occurredAt,
  data: { source: "file" },
});

describe("Factory action lifecycle kernel", () => {
  test("state schema rejects phase-incompatible statuses and routes", () => {
    const common = {
      projectionVersion: 1,
      workItemKey: "item-1",
      lastEventId: "event-1",
      updatedAt: "2026-07-11T00:00:00.000Z",
      phaseRunId: "run-1",
    };

    expect(() =>
      FactoryLifecycleStateSchema.parse({
        ...common,
        phase: "planning",
        status: "complete",
        reviewCeiling: 2,
        attempt: 1,
      }),
    ).toThrow();
    expect(() =>
      FactoryLifecycleStateSchema.parse({
        ...common,
        phase: "implementation",
        status: "awaiting-plan-merge",
        reviewCeiling: 2,
        attempt: 1,
      }),
    ).toThrow();
    expect(() =>
      FactoryLifecycleStateSchema.parse({
        ...common,
        phase: "triage",
        status: "routed",
        route: "needs-info",
      }),
    ).toThrow();
  });

  test("rejects failures from a handler that does not own the current state", () => {
    const request: FactoryLifecycleEvent = {
      version: 1,
      id: "planning-request",
      type: "planning.requested",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T02:00:00.000Z",
      phaseRunId: "planning-run",
      data: { expectedPredecessor: "triage-complete", inputRefs: [], reviewCeiling: 2 },
    };
    const events: FactoryLifecycleEvent[] = [
      imported(),
      {
        version: 1,
        id: "triage-request",
        type: "triage.requested",
        workItemKey: "item-1",
        occurredAt: "2026-07-11T01:00:00.000Z",
        phaseRunId: "triage-run",
        data: { expectedPredecessor: "import:item-1", inputRefs: [] },
      },
      {
        version: 1,
        id: "triage-complete",
        type: "triage.work_item.completed",
        workItemKey: "item-1",
        occurredAt: "2026-07-11T01:30:00.000Z",
        phaseRunId: "triage-run",
        data: {
          handler: "triageWorkItem",
          handlerVersion: 1,
          attempt: 1,
          causationEventId: "triage-request",
          execution: {
            workspaceRef: "repo",
            runRef: { base: "factory-store", path: "runs/triage", sha256: "a".repeat(64) },
          },
          evidence: [],
          route: "ready-to-plan",
          rationale: "Plan first",
        },
      },
      request,
    ];
    const failure: FactoryLifecycleEvent = {
      version: 1,
      id: "bad-review-failure",
      type: "factory.action.failed",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T03:00:00.000Z",
      phaseRunId: "planning-run",
      data: {
        handler: "reviewPlanCandidate",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: request.id,
        execution: {
          workspaceRef: "repo",
          runRef: { base: "factory-store", path: "runs/planning", sha256: "b".repeat(64) },
        },
        evidence: [],
        phase: "planning",
        failureKind: "retryable",
        message: "review failed before candidate",
      },
    };

    expect(() => reduceFactoryLifecycleEvents([...events, failure])).toThrow(
      /Invalid Factory transition/,
    );
    expect(
      reduceFactoryLifecycleEvents([
        ...events,
        {
          ...failure,
          id: "producer-failure",
          data: { ...failure.data, handler: "producePlanCandidate" },
        },
      ]),
    ).toMatchObject({ phase: "planning", status: "awaiting-candidate", attempt: 1 });
  });

  test("rejects stale cursors and divergent duplicate ids", () => {
    const store = root();
    appendFactoryActionEvent({
      factoryStateRoot: store,
      event: imported(),
      expectedLastEventId: null,
    });
    expect(() =>
      appendFactoryActionEvent({
        factoryStateRoot: store,
        event: {
          ...imported(),
          occurredAt: "2026-07-11T01:00:00.000Z",
          data: { source: "linear" },
        },
        expectedLastEventId: null,
      }),
    ).toThrow(FactoryLifecycleConflictError);
    const request: FactoryLifecycleEvent = {
      version: 1,
      id: "triage:request:item-1",
      type: "triage.requested",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T02:00:00.000Z",
      phaseRunId: "triage-run",
      data: { expectedPredecessor: "import:item-1", inputRefs: [] },
    };
    expect(() =>
      appendFactoryActionEvent({
        factoryStateRoot: store,
        event: request,
        expectedLastEventId: null,
      }),
    ).toThrow(/Stale Factory cursor/);
  });

  test("returns canonical duplicate while ignoring occurredAt", () => {
    const store = root();
    const first = appendFactoryActionEvent({
      factoryStateRoot: store,
      event: imported(),
      expectedLastEventId: null,
    });
    const duplicate = appendFactoryActionEvent({
      factoryStateRoot: store,
      event: imported("2026-07-12T00:00:00.000Z"),
      expectedLastEventId: null,
    });
    expect(duplicate.event).toEqual(first.event);
    expect(readFactoryActionEvents(store, "item-1")).toHaveLength(1);
  });

  test("recovers a terminal action result without repeating work", () => {
    const store = root();
    const actionDir = join(store, "actions", "triage");
    appendFactoryActionEvent({
      factoryStateRoot: store,
      event: imported(),
      expectedLastEventId: null,
    });
    const request: FactoryLifecycleEvent = {
      version: 1,
      id: "triage:request:item-1",
      type: "triage.requested",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T01:00:00.000Z",
      phaseRunId: "triage-run",
      data: { expectedPredecessor: "import:item-1", inputRefs: [] },
    };
    const requested = appendFactoryActionEvent({
      factoryStateRoot: store,
      event: request,
      expectedLastEventId: "import:item-1",
    });
    expect(decideNextFactoryAction(requested.state, requested.event)).toMatchObject({
      kind: "invoke",
      handler: "triageWorkItem",
    });
    const terminal: Extract<FactoryLifecycleEvent, { type: "triage.work_item.completed" }> = {
      version: 1,
      id: "triage:complete:item-1",
      type: "triage.work_item.completed",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T02:00:00.000Z",
      phaseRunId: "triage-run",
      data: {
        handler: "triageWorkItem",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: request.id,
        execution: {
          workspaceRef: "repo",
          runRef: { base: "factory-store", path: "runs/triage", sha256: "a".repeat(64) },
        },
        evidence: [],
        route: "ready-to-plan",
        nextCommand: "harness factory planning run --item-file item.json",
        rationale: "Needs planning",
      },
    };
    writeFactoryActionResult(actionDir, terminal);
    expect(writeFactoryActionResult(actionDir, terminal)).toBe(
      join(actionDir, "action-result.json"),
    );
    expect(() =>
      writeFactoryActionResult(actionDir, {
        ...terminal,
        data: { ...terminal.data, rationale: "Divergent" },
      }),
    ).toThrow(/Divergent Factory action result/);
    const recovered = appendFactoryActionEvent({
      factoryStateRoot: store,
      event: readFactoryActionResult(actionDir),
      expectedLastEventId: request.id,
    });
    expect(recovered.state).toMatchObject({ phase: "triage", status: "routed" });
    expect(decideNextFactoryAction(recovered.state, recovered.event)).toEqual({
      kind: "wait",
      reason: "phase-command",
      command: terminal.data.nextCommand,
    });
  });

  test("rejects a terminal event without its request transition", () => {
    const store = root();
    appendFactoryActionEvent({
      factoryStateRoot: store,
      event: imported(),
      expectedLastEventId: null,
    });
    const terminal: Extract<FactoryLifecycleEvent, { type: "triage.work_item.completed" }> = {
      version: 1,
      id: "bad-terminal",
      type: "triage.work_item.completed",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T02:00:00.000Z",
      phaseRunId: "triage-run",
      data: {
        handler: "triageWorkItem",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: "import:item-1",
        execution: {
          workspaceRef: "repo",
          runRef: { base: "factory-store", path: "runs/triage", sha256: "a".repeat(64) },
        },
        evidence: [],
        route: "ready-to-plan",
        nextCommand: "next",
        rationale: "bad",
      },
    };
    expect(() =>
      appendFactoryActionEvent({
        factoryStateRoot: store,
        event: terminal,
        expectedLastEventId: "import:item-1",
      }),
    ).toThrow(/Invalid Factory transition/);
  });
});

describe("Factory store and artifact boundaries", () => {
  test("rejects an old non-empty store explicitly", () => {
    const store = root();
    writeFileSync(join(store, "old.jsonl"), "{}\n");
    expect(() => ensureFactoryStoreFormat(store)).toThrow(FactoryStoreFormatError);
    expect(() => ensureFactoryStoreFormat(store)).toThrow(/Archive or reset/);
  });
  test("read-only event access does not initialize an empty store", () => {
    const store = root();
    expect(readFactoryActionEvents(store, "item-1")).toEqual([]);
    expect(existsSync(join(store, "store-format.json"))).toBe(false);
  });
  test("rejects absolute, traversal, and changed artifact content", () => {
    expect(() =>
      FactoryArtifactRefSchema.parse({
        base: "repository",
        path: "/tmp/x",
        sha256: "a".repeat(64),
      }),
    ).toThrow();
    for (const path of ["C:\\temp\\x", "\\\\server\\share", "..\\x", "a\\..\\x"]) {
      expect(() =>
        FactoryArtifactRefSchema.parse({ base: "repository", path, sha256: "a".repeat(64) }),
      ).toThrow();
    }
    expect(() =>
      FactoryArtifactRefSchema.parse({ base: "repository", path: "../x", sha256: "a".repeat(64) }),
    ).toThrow();
    const repo = root();
    mkdirSync(join(repo, "evidence"));
    writeFileSync(join(repo, "evidence/result.json"), "one");
    const ref = createFactoryArtifactRef({
      base: "repository",
      root: repo,
      path: "evidence/result.json",
    });
    writeFileSync(join(repo, "evidence/result.json"), "two");
    expect(() =>
      verifyFactoryArtifactRef(ref, { repository: repo, "factory-store": root() }),
    ).toThrow(/hash mismatch/);
  });
});
