import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  factoryLifecycleEventPath,
  type FactoryLifecycleEvent,
} from "../lib/factory-lifecycle.ts";
import { assertFactoryTriageAllowed } from "../lib/factory-triage-policy.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";

const WORK_ITEM: FactoryWorkItem = {
  id: "linear:ENG-37",
  source: "linear",
  title: "Lifecycle triage",
  body: "",
  labels: [],
  metadata: { tracker: { source: "linear", id: "ENG-37" } },
};

function stateRoot(): string {
  return mkdtempSync(join(tmpdir(), "factory-triage-policy-"));
}

function append(root: string, event: FactoryLifecycleEvent): void {
  appendFactoryLifecycleEvent({ factoryStateRoot: root, event });
}

function event(
  type: "triage.started" | "triage.failed" | "triage.completed",
  runId: string,
): FactoryLifecycleEvent {
  const base = {
    version: 1,
    id: `${type}:${runId}`,
    type,
    workItemKey: "linear:ENG-37",
    occurredAt: "2026-07-09T00:00:00.000Z",
    runId,
    source: "harness",
  } as const;
  if (type === "triage.completed") {
    return {
      ...base,
      type,
      data: {
        route: "ready-to-plan",
        nextAction: "create-plan",
        rationale: "Needs a plan.",
        routeArtifactPath: "factory-route.md",
        triageArtifactPath: "factory-triage.json",
      },
    } satisfies FactoryLifecycleEvent;
  }
  if (type === "triage.failed") {
    return { ...base, type, data: { error: "failed" } } satisfies FactoryLifecycleEvent;
  }
  return { ...base, type, data: { linearIssue: "ENG-37" } } satisfies FactoryLifecycleEvent;
}

test("allows new, started, and failed-only histories", () => {
  const root = stateRoot();
  expect(
    assertFactoryTriageAllowed({ factoryStateRoot: root, workItem: WORK_ITEM, rerun: false }),
  ).toEqual({ hadPriorCompletion: false });
  append(root, event("triage.started", "run-1"));
  append(root, event("triage.failed", "run-1"));
  expect(
    assertFactoryTriageAllowed({ factoryStateRoot: root, workItem: WORK_ITEM, rerun: false }),
  ).toEqual({ hadPriorCompletion: false });
});

test("blocks any completed history unless rerun is explicit", () => {
  const root = stateRoot();
  append(root, event("triage.completed", "run-1"));
  append(root, {
    version: 1,
    id: "planning.completed:plan-1",
    type: "planning.completed",
    workItemKey: "linear:ENG-37",
    occurredAt: "2026-07-09T01:00:00.000Z",
    runId: "plan-1",
    source: "harness",
    data: { status: "plan-approved", approvedPlanPath: "dev/plans/ENG-37.md" },
  });
  expect(() =>
    assertFactoryTriageAllowed({ factoryStateRoot: root, workItem: WORK_ITEM, rerun: false }),
  ).toThrow(/linear:ENG-37.*run-1.*--rerun/);
  expect(
    assertFactoryTriageAllowed({ factoryStateRoot: root, workItem: WORK_ITEM, rerun: true }),
  ).toEqual({ hadPriorCompletion: true, priorCompletionRunId: "run-1" });
});

test.each([false, true])("malformed history fails closed when rerun is %s", (rerun) => {
  const root = stateRoot();
  const path = factoryLifecycleEventPath(root, deriveFactoryWorkItemKey(WORK_ITEM));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{not-json}\n", "utf8");
  expect(() =>
    assertFactoryTriageAllowed({ factoryStateRoot: root, workItem: WORK_ITEM, rerun }),
  ).toThrow(/Invalid factory lifecycle JSONL/);
});
