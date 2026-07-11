import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  factoryLifecycleEventPath,
  factoryLifecycleStatePath,
  inspectFactoryLifecycleState,
  loadFactoryLifecycleState,
  mergeFactoryStateIntoWorkItem,
  readFactoryLifecycleEvents,
  reduceFactoryLifecycleEvents,
  resolveFactoryStateRoot,
  workItemKeyToFilename,
  type FactoryLifecycleEvent,
} from "../lib/factory-lifecycle.ts";
import {
  FACTORY_LOCK_STALE_MS,
  FactoryLifecycleLockTimeoutError,
  acquireFactoryWorkItemLock,
  factoryWorkItemLockPath,
  inspectFactoryWorkItemLock,
  releaseFactoryWorkItemLock,
  withFactoryWorkItemLock,
} from "../lib/factory-locks.ts";
import {
  appendImplementationStartedEvent,
  appendImplementationTerminalEvent,
  formatLifecycleArtifactPath,
} from "../lib/factory-lifecycle-writes.ts";
import type { FactoryImplementationRunMeta } from "../lib/factory-implementation-run-context.ts";
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
  expect(readdirSync(join(root, "state")).some((entry) => entry.includes(".tmp-"))).toBe(false);
});

test("lifecycle locks serialize same work item and keep different work items independent", () => {
  const root = tempRoot();
  const first = acquireFactoryWorkItemLock({
    factoryStateRoot: root,
    workItemKey: "linear:FER-34",
    workItemFilename: workItemKeyToFilename("linear:FER-34"),
    workspace: "/workspace",
    operation: "write",
    options: { token: "first", timeoutMs: 1 },
  });

  expect(() =>
    acquireFactoryWorkItemLock({
      factoryStateRoot: root,
      workItemKey: "linear:FER-34",
      workItemFilename: workItemKeyToFilename("linear:FER-34"),
      workspace: "/workspace",
      operation: "write",
      options: { timeoutMs: 0 },
    }),
  ).toThrow(FactoryLifecycleLockTimeoutError);

  const second = acquireFactoryWorkItemLock({
    factoryStateRoot: root,
    workItemKey: "linear:FER-35",
    workItemFilename: workItemKeyToFilename("linear:FER-35"),
    workspace: "/workspace",
    operation: "write",
    options: { token: "second", timeoutMs: 1 },
  });
  releaseFactoryWorkItemLock({
    factoryStateRoot: root,
    workItemFilename: workItemKeyToFilename("linear:FER-35"),
    owner: second,
  });
  releaseFactoryWorkItemLock({
    factoryStateRoot: root,
    workItemFilename: workItemKeyToFilename("linear:FER-34"),
    owner: first,
  });
  expect(existsSync(join(root, "locks"))).toBe(true);
});

test("lock owner metadata and stale lock handling are inspectable and fail closed", () => {
  const root = tempRoot();
  const workItemKey = "linear:FER-34";
  const filename = workItemKeyToFilename(workItemKey);
  const lockPath = factoryWorkItemLockPath(root, filename);
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(
    join(lockPath, "owner.json"),
    `${JSON.stringify({
      pid: 999_999_999,
      hostname: "test-host",
      token: "stale-token",
      workspace: "/workspace",
      runDir: "/runs/one",
      workItemKey,
      startedAt: new Date(0).toISOString(),
    })}\n`,
    "utf8",
  );
  const stale = inspectFactoryWorkItemLock({
    factoryStateRoot: root,
    workItemKey,
    workItemFilename: filename,
    options: { hostname: "test-host", now: () => FACTORY_LOCK_STALE_MS + 1 },
  });
  expect(stale).toMatchObject({
    stale: true,
    owner: {
      pid: 999_999_999,
      hostname: "test-host",
      token: "stale-token",
      workspace: "/workspace",
    },
  });

  const owner = acquireFactoryWorkItemLock({
    factoryStateRoot: root,
    workItemKey,
    workItemFilename: filename,
    workspace: "/new-workspace",
    operation: "write",
    options: {
      hostname: "test-host",
      token: "new-token",
      timeoutMs: 1,
      now: () => FACTORY_LOCK_STALE_MS + 1,
    },
  });
  expect(owner).toMatchObject({ workspace: "/new-workspace", workItemKey, token: "new-token" });
  releaseFactoryWorkItemLock({ factoryStateRoot: root, workItemFilename: filename, owner });
});

