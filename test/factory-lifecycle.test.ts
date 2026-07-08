import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  factoryLifecycleEventPath,
  factoryLifecycleStatePath,
  loadFactoryLifecycleState,
  mergeFactoryStateIntoWorkItem,
  readFactoryLifecycleEvents,
  reduceFactoryLifecycleEvents,
  resolveFactoryStateRoot,
  workItemKeyToFilename,
  type FactoryLifecycleEvent,
} from "../lib/factory-lifecycle.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";

const OCCURRED_AT = "2026-07-08T12:00:00.000Z";

test("derives stable work item keys from tracker metadata, ids, and source ids", () => {
  expect(
    deriveFactoryWorkItemKey({
      id: "local-1",
      source: "file",
      title: "File item",
      body: "",
      labels: [],
      metadata: { tracker: { source: "linear", id: "FER-34" } },
    }),
  ).toBe("linear:FER-34");
  expect(
    deriveFactoryWorkItemKey({
      id: "linear:FER-34",
      source: "linear",
      title: "Linear item",
      body: "",
      labels: [],
    }),
  ).toBe("linear:FER-34");
  expect(
    deriveFactoryWorkItemKey({
      id: "local-1",
      source: "file",
      title: "File item",
      body: "",
      labels: [],
    }),
  ).toBe("file:local-1");
});

test("sanitizes lifecycle filenames with a stable hash suffix", () => {
  expect(workItemKeyToFilename("linear:FER-34")).toMatch(/^linear-FER-34-[a-f0-9]{12}$/);
  expect(workItemKeyToFilename("github:owner/repo#123")).toMatch(
    /^github-owner-repo-123-[a-f0-9]{12}$/,
  );
  expect(workItemKeyToFilename("file:../items/work item.json")).toMatch(
    /^file-..-items-work-item.json-[a-f0-9]{12}$/,
  );
});

test("append writes JSONL and rebuildable state cache idempotently", () => {
  const root = tempRoot();
  const event = importedEvent("linear:FER-34");

  appendFactoryLifecycleEvent({ factoryStateRoot: root, event });
  appendFactoryLifecycleEvent({ factoryStateRoot: root, event });

  expect(
    readFactoryLifecycleEvents({ factoryStateRoot: root, workItemKey: event.workItemKey }),
  ).toHaveLength(1);
  const statePath = factoryLifecycleStatePath(root, event.workItemKey);
  expect(existsSync(statePath)).toBe(true);
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
    workItemKey: "linear:FER-34",
    title: "Lifecycle issue",
    lastEventId: event.id,
  });
});

test("malformed JSONL fails closed with a lifecycle error", () => {
  const root = tempRoot();
  const eventPath = factoryLifecycleEventPath(root, "linear:FER-34");
  mkdirSync(join(root, "events"), { recursive: true });
  writeFileSync(eventPath, "{not-json}\n", "utf8");

  expect(() =>
    readFactoryLifecycleEvents({ factoryStateRoot: root, workItemKey: "linear:FER-34" }),
  ).toThrow(/Invalid factory lifecycle JSONL/);
});

test("triage route events reduce to durable stages and next actions", () => {
  const base = importedEvent("linear:FER-34");
  const state = reduceFactoryLifecycleEvents([
    base,
    triageCompletedEvent("linear:FER-34", "ready-to-plan", "create-plan"),
  ]);

  expect(state).toMatchObject({
    factoryStage: "ready-to-plan",
    factoryRoute: "ready-to-plan",
    factoryNextAction: "create-plan",
    factoryRunId: "triage-run-1",
  });
});

test("later triage completed event wins durable route fields", () => {
  const state = reduceFactoryLifecycleEvents([
    importedEvent("linear:FER-34"),
    triageCompletedEvent("linear:FER-34", "needs-info", "ask-human"),
    triageCompletedEvent("linear:FER-34", "ready-to-plan", "create-plan", {
      id: "triage.completed:triage-run-2",
      runId: "triage-run-2",
    }),
  ]);

  expect(state).toMatchObject({
    factoryStage: "ready-to-plan",
    factoryRoute: "ready-to-plan",
    factoryNextAction: "create-plan",
    factoryRunId: "triage-run-2",
    lastEventId: "triage.completed:triage-run-2",
  });
});

