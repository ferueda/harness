import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Agent } from "./agents.ts";
import { createFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { writeFactoryActionResult } from "./factory-action-result.ts";
import {
  expectNoProviderOrGroveCalls,
  fixture,
  git,
  implementationFixture,
  registerHostedFixtureRoot,
} from "../test/factory-hosted-operation-test-fixtures.ts";
import { runHostedFactoryOperation } from "./factory-hosted-operation.ts";
import { deriveFactoryGroveWorkspaceIntent } from "./factory-grove-workspace.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { createFactoryOperationRef } from "./factory-operation.ts";
import { writeFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import { deriveFactoryRepoIdentity } from "./factory-store.ts";

test("executes exactly one current handler with predecessor-derived Grove intent", async () => {
  const value = fixture();
  const receipt = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });
  expect(receipt).toEqual({
    version: 1,
    ...value.request,
    outcome: "executed",
    resultEventId: expect.any(String),
    next: {
      ...value.request,
      operation: createFactoryOperationRef({
        phaseRunId: value.phaseRunId,
        handler: "triageWorkItem",
        attempt: 1,
        causationEventId: value.failed().id,
      }),
    },
  });
  expect(value.ensureWorkspace).toHaveBeenCalledOnce();
  expect(value.ensureWorkspace.mock.calls[0]?.[0].intent).toMatchObject({
    repositoryId: value.repositoryId,
    workItemKey: value.workItemKey,
    phase: "triage",
    phaseGeneration: value.imported.id,
    baseSha: value.baseSha,
    target: { mode: "detached", ref: value.baseSha },
  });
  expect(value.agentProviderFactory).toHaveBeenCalledOnce();
  expect(value.runProvider).toHaveBeenCalledOnce();
  expect(value.providerRun).not.toHaveBeenCalled();
});

test("third hosted retryable execution waits without another operation", async () => {
  const value = fixture();
  let request = value.request;

  for (let execution = 1; execution <= 3; execution += 1) {
    const receipt = await runHostedFactoryOperation({ request, runtime: value.runtime });
    expect(receipt).toMatchObject({
      outcome: "executed",
      ...(execution === 3 ? {} : { next: expect.any(Object) }),
    });
    if (execution < 3) {
      if (!("next" in receipt) || !receipt.next) throw new Error("expected retry operation");
      request = receipt.next;
    } else {
      expect("next" in receipt).toBe(false);
    }
  }

  expect(value.runProvider).toHaveBeenCalledTimes(3);
  expect(readFactoryActionEvents(value.factoryStateRoot, value.workItemKey).at(-1)).toMatchObject({
    type: "factory.action.failed",
    data: {
      failureKind: "human-required",
      message: expect.stringContaining("limit 3"),
    },
  });
});

test("executes hosted planning on the exact persisted deterministic Grove branch", async () => {
  const value = planningFixture();
  const receipt = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });

  expect(receipt).toMatchObject({ outcome: "executed" });
  expect(value.ensureWorkspace).toHaveBeenCalledOnce();
  expect(value.providerRun).toHaveBeenCalledOnce();
  expect(value.providerRun.mock.calls[0]?.[0].workspace).toBe(realpathSync(value.workspace));
  expect(git(value.workspace, ["symbolic-ref", "-q", "HEAD"])).toBe(value.branchRef);
});

test("rejects a manually started planning branch that differs from Grove authority", async () => {
  const value = planningFixture();
  const identityPath = join(value.runDir, "context/phase-run.json");
  const identity = JSON.parse(readFileSync(identityPath, "utf8"));
  writeFileSync(
    identityPath,
    `${JSON.stringify({
      ...identity,
      git: { ...identity.git, target: { mode: "branch", branchRef: "refs/heads/manual" } },
    })}\n`,
  );

  await expect(
    runHostedFactoryOperation({ request: value.request, runtime: value.runtime }),
  ).rejects.toThrow(/intent conflicts/);
  expect(value.ensureWorkspace).not.toHaveBeenCalled();
  expect(value.providerRun).not.toHaveBeenCalled();
});

