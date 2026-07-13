import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { decorateFactoryReaction } from "../bin/factory-manual-command.ts";
import { factoryActionKey } from "../lib/factory-action-contract.ts";
import { inspectFactoryWorkItem } from "../lib/factory-inspect.ts";
import { appendFactoryActionEvent } from "../lib/factory-lifecycle-kernel.ts";
import {
  FactoryLifecycleEventSchema,
  type FactoryLifecycleEvent,
} from "../lib/factory-lifecycle-events.ts";
import { FactoryLifecycleStateSchema } from "../lib/factory-state-machine.ts";

const BIN = join(process.cwd(), "bin/harness.ts");
const ref = { base: "factory-store" as const, path: "inputs/item.json", sha256: "0".repeat(64) };

test("inspects null history without initializing or writing the store", () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-inspect-workspace-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "factory-inspect-store-"));
  const factoryStateRoot = join(projectRoot, "factory");

  const before = fingerprint(workspace, projectRoot);
  const result = inspectFactoryWorkItem({
    workItemKey: "linear:ENG-1",
    workspace,
    factoryStateRoot,
    factoryStoreProjectRoot: projectRoot,
  });

  expect(result).toEqual({
    workItemKey: "linear:ENG-1",
    artifactRoots: { repository: workspace, "factory-store": projectRoot },
    state: null,
    latestEvent: null,
    reaction: null,
  });
  expect(fingerprint(workspace, projectRoot)).toEqual(before);
  expect(existsSync(join(factoryStateRoot, "store-format.json"))).toBe(false);
});

test("reads an existing event log without creating a lifecycle lock", () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-inspect-workspace-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "factory-inspect-store-"));
  const factoryStateRoot = join(projectRoot, "factory");
  const imported: FactoryLifecycleEvent = {
    version: 1,
    id: "work_item.imported:linear:ENG-1",
    type: "work_item.imported",
    workItemKey: "linear:ENG-1",
    occurredAt: "2026-07-13T00:00:00.000Z",
    data: { source: "linear" },
  };
  const requested: FactoryLifecycleEvent = {
    version: 1,
    id: "triage.requested:triage-run",
    type: "triage.requested",
    workItemKey: "linear:ENG-1",
    occurredAt: "2026-07-13T00:01:00.000Z",
    phaseRunId: "triage-run",
    data: { expectedPredecessor: imported.id, inputRefs: [ref], intent: "start" },
  };
  appendFactoryActionEvent({ factoryStateRoot, event: imported, expectedLastEventId: null });
  appendFactoryActionEvent({
    factoryStateRoot,
    event: requested,
    expectedLastEventId: imported.id,
  });
  const before = fingerprint(workspace, projectRoot);

  const result = inspectFactoryWorkItem({
    workItemKey: "linear:ENG-1",
    workspace,
    factoryStateRoot,
    factoryStoreProjectRoot: projectRoot,
  });

  expect(result.latestEvent).toEqual(requested);
  expect(result.state).toMatchObject({
    phase: "triage",
    status: "awaiting-result",
    phaseRunId: "triage-run",
  });
  expect(result.reaction).toMatchObject({
    kind: "invoke",
    phase: "triage",
    handler: "triageWorkItem",
    attempt: 1,
  });
  expect(fingerprint(workspace, projectRoot)).toEqual(before);
  expect(readdirSync(join(factoryStateRoot, "locks"))).toEqual([]);
});