test("started-only events do not change durable stage or factory run id", () => {
  const state = reduceFactoryLifecycleEvents([
    importedEvent("linear:FER-34"),
    {
      ...baseEvent("triage.started:run-1", "linear:FER-34"),
      type: "triage.started",
      data: { linearIssue: "FER-34" },
    },
    {
      ...baseEvent("planning.started:run-2", "linear:FER-34"),
      type: "planning.started",
      data: { linearIssue: "FER-34" },
    },
  ]);

  expect(state).toMatchObject({
    workItemKey: "linear:FER-34",
    lastEventId: "planning.started:run-2",
  });
  expect(state?.factoryStage).toBeUndefined();
  expect(state?.factoryRunId).toBeUndefined();
});

test("triage failed records run data without replacing prior durable route", () => {
  const state = reduceFactoryLifecycleEvents([
    importedEvent("linear:FER-34"),
    triageCompletedEvent("linear:FER-34", "ready-to-plan", "create-plan"),
    {
      ...baseEvent("triage.failed:run-2", "linear:FER-34", "run-2"),
      runId: "run-2",
      type: "triage.failed",
      data: { error: "Provider failed" },
    },
  ]);

  expect(state).toMatchObject({
    factoryStage: "ready-to-plan",
    factoryRoute: "ready-to-plan",
    factoryNextAction: "create-plan",
    factoryRunId: "run-2",
  });
});

test("planning approval chooses plan PR stage only for supported trackers", () => {
  expect(
    reduceFactoryLifecycleEvents([
      importedEvent("linear:FER-34", { tracker: { source: "linear", id: "FER-34" } }),
      planningCompletedEvent("linear:FER-34", "plan-approved"),
    ]),
  ).toMatchObject({ factoryStage: "plan-pr-open", approvedPlanPath: "dev/plans/FER-34.md" });

  expect(
    reduceFactoryLifecycleEvents([
      importedEvent("file:local-1", { source: "file" }),
      planningCompletedEvent("file:local-1", "plan-approved"),
    ]),
  ).toMatchObject({ factoryStage: "plan-approved" });

  expect(
    reduceFactoryLifecycleEvents([
      importedEvent("jira:ABC-1", {
        source: "jira",
        tracker: { source: "jira", id: "ABC-1" },
      }),
      planningCompletedEvent("jira:ABC-1", "plan-approved"),
    ]),
  ).toMatchObject({ factoryStage: "plan-approved" });
});

test("publication fields are cleared and replaced across replans and failures", () => {
  const events = [
    importedEvent("linear:FER-34", { tracker: { source: "linear", id: "FER-34" } }),
    planningCompletedEvent("linear:FER-34", "plan-approved"),
    planPrOpenedEvent("linear:FER-34", "https://github.com/owner/repo/pull/1"),
    planPrMergedEvent("linear:FER-34", "https://github.com/owner/repo/pull/1", "abc123"),
    planningCompletedEvent("linear:FER-34", "plan-approved", {
      id: "planning.completed:run-2",
      runId: "run-2",
      approvedPlanPath: "dev/plans/FER-34-v2.md",
    }),
  ];

  const afterReplan = reduceFactoryLifecycleEvents(events);
  expect(afterReplan).toMatchObject({
    factoryStage: "plan-pr-open",
    approvedPlanPath: "dev/plans/FER-34-v2.md",
  });
  expect(afterReplan?.approvedPlanPrUrl).toBeUndefined();
  expect(afterReplan?.approvedPlanCommit).toBeUndefined();

  const afterOpen = reduceFactoryLifecycleEvents([
    ...events,
    planPrOpenedEvent("linear:FER-34", "https://github.com/owner/repo/pull/2", {
      id: "plan_pr.opened:run-2:https://github.com/owner/repo/pull/2",
      runId: "run-2",
      approvedPlanPath: "dev/plans/FER-34-v2.md",
    }),
  ]);
  expect(afterOpen).toMatchObject({
    factoryStage: "plan-pr-open",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/2",
  });
  expect(afterOpen?.approvedPlanCommit).toBeUndefined();

  const afterNeedsHuman = reduceFactoryLifecycleEvents([
    ...events,
    planPrOpenedEvent("linear:FER-34", "https://github.com/owner/repo/pull/2", {
      id: "plan_pr.opened:run-2:https://github.com/owner/repo/pull/2",
      runId: "run-2",
      approvedPlanPath: "dev/plans/FER-34-v2.md",
    }),
    planningCompletedEvent("linear:FER-34", "plan-needs-human", {
      id: "planning.completed:run-3",
      runId: "run-3",
    }),
  ]);
  expect(afterNeedsHuman).toMatchObject({ factoryStage: "plan-needs-human" });
  expect(afterNeedsHuman?.approvedPlanPrUrl).toBeUndefined();
  expect(afterNeedsHuman?.approvedPlanCommit).toBeUndefined();
});