test("executes hosted implementation on the exact persisted deterministic Grove branch", async () => {
  const value = implementationFixture();
  const receipt = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });

  expect(receipt).toMatchObject({ outcome: "executed" });
  expect(value.ensureWorkspace).toHaveBeenCalledOnce();
  expect(value.providerRun).toHaveBeenCalledOnce();
  expect(value.providerRun.mock.calls[0]?.[0].workspace).toBe(realpathSync(value.workspace));
  expect(git(value.workspace, ["symbolic-ref", "-q", "HEAD"])).toBe(value.branchRef);
});

test("recovers a completed result without Grove or provider work", async () => {
  const value = fixture();
  writeFactoryActionResult(
    join(value.runDir, "actions/1/triageWorkItem", value.operation.actionKey),
    value.completed(),
  );
  const receipt = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });
  expect(receipt).toMatchObject({ outcome: "recovered", resultEventId: value.completed().id });
  expect(value.ensureWorkspace).not.toHaveBeenCalled();
  expect(value.agentProviderFactory).not.toHaveBeenCalled();
  expect(value.runProvider).not.toHaveBeenCalled();
});

test("recovered retryable results carry only a recomputed identifier-only next request", async () => {
  const value = fixture();
  const event = value.failed();
  writeFactoryActionResult(
    join(value.runDir, "actions/1/triageWorkItem", value.operation.actionKey),
    event,
  );
  const receipt = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });
  expect(receipt).toEqual({
    version: 1,
    ...value.request,
    outcome: "recovered",
    resultEventId: event.id,
    next: {
      projectId: value.projectId,
      workItemKey: value.workItemKey,
      operation: createFactoryOperationRef({
        phaseRunId: value.phaseRunId,
        handler: "triageWorkItem",
        attempt: 1,
        causationEventId: event.id,
      }),
    },
  });
  const next = "next" in receipt ? receipt.next : undefined;
  expect(Object.keys(next!)).toEqual(["projectId", "workItemKey", "operation"]);
  expectNoProviderOrGroveCalls(value);
});

test("returns stale receipts without Grove or provider work", async () => {
  const staleValue = fixture();
  const staleOperation = createFactoryOperationRef({
    ...staleValue.operation,
    causationEventId: "older-request",
  });
  const stale = await runHostedFactoryOperation({
    request: { ...staleValue.request, operation: staleOperation },
    runtime: staleValue.runtime,
  });
  expect(stale).toEqual({
    version: 1,
    projectId: staleValue.projectId,
    workItemKey: staleValue.workItemKey,
    operation: staleOperation,
    outcome: "stale",
    observedEventId: staleValue.requested.id,
  });
  expect("next" in stale).toBe(false);
  expectNoProviderOrGroveCalls(staleValue);

  const waitingValue = fixture();
  const terminal = waitingValue.completed();
  appendFactoryActionEvent({
    factoryStateRoot: waitingValue.factoryStateRoot,
    event: terminal,
    expectedLastEventId: waitingValue.requested.id,
  });
  rmSync(waitingValue.runDir, { recursive: true });
  const waiting = await runHostedFactoryOperation({
    request: waitingValue.request,
    runtime: waitingValue.runtime,
  });
  expect(waiting).toEqual({
    version: 1,
    ...waitingValue.request,
    outcome: "stale",
    observedEventId: terminal.id,
  });
  expect("next" in waiting).toBe(false);
  expectNoProviderOrGroveCalls(waitingValue);
});