test.each([
  [
    "idle starts triage",
    FactoryLifecycleStateSchema.parse({
      projectionVersion: 1,
      workItemKey: "item-1",
      lastEventId: "import",
      updatedAt: "2026-07-13T00:00:00.000Z",
      phase: "idle",
      status: "idle",
    }),
    { kind: "wait", reason: "phase-command" } as const,
    "harness factory triage --workspace /repo --item-file 'item file.json' --factory-store-root '/store root'",
  ],
  [
    "triage routes to planning",
    FactoryLifecycleStateSchema.parse({
      projectionVersion: 1,
      workItemKey: "item-1",
      lastEventId: "triage",
      updatedAt: "2026-07-13T00:00:00.000Z",
      phase: "triage",
      status: "routed",
      phaseRunId: "triage-run",
      route: "ready-to-plan",
    }),
    { kind: "wait", reason: "phase-command" } as const,
    "harness factory planning run --workspace /repo --item-file 'item file.json' --factory-store-root '/store root'",
  ],
  [
    "approved planning starts implementation",
    FactoryLifecycleStateSchema.parse({
      projectionVersion: 1,
      workItemKey: "item-1",
      lastEventId: "plan",
      updatedAt: "2026-07-13T00:00:00.000Z",
      phase: "planning",
      status: "approved",
      phaseRunId: "planning-run",
      reviewCeiling: 2,
      attempt: 1,
      publicationMode: "local",
      outputPlan: "dev/plans/item.md",
    }),
    { kind: "wait", reason: "phase-command" } as const,
    "harness factory implementation run --workspace /repo --item-file 'item file.json' --factory-store-root '/store root'",
  ],
  [
    "human and terminal waits stay commandless",
    FactoryLifecycleStateSchema.parse({
      projectionVersion: 1,
      workItemKey: "item-1",
      lastEventId: "wait",
      updatedAt: "2026-07-13T00:00:00.000Z",
      phase: "triage",
      status: "needs-human",
      phaseRunId: "triage-run",
    }),
    { kind: "wait", reason: "human" } as const,
    undefined,
  ],
])("decorates only mechanically selectable reactions: %s", (_name, state, reaction, command) => {
  const decorated = decorateFactoryReaction(reaction, state, {
    workspace: "/repo",
    itemFile: "item file.json",
    factoryStoreRoot: "/store root",
  });
  expect(decorated).toEqual(command ? { ...reaction, command } : reaction);
});