test("incomplete lock owners report safely and owner publication failures release their lock", () => {
  const root = tempRoot();
  const workItemKey = "linear:FER-34";
  const filename = workItemKeyToFilename(workItemKey);
  const lockPath = factoryWorkItemLockPath(root, filename);
  mkdirSync(lockPath, { recursive: true });
  expect(
    inspectFactoryWorkItemLock({ factoryStateRoot: root, workItemKey, workItemFilename: filename }),
  ).toMatchObject({ classification: "owner-missing" });

  expect(() =>
    acquireFactoryWorkItemLock({
      factoryStateRoot: root,
      workItemKey,
      workItemFilename: filename,
      workspace: "/workspace",
      operation: "write",
      options: { timeoutMs: 0 },
    }),
  ).toThrow(FactoryLifecycleLockTimeoutError);

  writeFileSync(join(lockPath, "owner.json"), "{not-json}\n", "utf8");
  expect(
    inspectFactoryWorkItemLock({ factoryStateRoot: root, workItemKey, workItemFilename: filename }),
  ).toMatchObject({ classification: "owner-invalid", stale: false });

  const otherKey = "linear:FER-35";
  const otherFilename = workItemKeyToFilename(otherKey);
  expect(() =>
    withFactoryWorkItemLock(
      {
        factoryStateRoot: root,
        workItemKey: otherKey,
        workItemFilename: otherFilename,
        workspace: "/workspace",
        operation: "write",
        options: {
          publishOwner: () => {
            throw new Error("cannot publish owner");
          },
        },
      },
      () => undefined,
    ),
  ).toThrow("cannot publish owner");
  expect(existsSync(factoryWorkItemLockPath(root, otherFilename))).toBe(false);
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

test.each([
  ["ready-to-plan", "create-plan"],
  ["ready-to-implement", "implement-directly"],
] as const)("new %s triage clears every prior plan publication field", (route, nextAction) => {
  const workItemKey = "linear:FER-34";
  const state = reduceFactoryLifecycleEvents([
    importedEvent(workItemKey, {
      tracker: { source: "linear", id: "FER-34" },
      approvedPlanPath: "dev/plans/FER-34.md",
      approvedPlanPrUrl: "https://github.com/example/repo/pull/1",
      approvedPlanCommit: "abc1234",
    }),
    triageCompletedEvent(workItemKey, route, nextAction),
  ]);

  expect(state).not.toHaveProperty("approvedPlanPath");
  expect(state).not.toHaveProperty("approvedPlanPrUrl");
  expect(state).not.toHaveProperty("approvedPlanCommit");
  expect(state).toMatchObject({ factoryRoute: route, factoryNextAction: nextAction });
});

test("implementation started claims durable implementation ownership", () => {
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
    {
      ...baseEvent("implementation.started:run-3", "linear:FER-34", "run-3"),
      runId: "run-3",
      type: "implementation.started",
      data: { linearIssue: "FER-34" },
    },
  ]);

  expect(state).toMatchObject({
    workItemKey: "linear:FER-34",
    lastEventId: "implementation.started:run-3",
  });
  expect(state?.factoryStage).toBe("implementation-started");
  expect(state?.factoryRunId).toBe("run-3");
});