test.each([
  ["project", (value: ReturnType<typeof fixture>) => ({ ...value.request, projectId: "other" })],
  [
    "work item",
    (value: ReturnType<typeof fixture>) => ({ ...value.request, workItemKey: "linear:OTHER" }),
  ],
  [
    "action key",
    (value: ReturnType<typeof fixture>) => ({
      ...value.request,
      operation: { ...value.operation, actionKey: "f".repeat(64) },
    }),
  ],
])("rejects divergent %s identity before Grove or provider work", async (_name, requestFor) => {
  const value = fixture();
  await expect(
    runHostedFactoryOperation({ request: requestFor(value), runtime: value.runtime }),
  ).rejects.toThrow(/identity|runtime/i);
  expectNoProviderOrGroveCalls(value);
});

test("rejects divergent completed-result identity before Grove or provider work", async () => {
  const value = fixture();
  const actionDir = join(value.runDir, "actions/1/triageWorkItem", value.operation.actionKey);
  writeFactoryActionResult(actionDir, value.completed());
  const persisted = JSON.parse(readFileSync(join(actionDir, "action-result.json"), "utf8"));
  writeFileSync(
    join(actionDir, "action-result.json"),
    `${JSON.stringify({ ...persisted, workItemKey: "linear:OTHER" })}\n`,
  );
  await expect(
    runHostedFactoryOperation({ request: value.request, runtime: value.runtime }),
  ).rejects.toThrow(/result identity mismatch/);
  expectNoProviderOrGroveCalls(value);
});

test("rejects a completed result with a wrong event-ID prefix before append or Grove", async () => {
  const value = fixture();
  const actionDir = join(value.runDir, "actions/1/triageWorkItem", value.operation.actionKey);
  const event = value.completed();
  writeFactoryActionResult(actionDir, event);
  writeFileSync(
    join(actionDir, "action-result.json"),
    `${JSON.stringify({ ...event, id: `unrelated:${value.operation.actionKey}` })}\n`,
  );

  await expect(
    runHostedFactoryOperation({ request: value.request, runtime: value.runtime }),
  ).rejects.toThrow(/result|identity/i);
  expect(readFactoryActionEvents(value.factoryStateRoot, value.workItemKey)).toHaveLength(2);
  expectNoProviderOrGroveCalls(value);
});

test.each([
  ["minimal", () => ({ message: "retry", failureKind: "retryable" })],
  [
    "mismatched",
    (meta: Record<string, unknown>) => ({
      ...meta,
      agent: { name: "cursor", model: "wrong-model" },
    }),
  ],
])("rejects %s triage failure metadata before append or Grove", async (_name, mutate) => {
  const value = fixture();
  const actionDir = join(value.runDir, "actions/1/triageWorkItem", value.operation.actionKey);
  const event = value.failed();
  const failurePath = join(
    value.runtime.factoryStore.projectRoot,
    event.data.execution.runRef.path,
  );
  const meta = JSON.parse(readFileSync(failurePath, "utf8")) as Record<string, unknown>;
  writeFileSync(failurePath, JSON.stringify(mutate(meta)));
  const failure = createFactoryArtifactRef({
    base: "factory-store",
    root: value.runtime.factoryStore.projectRoot,
    path: event.data.execution.runRef.path,
  });
  writeFactoryActionResult(actionDir, {
    ...event,
    data: {
      ...event.data,
      execution: { ...event.data.execution, runRef: failure },
      evidence: [failure],
    },
  });

  await expect(
    runHostedFactoryOperation({ request: value.request, runtime: value.runtime }),
  ).rejects.toThrow(/result|evidence|metadata/i);
  expect(readFactoryActionEvents(value.factoryStateRoot, value.workItemKey)).toHaveLength(2);
  expectNoProviderOrGroveCalls(value);
});