test.each([
  {
    name: "active triage",
    build: (key: string) => {
      const imported = importedEvent(key);
      return [imported, triageRequested(key, imported.id)];
    },
    state: {
      phase: "triage",
      status: "awaiting-result",
      phaseRunId: "triage-run",
    },
    reaction: {
      kind: "invoke",
      phase: "triage",
      handler: "triageWorkItem",
      attempt: 1,
      causationEventId: "triage.requested:triage-run",
      scheduling: "immediate",
      reason: "triage-requested",
    },
    station: "triage",
  },
  {
    name: "active planning review",
    build: (key: string) => {
      const imported = importedEvent(key);
      const triage = triageRequested(key, imported.id);
      const completed = triageCompleted(key, triage.id, "ready-to-plan");
      const requested = planningRequested(key, completed.id);
      return [imported, triage, completed, requested, planningCandidate(key, requested.id)];
    },
    state: {
      phase: "planning",
      status: "awaiting-review",
      phaseRunId: "planning-run",
      reviewCeiling: 2,
      attempt: 1,
      publicationMode: "local",
      outputPlan: "dev/plans/fixture.md",
    },
    reaction: {
      kind: "invoke",
      phase: "planning",
      handler: "reviewPlanCandidate",
      attempt: 1,
      causationEventId: "planning.candidate.produced:planning-run:1",
      scheduling: "immediate",
      reason: "candidate-produced",
    },
    station: "planning",
  },
  {
    name: "implementation revision",
    build: (key: string) => {
      const imported = importedEvent(key);
      const triage = triageRequested(key, imported.id);
      const completed = triageCompleted(key, triage.id, "ready-to-implement");
      const requested = implementationRequested(key, completed.id);
      const candidate = implementationCandidate(key, requested.id);
      return [
        imported,
        triage,
        completed,
        requested,
        candidate,
        implementationReview(key, candidate.id, "needs_changes"),
      ];
    },
    state: {
      phase: "implementation",
      status: "needs-revision",
      phaseRunId: "implementation-run",
      reviewCeiling: 2,
      attempt: 1,
    },
    reaction: {
      kind: "invoke",
      phase: "implementation",
      handler: "produceImplementationCandidate",
      attempt: 2,
      causationEventId: "implementation.review.completed:reviewImplementationCandidate:1",
      scheduling: "immediate",
      reason: "review-needs-changes",
    },
    station: "implementation",
  },
  {
    name: "human wait",
    build: (key: string) => {
      const imported = importedEvent(key);
      const requested = planningRequested(key, imported.id);
      return [imported, requested, planningInputRequired(key, requested.id)];
    },
    state: {
      phase: "planning",
      status: "needs-human",
      phaseRunId: "planning-run",
      reviewCeiling: 2,
      attempt: 1,
      publicationMode: "local",
      outputPlan: "dev/plans/fixture.md",
    },
    reaction: { kind: "wait", reason: "human" },
  },
  {
    name: "terminal failure",
    build: (key: string) => {
      const imported = importedEvent(key);
      const requested = triageRequested(key, imported.id);
      return [
        imported,
        requested,
        actionEvent({
          key,
          type: "factory.action.failed",
          phaseRunId: "triage-run",
          handler: "triageWorkItem",
          attempt: 1,
          causationEventId: requested.id,
          at: 2,
          label: "triage-terminal-failure",
          data: { phase: "triage", failureKind: "terminal", message: "terminal failure" },
        }),
      ];
    },
    state: {
      phase: "triage",
      status: "failed",
      phaseRunId: "triage-run",
    },
    reaction: { kind: "wait", reason: "failed" },
  },
  {
    name: "terminal completion",
    build: (key: string) => {
      const imported = importedEvent(key);
      const triage = triageRequested(key, imported.id);
      const completed = triageCompleted(key, triage.id, "ready-to-implement");
      const requested = implementationRequested(key, completed.id);
      const candidate = implementationCandidate(key, requested.id);
      return [
        imported,
        triage,
        completed,
        requested,
        candidate,
        implementationReview(key, candidate.id, "pass"),
      ];
    },
    state: {
      phase: "implementation",
      status: "complete",
      phaseRunId: "implementation-run",
      reviewCeiling: 2,
      attempt: 1,
    },
    reaction: { kind: "wait", reason: "complete" },
  },
] as const)("inspects durable lifecycle state and stays repeatable: %s", (scenario) => {
  const fixture = durableFixture(scenario.build("file:fixture"));
  const before = fingerprint(fixture.workspace, fixture.projectRoot);
  const latestEvent = fixture.events.at(-1)!;
  const expectedState = {
    projectionVersion: 1,
    workItemKey: "file:fixture",
    lastEventId: latestEvent.id,
    updatedAt: latestEvent.occurredAt,
    ...scenario.state,
  };
  const expectedReaction = {
    ...scenario.reaction,
    ...(scenario.reaction.kind === "invoke" ? { causationEventId: latestEvent.id } : {}),
  };
  const expectedCommand = scenario.station
    ? manualCommand(fixture.workspace, fixture.storeRoot, scenario.station)
    : undefined;
  const decoratedReaction = expectedCommand
    ? { ...expectedReaction, command: expectedCommand }
    : expectedReaction;

  const direct = inspectFactoryWorkItem({
    workItemKey: "file:fixture",
    workspace: fixture.workspace,
    factoryStateRoot: fixture.factoryStateRoot,
    factoryStoreProjectRoot: fixture.projectRoot,
  });
  expect(direct).toEqual({
    workItemKey: "file:fixture",
    artifactRoots: { repository: fixture.workspace, "factory-store": fixture.projectRoot },
    state: expectedState,
    latestEvent,
    reaction: expectedReaction,
  });

  const first = execInspect(fixture.workspace, fixture.storeRoot, ["--item-file", "item.json"]);
  const second = execInspect(fixture.workspace, fixture.storeRoot, ["--item-file", "item.json"]);
  expect(first).toBe(second);
  expect(JSON.parse(first)).toEqual({
    workItemKey: "file:fixture",
    artifactRoots: { repository: fixture.workspace, "factory-store": fixture.projectRoot },
    state: expectedState,
    latestEvent,
    reaction: decoratedReaction,
  });
  expect(fingerprint(fixture.workspace, fixture.projectRoot)).toEqual(before);
});

test("CLI inspection is store-only, normalizes Linear keys, and is byte-stable", () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-inspect-workspace-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "factory-inspect-store-"));
  const first = execInspect(workspace, storeRoot, ["--linear-issue", "eng-001"]);
  const second = execInspect(workspace, storeRoot, ["--linear-issue", "eng-001"]);
  expect(first).toBe(second);
  expect(JSON.parse(first)).toMatchObject({
    workItemKey: "linear:ENG-1",
    state: null,
    latestEvent: null,
    reaction: null,
  });
  expect(existsSync(join(storeRoot, "projects"))).toBe(false);

  const invalid = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      BIN,
      "factory",
      "inspect",
      "--workspace",
      workspace,
      "--linear-issue",
      "00000000-0000-0000-0000-000000000000",
    ],
    { encoding: "utf8" },
  );
  expect(invalid.status).not.toBe(0);
  expect(invalid.stderr).toContain("store-only");
  expect(invalid.stderr).toContain("will not fetch");
});