test("implementation completed moves to implementation-complete and preserves plan retry fields", () => {
  const state = reduceFactoryLifecycleEvents([
    importedEvent("linear:FER-34", { tracker: { source: "linear", id: "FER-34" } }),
    planningCompletedEvent("linear:FER-34", "plan-approved"),
    planPrOpenedEvent("linear:FER-34", "https://github.com/owner/repo/pull/1"),
    planPrMergedEvent("linear:FER-34", "https://github.com/owner/repo/pull/1", "abc123"),
    {
      ...baseEvent("implementation.completed:impl-1", "linear:FER-34", "impl-1"),
      runId: "impl-1",
      type: "implementation.completed",
      data: {
        diffPath: "implementation/diff.patch",
        changeReviewHandoffPath: "implementation/change-review-handoff.md",
        reviewBase: "aaa111",
        reviewHead: "refs/harness/factory/impl-1/implementation",
        reviewCommitSha: "bbb222",
      },
    },
  ]);

  expect(state).toMatchObject({
    factoryStage: "implementation-complete",
    factoryRunId: "impl-1",
    approvedPlanPath: "dev/plans/FER-34.md",
    approvedPlanCommit: "abc123",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/1",
    lastEventId: "implementation.completed:impl-1",
  });
});

test("file planned import seeds plan retry fields preserved through implementation.completed", () => {
  const imported: FactoryLifecycleEvent = {
    ...baseEvent("work_item.imported:file:smoke-planned", "file:smoke-planned"),
    type: "work_item.imported",
    data: {
      source: "file",
      title: "Lifecycle issue",
      tracker: { source: "file", id: "smoke-planned" },
      approvedPlanPath: "dev/plans/SMOKE.md",
      approvedPlanCommit: "deadbeef",
    },
  };
  const state = reduceFactoryLifecycleEvents([
    imported,
    {
      ...baseEvent("implementation.completed:impl-file", "file:smoke-planned", "impl-file"),
      runId: "impl-file",
      type: "implementation.completed",
      data: {
        diffPath: "implementation/diff.patch",
        changeReviewHandoffPath: "implementation/change-review-handoff.md",
        reviewBase: "aaa111",
        reviewHead: "refs/harness/factory/impl-file/implementation",
        reviewCommitSha: "bbb222",
      },
    },
  ]);

  expect(state).toMatchObject({
    factoryStage: "implementation-complete",
    factoryRunId: "impl-file",
    approvedPlanPath: "dev/plans/SMOKE.md",
    approvedPlanCommit: "deadbeef",
    lastEventId: "implementation.completed:impl-file",
  });
});