test.each([
  [
    "workspace identity",
    (event: ReturnType<ReturnType<typeof fixture>["completed"]>) => ({
      ...event,
      data: { ...event.data, execution: { ...event.data.execution, workspaceRef: "other" } },
    }),
  ],
  [
    "evidence hash",
    (event: ReturnType<ReturnType<typeof fixture>["completed"]>) => ({
      ...event,
      data: {
        ...event.data,
        evidence: [event.data.evidence[0]!, { ...event.data.evidence[1]!, sha256: "f".repeat(64) }],
      },
    }),
  ],
  [
    "required evidence",
    (event: ReturnType<ReturnType<typeof fixture>["completed"]>) => ({
      ...event,
      data: { ...event.data, evidence: [event.data.evidence[0]!] },
    }),
  ],
  [
    "handler",
    (event: ReturnType<ReturnType<typeof fixture>["completed"]>) => ({
      ...event,
      data: { ...event.data, handler: "producePlanCandidate" },
    }),
  ],
])(
  "rejects completed results with invalid %s evidence before append or Grove",
  async (_name, mutate) => {
    const value = fixture();
    const resultDir = join(value.runDir, "actions/1/triageWorkItem", value.operation.actionKey);
    const event = value.completed();
    writeFactoryActionResult(resultDir, event);
    writeFileSync(join(resultDir, "action-result.json"), `${JSON.stringify(mutate(event))}\n`);

    await expect(
      runHostedFactoryOperation({ request: value.request, runtime: value.runtime }),
    ).rejects.toThrow(/result|evidence|identity/i);
    expect(readFactoryActionEvents(value.factoryStateRoot, value.workItemKey)).toHaveLength(2);
    expectNoProviderOrGroveCalls(value);
  },
);