test("item-file inspection derives only its durable key", () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-inspect-workspace-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "factory-inspect-store-"));
  const itemPath = join(workspace, "item.json");
  writeFileSync(
    itemPath,
    JSON.stringify({ id: "work-1", source: "file", title: "first", body: "body", labels: [] }),
  );
  const first = JSON.parse(execInspect(workspace, storeRoot, ["--item-file", "item.json"]));
  writeFileSync(
    itemPath,
    JSON.stringify({ id: "work-1", source: "file", title: "changed", body: "other", labels: [] }),
  );
  const second = JSON.parse(execInspect(workspace, storeRoot, ["--item-file", "item.json"]));
  expect(first.workItemKey).toBe("file:work-1");
  expect(second).toEqual(first);
});

type FactoryHandler = Parameters<typeof factoryActionKey>[0]["handler"];
type ActionEventType =
  | "triage.work_item.completed"
  | "planning.candidate.produced"
  | "planning.input.required"
  | "planning.review.completed"
  | "implementation.candidate.produced"
  | "implementation.review.completed"
  | "factory.action.failed";

function importedEvent(workItemKey: string): FactoryLifecycleEvent {
  return FactoryLifecycleEventSchema.parse({
    version: 1,
    id: "work_item.imported:fixture",
    type: "work_item.imported",
    workItemKey,
    occurredAt: at(0),
    data: { source: "file" },
  });
}

function triageRequested(workItemKey: string, predecessor: string): FactoryLifecycleEvent {
  return FactoryLifecycleEventSchema.parse({
    version: 1,
    id: "triage.requested:triage-run",
    type: "triage.requested",
    workItemKey,
    occurredAt: at(1),
    phaseRunId: "triage-run",
    data: {
      expectedPredecessor: predecessor,
      inputRefs: [artifactRef("inputs/item")],
      intent: "start",
    },
  });
}

function triageCompleted(
  workItemKey: string,
  predecessor: string,
  route: "ready-to-plan" | "ready-to-implement",
): FactoryLifecycleEvent {
  return actionEvent({
    key: workItemKey,
    type: "triage.work_item.completed",
    phaseRunId: "triage-run",
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: predecessor,
    at: 2,
    label: `triage-${route}`,
    data: { route, rationale: `route ${route}` },
  });
}

function planningRequested(workItemKey: string, predecessor: string): FactoryLifecycleEvent {
  return FactoryLifecycleEventSchema.parse({
    version: 1,
    id: "planning.requested:planning-run",
    type: "planning.requested",
    workItemKey,
    occurredAt: at(3),
    phaseRunId: "planning-run",
    data: {
      expectedPredecessor: predecessor,
      inputRefs: [artifactRef("inputs/item")],
      intent: "start",
      reviewCeiling: 2,
      publicationMode: "local",
      outputPlan: "dev/plans/fixture.md",
    },
  });
}

function planningCandidate(workItemKey: string, predecessor: string): FactoryLifecycleEvent {
  return actionEvent({
    key: workItemKey,
    type: "planning.candidate.produced",
    phaseRunId: "planning-run",
    handler: "producePlanCandidate",
    attempt: 1,
    causationEventId: predecessor,
    at: 4,
    label: "planning-candidate",
    data: {
      candidate: artifactRef("planning/candidate"),
      effectiveSession: { provider: "fixture", id: "planning-session" },
    },
  });
}

function planningInputRequired(workItemKey: string, predecessor: string): FactoryLifecycleEvent {
  return actionEvent({
    key: workItemKey,
    type: "planning.input.required",
    phaseRunId: "planning-run",
    handler: "producePlanCandidate",
    attempt: 1,
    causationEventId: predecessor,
    at: 4,
    label: "planning-questions",
    data: { questions: artifactRef("planning/questions") },
  });
}

function implementationRequested(workItemKey: string, predecessor: string): FactoryLifecycleEvent {
  return FactoryLifecycleEventSchema.parse({
    version: 1,
    id: "implementation.requested:implementation-run",
    type: "implementation.requested",
    workItemKey,
    occurredAt: at(3),
    phaseRunId: "implementation-run",
    data: {
      expectedPredecessor: predecessor,
      inputRefs: [artifactRef("inputs/item")],
      reviewCeiling: 2,
      intent: "start",
    },
  });
}