test("implementation failed moves to implementation-failed and preserves plan retry fields", () => {
  const state = reduceFactoryLifecycleEvents([
    importedEvent("linear:FER-34", { tracker: { source: "linear", id: "FER-34" } }),
    planningCompletedEvent("linear:FER-34", "plan-approved"),
    planPrOpenedEvent("linear:FER-34", "https://github.com/owner/repo/pull/1"),
    planPrMergedEvent("linear:FER-34", "https://github.com/owner/repo/pull/1", "abc123"),
    {
      ...baseEvent("implementation.failed:impl-1", "linear:FER-34", "impl-1"),
      runId: "impl-1",
      type: "implementation.failed",
      data: { error: "Implementer failed" },
    },
  ]);

  expect(state).toMatchObject({
    factoryStage: "implementation-failed",
    factoryRunId: "impl-1",
    approvedPlanPath: "dev/plans/FER-34.md",
    approvedPlanCommit: "abc123",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/1",
    lastEventId: "implementation.failed:impl-1",
  });
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

test("inspect-only lifecycle reads warn without rebuilding a corrupt projection", () => {
  const root = tempRoot();
  const event = importedEvent("linear:FER-34");
  appendFactoryLifecycleEvent({ factoryStateRoot: root, event });
  const statePath = factoryLifecycleStatePath(root, event.workItemKey);
  writeFileSync(statePath, "{not-json}\n", "utf8");

  const inspected = inspectFactoryLifecycleState({
    factoryStateRoot: root,
    workItemKey: event.workItemKey,
  });
  expect(inspected).toMatchObject({
    state: { lastEventId: event.id },
    warnings: [{ code: "durable-state-stale", factoryStateRoot: root }],
  });
  expect(readFileSync(statePath, "utf8")).toBe("{not-json}\n");

  expect(
    loadFactoryLifecycleState({ factoryStateRoot: root, workItemKey: event.workItemKey }),
  ).toMatchObject({ lastEventId: event.id });
  expect(() => JSON.parse(readFileSync(statePath, "utf8"))).not.toThrow();
});

test("durable artifact paths are run-relative, store-relative, or absolute without parent traversal", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-lifecycle-workspace-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "harness-lifecycle-store-"));
  const runDir = join(projectRoot, "runs/factory/run-1");

  const triage = formatLifecycleArtifactPath({
    projectRoot,
    runDir,
    path: "factory-route.md",
  });
  const planning = formatLifecycleArtifactPath({
    projectRoot,
    runDir,
    path: join(projectRoot, "runs/reviews/review-1/summary.md"),
  });
  const implementation = formatLifecycleArtifactPath({
    projectRoot,
    runDir,
    path: join(workspace, "dev/plans/FER-53.md"),
  });

  expect(triage).toBe("factory-route.md");
  expect(planning).toBe("runs/reviews/review-1/summary.md");
  expect(implementation).toBe(join(workspace, "dev/plans/FER-53.md"));
  for (const path of [triage, planning, implementation]) {
    expect(path.startsWith("..")).toBe(false);
  }
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

test("merge replaces every lifecycle-owned source field when durable state exists", () => {
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
      factoryRoute: "ready-to-plan",
      factoryNextAction: "create-plan",
      factoryRunId: "stale-run",
      approvedPlanPath: "dev/plans/stale.md",
      approvedPlanPrUrl: "https://github.com/example/repo/pull/1",
      approvedPlanCommit: "abc1234",
      linearIssueId: "issue-1",
    },
  };
  const state = reduceFactoryLifecycleEvents([
    importedEvent("linear:FER-34", { tracker: { source: "linear", id: "FER-34" } }),
  ]);

  const metadata = mergeFactoryStateIntoWorkItem(workItem, state).metadata;
  expect(metadata).toMatchObject({
    linearStatus: "Backlog",
    linearIssueId: "issue-1",
    tracker: { source: "linear", id: "FER-34" },
  });
  for (const key of [
    "factoryStage",
    "factoryRoute",
    "factoryNextAction",
    "factoryRunId",
    "approvedPlanPath",
    "approvedPlanPrUrl",
    "approvedPlanCommit",
  ]) {
    expect(metadata).not.toHaveProperty(key);
  }
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

test("appendImplementationStartedEvent writes audit-only started event", () => {
  const root = tempRoot();
  const workspace = mkdtempSync(join(tmpdir(), "harness-lifecycle-impl-ws-"));
  const workItem = implementationWorkItem();

  appendImplementationStartedEvent({
    workspace,
    workItem,
    runId: "impl-1",
    factoryStateRoot: root,
    execution: { workspace, runDir: join(workspace, ".harness/runs/factory/impl-1") },
    linearIssue: "FER-34",
    occurredAt: OCCURRED_AT,
  });

  const events = readFactoryLifecycleEvents({
    factoryStateRoot: root,
    workItemKey: "linear:FER-34",
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "implementation.started",
    runId: "impl-1",
    data: { linearIssue: "FER-34" },
  });
});

test("appendImplementationTerminalEvent dry-run skips writes", () => {
  const root = tempRoot();
  const meta = implementationMeta({ status: "dry_run" });

  expect(
    appendImplementationTerminalEvent({
      meta,
      factoryStateRoot: root,
    }),
  ).toBeUndefined();
  expect(
    readFactoryLifecycleEvents({
      factoryStateRoot: root,
      workItemKey: "linear:FER-34",
    }),
  ).toHaveLength(0);
});

test("appendImplementationTerminalEvent completed emits review fields", () => {
  const root = tempRoot();
  const meta = implementationMeta({
    status: "implementation-complete",
    reviewBase: "aaa111",
    reviewHead: "refs/harness/factory/impl-1/implementation",
    reviewCommitSha: "bbb222",
  });

  const event = appendImplementationTerminalEvent({
    meta,
    factoryStateRoot: root,
  });

  expect(event).toMatchObject({
    type: "implementation.completed",
    data: {
      reviewBase: "aaa111",
      reviewHead: "refs/harness/factory/impl-1/implementation",
      reviewCommitSha: "bbb222",
      diffPath: expect.stringContaining("implementation/diff.patch"),
      changeReviewHandoffPath: expect.stringContaining("implementation/change-review-handoff.md"),
    },
  });
  expect(
    readFactoryLifecycleEvents({
      factoryStateRoot: root,
      workItemKey: "linear:FER-34",
    }),
  ).toHaveLength(1);
});

test("appendImplementationTerminalEvent failed emits error", () => {
  const root = tempRoot();
  const meta = implementationMeta({
    status: "implementation-failed",
    error: "Implementer crashed",
  });

  const event = appendImplementationTerminalEvent({
    meta,
    factoryStateRoot: root,
  });

  expect(event).toMatchObject({
    type: "implementation.failed",
    data: { error: "Implementer crashed" },
  });
  expect(
    readFactoryLifecycleEvents({
      factoryStateRoot: root,
      workItemKey: "linear:FER-34",
    }),
  ).toHaveLength(1);
});

function implementationWorkItem(): FactoryWorkItem {
  return {
    id: "linear:FER-34",
    source: "linear",
    title: "Implementation issue",
    body: "",
    labels: ["factory"],
    metadata: { tracker: { source: "linear", id: "FER-34" } },
  };
}

function implementationMeta(
  overrides: Partial<FactoryImplementationRunMeta> & {
    status: FactoryImplementationRunMeta["status"];
  },
): FactoryImplementationRunMeta {
  const workspace = mkdtempSync(join(tmpdir(), "harness-lifecycle-impl-meta-"));
  const runDir = join(workspace, ".harness/runs/factory/impl-1");
  mkdirSync(runDir, { recursive: true });
  return {
    runId: "impl-1",
    workflow: "factory-implementation",
    status: overrides.status,
    mode: "direct",
    workspace,
    runDir,
    workItem: {
      id: "linear:FER-34",
      source: "linear",
      title: "Implementation issue",
    },
    implementerAgent: { name: "cursor", model: "composer-2.5" },
    artifacts: {
      workItem: "context/work-item.json",
      implementationInput: "context/implementation-input.json",
      sourceMaterial: "context/source-material.json",
      prompt: "implementation/prompt.md",
      changeReviewHandoff: "implementation/change-review-handoff.md",
      summary: "summary.md",
      meta: "meta.json",
      ...(overrides.status !== "dry_run"
        ? {
            rawOutput: "implementation/implementer.raw.json" as const,
            workspaceStatus: "implementation/workspace-status.json" as const,
            diff: "implementation/diff.patch" as const,
          }
        : {}),
    },
    summaryPath: join(runDir, "summary.md"),
    metaPath: join(runDir, "meta.json"),
    startedAt: OCCURRED_AT,
    durationMs: 1,
    ...(overrides.status !== "dry_run" ? { eventsFile: "events.jsonl" as const } : {}),
    ...(overrides.error ? { error: overrides.error } : {}),
    ...(overrides.reviewBase ? { reviewBase: overrides.reviewBase } : {}),
    ...(overrides.reviewHead ? { reviewHead: overrides.reviewHead } : {}),
    ...(overrides.reviewCommitSha ? { reviewCommitSha: overrides.reviewCommitSha } : {}),
  };
}

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
    approvedPlanPath?: string;
    approvedPlanPrUrl?: string;
    approvedPlanCommit?: string;
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
      ...(overrides.approvedPlanPath ? { approvedPlanPath: overrides.approvedPlanPath } : {}),
      ...(overrides.approvedPlanPrUrl ? { approvedPlanPrUrl: overrides.approvedPlanPrUrl } : {}),
      ...(overrides.approvedPlanCommit ? { approvedPlanCommit: overrides.approvedPlanCommit } : {}),
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