test("planning failed clears publication readiness fields but keeps historical plan path", () => {
  const state = reduceFactoryLifecycleEvents([
    importedEvent("linear:FER-34", { tracker: { source: "linear", id: "FER-34" } }),
    planningCompletedEvent("linear:FER-34", "plan-approved"),
    planPrOpenedEvent("linear:FER-34", "https://github.com/owner/repo/pull/1"),
    {
      ...baseEvent("planning.failed:run-2", "linear:FER-34", "run-2"),
      runId: "run-2",
      type: "planning.failed",
      data: { error: "Planner failed" },
    },
  ]);

  expect(state).toMatchObject({
    factoryStage: "planning-failed",
    approvedPlanPath: "dev/plans/FER-34.md",
  });
  expect(state?.approvedPlanPrUrl).toBeUndefined();
  expect(state?.approvedPlanCommit).toBeUndefined();
});

test("planning failed after start does not leave a stranded planning stage", () => {
  const state = reduceFactoryLifecycleEvents([
    importedEvent("linear:FER-34", { tracker: { source: "linear", id: "FER-34" } }),
    {
      ...baseEvent("planning.started:run-1", "linear:FER-34", "run-1"),
      runId: "run-1",
      type: "planning.started",
      data: { linearIssue: "FER-34" },
    },
    {
      ...baseEvent("planning.failed:run-1", "linear:FER-34", "run-1"),
      runId: "run-1",
      type: "planning.failed",
      data: { error: "Planner failed" },
    },
  ]);

  expect(state).toMatchObject({
    factoryStage: "planning-failed",
    factoryRunId: "run-1",
    lastEventId: "planning.failed:run-1",
  });
});

test("load rebuilds stale cache from canonical JSONL", () => {
  const root = tempRoot();
  const first = importedEvent("linear:FER-34");
  const second = triageCompletedEvent("linear:FER-34", "ready-to-implement", "implement-directly");
  appendFactoryLifecycleEvent({ factoryStateRoot: root, event: first });
  writeFileSync(
    factoryLifecycleStatePath(root, "linear:FER-34"),
    `${JSON.stringify({
      version: 1,
      workItemKey: "linear:FER-34",
      lastEventId: "stale",
    })}\n`,
    "utf8",
  );
  appendFactoryLifecycleEvent({ factoryStateRoot: root, event: second });

  expect(
    loadFactoryLifecycleState({ factoryStateRoot: root, workItemKey: "linear:FER-34" }),
  ).toMatchObject({
    factoryStage: "ready-to-implement",
    lastEventId: second.id,
  });
});

test("merge overlays lifecycle fields while preserving tracker-specific metadata", () => {
  const workItem: FactoryWorkItem = {
    id: "linear:FER-34",
    source: "linear",
    title: "Linear issue",
    body: "",
    labels: ["factory"],
    metadata: {
      tracker: { source: "linear", id: "FER-34" },
      linearStatus: "Backlog",
      factoryStage: "incoming",
    },
  };
  const state = reduceFactoryLifecycleEvents([
    importedEvent("linear:FER-34", { tracker: { source: "linear", id: "FER-34" } }),
    triageCompletedEvent("linear:FER-34", "ready-to-plan", "create-plan"),
  ]);

  expect(mergeFactoryStateIntoWorkItem(workItem, state).metadata).toMatchObject({
    tracker: { source: "linear", id: "FER-34" },
    linearStatus: "Backlog",
    factoryStage: "ready-to-plan",
    factoryRoute: "ready-to-plan",
  });
});

test("merge preserves existing stage when lifecycle import has no durable stage", () => {
  const workItem: FactoryWorkItem = {
    id: "linear:FER-34",
    source: "linear",
    title: "Linear issue",
    body: "",
    labels: [],
    metadata: {
      tracker: { source: "linear", id: "FER-34" },
      linearStatus: "Backlog",
      factoryStage: "incoming",
    },
  };
  const state = reduceFactoryLifecycleEvents([
    importedEvent("linear:FER-34", { tracker: { source: "linear", id: "FER-34" } }),
  ]);

  expect(mergeFactoryStateIntoWorkItem(workItem, state).metadata).toMatchObject({
    factoryStage: "incoming",
    linearStatus: "Backlog",
    tracker: { source: "linear", id: "FER-34" },
  });
});