function implementationCandidate(workItemKey: string, predecessor: string): FactoryLifecycleEvent {
  return actionEvent({
    key: workItemKey,
    type: "implementation.candidate.produced",
    phaseRunId: "implementation-run",
    handler: "produceImplementationCandidate",
    attempt: 1,
    causationEventId: predecessor,
    at: 4,
    label: "implementation-candidate",
    data: {
      commit: "fixture-commit",
      tree: "fixture-tree",
      candidate: artifactRef("implementation/candidate"),
      effectiveSession: { provider: "fixture", id: "implementation-session" },
    },
  });
}

function implementationReview(
  workItemKey: string,
  predecessor: string,
  verdict: "pass" | "needs_changes",
): FactoryLifecycleEvent {
  return actionEvent({
    key: workItemKey,
    type: "implementation.review.completed",
    phaseRunId: "implementation-run",
    handler: "reviewImplementationCandidate",
    attempt: 1,
    causationEventId: predecessor,
    at: 5,
    label: `implementation-review-${verdict}`,
    data: {
      verdict,
      review: artifactRef(`implementation/review-${verdict}`),
      reviewCeiling: 2,
      ...(verdict === "needs_changes"
        ? { blockingFindings: artifactRef("implementation/blocking-findings") }
        : {}),
    },
  });
}

function actionEvent(input: {
  key: string;
  type: ActionEventType;
  phaseRunId: string;
  handler: FactoryHandler;
  attempt: number;
  causationEventId: string;
  at: number;
  label: string;
  data: Record<string, unknown>;
}): FactoryLifecycleEvent {
  const actionKey = factoryActionKey({
    phaseRunId: input.phaseRunId,
    handler: input.handler,
    attempt: input.attempt,
    causationEventId: input.causationEventId,
  });
  return FactoryLifecycleEventSchema.parse({
    version: 1,
    id: `${input.type}:${actionKey}`,
    type: input.type,
    workItemKey: input.key,
    occurredAt: at(input.at),
    phaseRunId: input.phaseRunId,
    data: {
      handler: input.handler,
      handlerVersion: 1,
      attempt: input.attempt,
      causationEventId: input.causationEventId,
      execution: { workspaceRef: "fixture-workspace", runRef: artifactRef(`${input.label}/run`) },
      evidence: [artifactRef(`${input.label}/evidence`)],
      ...input.data,
    },
  });
}

function artifactRef(path: string) {
  return { base: "factory-store" as const, path: `${path}.json`, sha256: "a".repeat(64) };
}

function at(minutes: number): string {
  return `2026-07-13T00:${String(minutes).padStart(2, "0")}:00.000Z`;
}

function durableFixture(events: FactoryLifecycleEvent[]) {
  const workspace = mkdtempSync(join(tmpdir(), "factory-inspect-workspace-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "factory-inspect-store-"));
  const projectRoot = join(storeRoot, "projects", "inspect-test");
  const factoryStateRoot = join(projectRoot, "factory");
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({ id: "fixture", source: "file", title: "fixture", body: "body", labels: [] }),
  );
  let expectedLastEventId: string | null = null;
  for (const event of events) {
    appendFactoryActionEvent({ factoryStateRoot, event, expectedLastEventId });
    expectedLastEventId = event.id;
  }
  return { workspace, storeRoot, projectRoot, factoryStateRoot, events };
}

function manualCommand(
  workspace: string,
  storeRoot: string,
  station: "triage" | "planning" | "implementation",
): string {
  const stationArgs =
    station === "triage"
      ? ["triage"]
      : station === "planning"
        ? ["planning", "run"]
        : ["implementation", "run"];
  return [
    "harness",
    "factory",
    ...stationArgs,
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--factory-store-root",
    storeRoot,
    "--factory-store-project-id",
    "inspect-test",
  ]
    .map(shellArg)
    .join(" ");
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function execInspect(workspace: string, storeRoot: string, selector: string[]): string {
  return execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      BIN,
      "factory",
      "inspect",
      "--workspace",
      workspace,
      "--factory-store-root",
      storeRoot,
      "--factory-store-project-id",
      "inspect-test",
      ...selector,
    ],
    { encoding: "utf8" },
  );
}

function fingerprint(...roots: string[]): string {
  return roots.map((root) => `${root}:${fingerprintPath(root)}`).join("|");
}

function fingerprintPath(path: string): string {
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (stat.isFile()) return `file:${readFileSync(path).toString("base64")}`;
  return readdirSync(path)
    .sort()
    .map((name) => `${name}:${fingerprintPath(join(path, name))}`)
    .join(";");
}