test.each([
  [
    "version-1 identity",
    (identity: Record<string, unknown>) => ({ ...identity, version: 1, git: undefined }),
  ],
  [
    "missing Git authority",
    (identity: Record<string, unknown>) => ({ ...identity, git: undefined }),
  ],
  [
    "repository mismatch",
    (identity: Record<string, unknown>) => ({
      ...identity,
      git: { ...(identity.git as Record<string, unknown>), repositoryId: "other-repository" },
    }),
  ],
  [
    "base mismatch",
    (identity: Record<string, unknown>) => ({
      ...identity,
      git: { ...(identity.git as Record<string, unknown>), baseSha: "f".repeat(40) },
    }),
  ],
  [
    "target mismatch",
    (identity: Record<string, unknown>) => ({
      ...identity,
      git: {
        ...(identity.git as Record<string, unknown>),
        target: { mode: "branch", branchRef: "refs/heads/wrong" },
      },
    }),
  ],
])("rejects %s before Grove or provider work", async (_name, mutate) => {
  const value = fixture();
  const path = join(value.runDir, "context/phase-run.json");
  const identity = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify(mutate(identity), null, 2)}\n`);
  await expect(
    runHostedFactoryOperation({ request: value.request, runtime: value.runtime }),
  ).rejects.toThrow();
  expectNoProviderOrGroveCalls(value);
});

test.each(["lease", "intent", "workspace"])(
  "rejects a divergent returned %s without provider work",
  async (field) => {
    const value = fixture();
    value.ensureWorkspace.mockImplementationOnce(async ({ intent }) => ({
      leaseId: field === "lease" ? "wrong-lease" : intent.leaseId,
      workspace: field === "workspace" ? value.runDir : value.workspace,
      intent: field === "intent" ? { ...intent, phaseGeneration: "wrong-generation" } : intent,
    }));
    await expect(
      runHostedFactoryOperation({ request: value.request, runtime: value.runtime }),
    ).rejects.toThrow(/Grove|workspace|lease/i);
    expect(value.ensureWorkspace).toHaveBeenCalledOnce();
    expect(value.agentProviderFactory).not.toHaveBeenCalled();
    expect(value.runProvider).not.toHaveBeenCalled();
  },
);

test.each(["base", "target"])(
  "rejects a returned workspace with divergent %s identity without provider work",
  async (field) => {
    const value = fixture();
    if (field === "base") {
      writeFileSync(join(value.workspace, "divergent.txt"), "divergent\n");
      git(value.workspace, ["add", "divergent.txt"]);
      git(value.workspace, ["commit", "-m", "divergent"]);
    } else {
      git(value.workspace, ["switch", "-c", "wrong-target"]);
    }
    await expect(
      runHostedFactoryOperation({ request: value.request, runtime: value.runtime }),
    ).rejects.toThrow(/workspace|identity/i);
    expect(value.ensureWorkspace).toHaveBeenCalledOnce();
    expect(value.agentProviderFactory).not.toHaveBeenCalled();
    expect(value.runProvider).not.toHaveBeenCalled();
  },
);

test("a lifecycle change during acquisition prevents provider work", async () => {
  const value = fixture();
  value.ensureWorkspace.mockImplementationOnce(async ({ intent }) => {
    appendFactoryActionEvent({
      factoryStateRoot: value.factoryStateRoot,
      event: value.completed(),
      expectedLastEventId: value.request.operation.causationEventId,
    });
    return { leaseId: intent.leaseId, workspace: value.runtime.grove.controllerRepository, intent };
  });
  const receipt = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });
  expect(receipt).toMatchObject({ outcome: "stale" });
  expect(value.agentProviderFactory).not.toHaveBeenCalled();
  expect(value.runProvider).not.toHaveBeenCalled();
});

test("a stale lifecycle change during acquisition prevents provider work", async () => {
  const value = fixture();
  value.ensureWorkspace.mockImplementationOnce(async ({ intent }) => {
    const terminal = value.completed();
    appendFactoryActionEvent({
      factoryStateRoot: value.factoryStateRoot,
      event: terminal,
      expectedLastEventId: value.requested.id,
    });
    appendFactoryActionEvent({
      factoryStateRoot: value.factoryStateRoot,
      event: {
        version: 1,
        id: "planning-requested",
        type: "planning.requested",
        workItemKey: value.workItemKey,
        occurredAt: "2026-07-15T00:03:00.000Z",
        phaseRunId: "planning-run",
        data: {
          expectedPredecessor: terminal.id,
          inputRefs: [value.inputRef],
          intent: "start",
          publicationMode: "local",
          outputPlan: "dev/plans/item.md",
        },
      },
      expectedLastEventId: terminal.id,
    });
    return { leaseId: intent.leaseId, workspace: value.workspace, intent };
  });
  const receipt = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });
  expect(receipt).toEqual({
    version: 1,
    ...value.request,
    outcome: "stale",
    observedEventId: "planning-requested",
  });
  expect(value.agentProviderFactory).not.toHaveBeenCalled();
  expect(value.runProvider).not.toHaveBeenCalled();
});

function planningFixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-hosted-planning-"));
  registerHostedFixtureRoot(root);
  const workspace = join(root, "repository");
  mkdirSync(workspace);
  git(workspace, ["init", "--initial-branch=main"]);
  git(workspace, ["config", "user.name", "Factory Test"]);
  git(workspace, ["config", "user.email", "factory@example.test"]);
  git(workspace, ["remote", "add", "origin", "https://example.test/repo.git"]);
  writeFileSync(join(workspace, "README.md"), "fixture\n");
  git(workspace, ["add", "README.md"]);
  git(workspace, ["commit", "-m", "fixture"]);
  const baseSha = git(workspace, ["rev-parse", "HEAD"]);
  const repositoryId = deriveFactoryRepoIdentity(workspace).id;
  const projectId = "planning-project";
  const workItemKey = "linear:PLAN-1";
  const phaseRunId = "planning-run";
  const projectRoot = join(root, "store", "projects", projectId);
  const factoryStateRoot = join(projectRoot, "factory");
  const runDir = join(projectRoot, "runs", "factory", phaseRunId);
  mkdirSync(join(runDir, "context"), { recursive: true });
  const workItem = {
    id: workItemKey,
    source: "linear" as const,
    title: "Hosted planning",
    body: "Plan it",
    labels: [],
  };
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(workItem));
  const inputRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: `runs/factory/${phaseRunId}/context/work-item.json`,
  });
  const imported: FactoryLifecycleEvent = {
    version: 1,
    id: "planning-imported",
    type: "work_item.imported",
    workItemKey,
    occurredAt: "2026-07-15T00:00:00.000Z",
    data: { source: "linear" },
  };
  const intent = deriveFactoryGroveWorkspaceIntent({
    controllerRepository: workspace,
    workItemKey,
    phase: "planning",
    phaseGeneration: imported.id,
    baseSha,
  });
  if (intent.target.mode !== "branch") throw new Error("planning must use a branch");
  git(workspace, ["switch", "-c", intent.target.branch]);
  const branchRef = `refs/heads/${intent.target.branch}`;
  writeFactoryPhaseRunIdentity(runDir, {
    version: 2,
    phaseRunId,
    phase: "planning",
    workItemKey,
    workspace,
    projectId,
    factoryStateRoot,
    git: { repositoryId, baseSha, target: { mode: "branch", branchRef } },
    publicationMode: "local",
    outputPlan: "dev/plans/plan-1.md",
    actions: {
      producePlanCandidate: { provider: "cursor", model: "planner" },
      reviewPlanCandidate: { provider: "cursor", model: "reviewer" },
    },
  });
  const requested: FactoryLifecycleEvent = {
    version: 1,
    id: "planning-requested",
    type: "planning.requested",
    workItemKey,
    occurredAt: "2026-07-15T00:01:00.000Z",
    phaseRunId,
    data: {
      expectedPredecessor: imported.id,
      inputRefs: [inputRef],
      intent: "start",
      publicationMode: "local",
      outputPlan: "dev/plans/plan-1.md",
    },
  };
  appendFactoryActionEvent({ factoryStateRoot, event: imported, expectedLastEventId: null });
  appendFactoryActionEvent({
    factoryStateRoot,
    event: requested,
    expectedLastEventId: imported.id,
  });
  const operation = createFactoryOperationRef({
    phaseRunId,
    handler: "producePlanCandidate",
    attempt: 1,
    causationEventId: requested.id,
  });
  const factoryStore = {
    storeRoot: join(root, "store"),
    projectId,
    projectRoot,
    factoryStateRoot,
    factoryRunsDir: join(projectRoot, "runs/factory"),
    reviewRunsDir: join(projectRoot, "runs/reviews"),
    repo: { name: "repo", id: projectId, idSource: "config" as const },
    overrides: {},
    warnings: [],
  };
  const ensureWorkspace = vi.fn(async ({ intent: requestedIntent }) => ({
    leaseId: requestedIntent.leaseId,
    workspace,
    intent: requestedIntent,
  }));
  const providerRun = vi.fn<Agent["run"]>(async (input) => {
    const draftPath = /Draft path:\s+```text\s+([^\n]+)/.exec(input.prompt)?.[1];
    if (!draftPath) throw new Error("missing draft path");
    writeFileSync(draftPath, "# Hosted plan\n");
    return {
      ok: true,
      structuredOutput: {
        outcome: "draft-ready",
        summary: "ready",
        humanQuestions: [],
        findingDecisions: [],
      },
      raw: { workspaceStatus: { before: "clean", after: "clean" } },
      session: { provider: "cursor", id: "planning-session" },
    };
  });
  return {
    request: { projectId, workItemKey, operation },
    runtime: {
      projectId,
      repositoryId,
      factoryStore,
      grove: {
        controllerRepository: workspace,
        poolDirectory: join(root, "pool"),
        poolCapacity: 1,
        setupCommand: "true",
      },
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor" as const, run: providerRun }),
      ensureWorkspace,
    },
    ensureWorkspace,
    providerRun,
    workspace,
    branchRef,
    runDir,
  };
}