test("factory state root is independent from execution workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-lifecycle-worktree-"));
  const control = mkdtempSync(join(tmpdir(), "harness-lifecycle-control-"));
  const root = resolveFactoryStateRoot({
    workspace,
    factoryStateRoot: join(control, ".harness/factory"),
  });
  const event = {
    ...importedEvent("linear:FER-34"),
    execution: { workspace },
  };

  appendFactoryLifecycleEvent({ factoryStateRoot: root, event });

  expect(existsSync(factoryLifecycleEventPath(root, "linear:FER-34"))).toBe(true);
  expect(factoryLifecycleEventPath(root, "linear:FER-34")).toContain(control);
  expect(
    readFactoryLifecycleEvents({ factoryStateRoot: root, workItemKey: "linear:FER-34" })[0],
  ).toMatchObject({ execution: { workspace } });
});

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "harness-lifecycle-"));
}

function baseEvent(id: string, workItemKey: string, runId?: string) {
  return {
    version: 1,
    id,
    workItemKey,
    occurredAt: OCCURRED_AT,
    ...(runId ? { runId } : {}),
    source: "harness",
  } as const;
}

function importedEvent(
  workItemKey: string,
  overrides: {
    source?: string;
    tracker?: { source: "linear" | "file" | "github" | "jira" | "manual"; id: string };
  } = {},
): FactoryLifecycleEvent {
  return {
    ...baseEvent(`work_item.imported:${workItemKey}`, workItemKey),
    type: "work_item.imported",
    data: {
      source: overrides.source ?? "linear",
      title: "Lifecycle issue",
      labels: ["factory"],
      ...(overrides.tracker ? { tracker: overrides.tracker } : {}),
    },
  };
}

function triageCompletedEvent(
  workItemKey: string,
  route: "ready-to-implement" | "ready-to-plan" | "needs-info" | "wait-to-implement",
  nextAction: "implement-directly" | "create-plan" | "ask-human" | "park",
  overrides: { id?: string; runId?: string } = {},
): FactoryLifecycleEvent {
  const runId = overrides.runId ?? "triage-run-1";
  return {
    ...baseEvent(overrides.id ?? `triage.completed:${runId}`, workItemKey, runId),
    runId,
    type: "triage.completed",
    data: {
      route,
      nextAction,
      rationale: "Rationale",
      routeArtifactPath: "factory-route.md",
      triageArtifactPath: "factory-triage.json",
    },
  };
}

function planningCompletedEvent(
  workItemKey: string,
  status: "plan-approved" | "plan-needs-human" | "plan-review-unresolved",
  overrides: { id?: string; runId?: string; approvedPlanPath?: string } = {},
): FactoryLifecycleEvent {
  const runId = overrides.runId ?? "planning-run-1";
  return {
    ...baseEvent(overrides.id ?? `planning.completed:${runId}`, workItemKey, runId),
    runId,
    type: "planning.completed",
    data: {
      status,
      ...(status === "plan-approved"
        ? { approvedPlanPath: overrides.approvedPlanPath ?? "dev/plans/FER-34.md" }
        : {}),
    },
  };
}

function planPrOpenedEvent(
  workItemKey: string,
  approvedPlanPrUrl: string,
  overrides: { id?: string; runId?: string; approvedPlanPath?: string } = {},
): FactoryLifecycleEvent {
  const runId = overrides.runId ?? "planning-run-1";
  return {
    ...baseEvent(
      overrides.id ?? `plan_pr.opened:${runId}:${approvedPlanPrUrl}`,
      workItemKey,
      runId,
    ),
    runId,
    type: "plan_pr.opened",
    data: {
      approvedPlanPath: overrides.approvedPlanPath ?? "dev/plans/FER-34.md",
      approvedPlanPrUrl,
    },
  };
}

function planPrMergedEvent(
  workItemKey: string,
  approvedPlanPrUrl: string,
  approvedPlanCommit: string,
): FactoryLifecycleEvent {
  return {
    ...baseEvent(
      `plan_pr.merged:planning-run-1:${approvedPlanCommit}`,
      workItemKey,
      "planning-run-1",
    ),
    runId: "planning-run-1",
    type: "plan_pr.merged",
    data: {
      approvedPlanPath: "dev/plans/FER-34.md",
      approvedPlanPrUrl,
      approvedPlanCommit,
    },
  };
}
