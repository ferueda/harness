import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Agent } from "./agents.ts";
import { factoryActionKey } from "./factory-action-contract.ts";
import { createFactoryArtifactRef } from "./factory-artifact-ref.ts";
import {
  recordHostedFactoryContinuation,
  requestHostedFactoryPhase,
  type HostedFactoryAuthorityRuntime,
} from "./factory-hosted-authority.ts";
import { readFactoryActionEvents, appendFactoryActionEvent } from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { reconcileFactoryOperations } from "./factory-operation-reconciliation.ts";
import { ensureFactoryStoreFormat } from "./factory-store-format.ts";
import { deriveFactoryRepoIdentity, type FactoryStoreMeta } from "./factory-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("persists phase authority before delivering the identifier-only operation", async () => {
  const value = authorityFixture();
  const delivered = vi.fn(async (request) => {
    const events = readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id);
    expect(events.at(-1)).toMatchObject({ type: "triage.requested" });
    expect(Object.keys(request)).toEqual(["projectId", "workItemKey", "operation"]);
  });
  value.runtime.deliver = delivered;

  const result = await requestHostedFactoryPhase({
    request: phaseRequest(value, "triage"),
    runtime: value.runtime,
  });

  expect(result).toMatchObject({ outcome: "delivered", workItemKey: value.workItem.id });
  expect(delivered).toHaveBeenCalledOnce();
  expect(value.ensureWorkspace).toHaveBeenCalledOnce();
  const events = readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id);
  expect(events.map((event) => event.type)).toEqual(["work_item.imported", "triage.requested"]);
  const request = events[1];
  expect(request?.type).toBe("triage.requested");
  if (request?.type !== "triage.requested") throw new Error("missing triage request");
  const identity = JSON.parse(
    readFileSync(
      join(value.store.factoryRunsDir, request.phaseRunId, "context/phase-run.json"),
      "utf8",
    ),
  );
  expect(identity.git).toMatchObject({
    repositoryId: value.repositoryId,
    baseSha: value.baseSha,
    target: { mode: "detached" },
  });
  expect(request.data.expectedPredecessor).toBe(events[0]?.id);
});

test("exact duplicate phase requests reuse authority and stale requests fail before Grove", async () => {
  const value = authorityFixture();
  const request = phaseRequest(value, "triage");
  await requestHostedFactoryPhase({ request, runtime: value.runtime });
  await requestHostedFactoryPhase({ request, runtime: value.runtime });

  expect(value.ensureWorkspace).toHaveBeenCalledOnce();
  expect(value.runtime.deliver).toHaveBeenCalledTimes(2);
  expect(readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id)).toHaveLength(2);

  await expect(
    requestHostedFactoryPhase({
      request: { ...request, expectedPredecessor: "stale-observation" },
      runtime: value.runtime,
    }),
  ).rejects.toThrow(/lost the durable CAS/);
  expect(value.ensureWorkspace).toHaveBeenCalledOnce();
  expect(value.runtime.deliver).toHaveBeenCalledTimes(2);
});

test("delivery failure leaves phase truth recoverable without duplicate authority", async () => {
  const value = authorityFixture();
  const lost = vi.fn(async (_request: unknown) => {
    throw new Error("delivery unavailable");
  });
  value.runtime.deliver = lost;
  const first = await requestHostedFactoryPhase({
    request: phaseRequest(value, "triage"),
    runtime: value.runtime,
  });
  expect(first).toMatchObject({ outcome: "attention", reason: "delivery unavailable" });
  expect(readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id)).toHaveLength(2);

  const recovered = vi.fn(async () => undefined);
  const results = await reconcileFactoryOperations(
    [
      {
        projectId: value.store.projectId,
        workItemKey: value.workItem.id,
        factoryStore: value.store,
      },
    ],
    recovered,
  );
  expect(results[0]).toMatchObject({ outcome: "delivered" });
  expect(recovered).toHaveBeenCalledWith(lost.mock.calls[0]?.[0]);
  expect(readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id)).toHaveLength(2);
});

test("baseline mismatch prevents phase request append and delivery", async () => {
  const value = authorityFixture();
  value.ensureWorkspace.mockImplementationOnce(async ({ intent }) => {
    checkoutIntent(value.repository, intent);
    writeFileSync(join(value.repository, "README.md"), "changed\n");
    git(value.repository, ["add", "README.md"]);
    git(value.repository, ["commit", "-m", "move head"]);
    return { leaseId: intent.leaseId, workspace: value.repository, intent };
  });

  await expect(
    requestHostedFactoryPhase({
      request: phaseRequest(value, "triage"),
      runtime: value.runtime,
    }),
  ).rejects.toThrow(/divergent Factory workspace/);
  expect(value.runtime.deliver).not.toHaveBeenCalled();
  expect(readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id)).toHaveLength(1);
});

test("state change during Grove acquisition loses the final compare-and-append", async () => {
  const value = authorityFixture();
  value.ensureWorkspace.mockImplementationOnce(async ({ intent }) => {
    checkoutIntent(value.repository, intent);
    const evidencePath = join(value.store.projectRoot, "race-work-item.json");
    mkdirSync(value.store.projectRoot, { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(value.workItem)}\n`);
    const inputRef = createFactoryArtifactRef({
      base: "factory-store",
      root: value.store.projectRoot,
      path: relative(value.store.projectRoot, evidencePath),
    });
    const imported = readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id)[0];
    if (!imported) throw new Error("missing imported event");
    appendFactoryActionEvent({
      factoryStateRoot: value.store.factoryStateRoot,
      expectedLastEventId: imported.id,
      event: {
        version: 1,
        id: "triage.requested:race-run",
        type: "triage.requested",
        workItemKey: value.workItem.id,
        occurredAt: new Date().toISOString(),
        phaseRunId: "race-run",
        data: {
          expectedPredecessor: imported.id,
          intent: "start",
          inputRefs: [inputRef],
        },
      },
    });
    return { leaseId: intent.leaseId, workspace: value.repository, intent };
  });

  await expect(
    requestHostedFactoryPhase({
      request: phaseRequest(value, "triage"),
      runtime: value.runtime,
    }),
  ).rejects.toThrow(/Stale Factory cursor/);
  expect(value.runtime.deliver).not.toHaveBeenCalled();
  expect(
    readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id).filter(
      (event) => event.type === "triage.requested",
    ),
  ).toHaveLength(1);
});

test("continuation binds exact candidate identity before durable delivery and converges", async () => {
  const value = authorityFixture();
  await requestHostedFactoryPhase({
    request: phaseRequest(value, "planning"),
    runtime: value.runtime,
  });
  const events = readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id);
  const requested = events.at(-1);
  if (requested?.type !== "planning.requested") throw new Error("missing planning request");
  const candidate = appendPlanningCandidate(value, requested);
  const continuationRequest = {
    projectId: value.store.projectId,
    workItemKey: value.workItem.id,
    phase: "planning" as const,
    decision: "revise" as const,
    response: "Apply the accepted findings.",
    expectedPredecessor: candidate.id,
    phaseRunId: requested.phaseRunId,
    candidateEventId: candidate.id,
  };
  const deliveredBefore = vi.mocked(value.runtime.deliver).mock.calls.length;

  const first = await recordHostedFactoryContinuation({
    request: continuationRequest,
    runtime: value.runtime,
  });
  const second = await recordHostedFactoryContinuation({
    request: continuationRequest,
    runtime: value.runtime,
  });

  expect(first).toMatchObject({ outcome: "delivered" });
  expect(second).toMatchObject({ outcome: "delivered" });
  const durable = readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id);
  expect(durable.filter((event) => event.type === "factory.continuation.recorded")).toHaveLength(1);
  expect(value.runtime.deliver).toHaveBeenCalledTimes(deliveredBefore + 2);

  await expect(
    recordHostedFactoryContinuation({
      request: { ...continuationRequest, candidateEventId: "wrong-candidate" },
      runtime: value.runtime,
    }),
  ).rejects.toThrow(/stale|candidate|durable/i);
});

test("fresh continuation rejects a phase run bound to another Factory store", async () => {
  const value = authorityFixture();
  const continuationRequest = await planningContinuationRequest(value);
  rewritePhaseStateRoot(value, continuationRequest.phaseRunId, join(value.root, "other-factory"));
  const deliveredBefore = vi.mocked(value.runtime.deliver).mock.calls.length;

  await expect(
    recordHostedFactoryContinuation({ request: continuationRequest, runtime: value.runtime }),
  ).rejects.toThrow(/phase-run identity/);
  expect(
    readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id).filter(
      (event) => event.type === "factory.continuation.recorded",
    ),
  ).toHaveLength(0);
  expect(value.runtime.deliver).toHaveBeenCalledTimes(deliveredBefore);
});

test("exact duplicate continuation revalidates the Factory store binding", async () => {
  const value = authorityFixture();
  const continuationRequest = await planningContinuationRequest(value);
  await recordHostedFactoryContinuation({ request: continuationRequest, runtime: value.runtime });
  rewritePhaseStateRoot(value, continuationRequest.phaseRunId, join(value.root, "other-factory"));
  const deliveredBefore = vi.mocked(value.runtime.deliver).mock.calls.length;

  await expect(
    recordHostedFactoryContinuation({ request: continuationRequest, runtime: value.runtime }),
  ).rejects.toThrow(/phase-run identity/);
  expect(
    readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id).filter(
      (event) => event.type === "factory.continuation.recorded",
    ),
  ).toHaveLength(1);
  expect(value.runtime.deliver).toHaveBeenCalledTimes(deliveredBefore);
});

test("hosted triage restart creates a new phase run after a routed result", async () => {
  const value = authorityFixture();
  await requestHostedFactoryPhase({
    request: phaseRequest(value, "triage"),
    runtime: value.runtime,
  });
  const first = latestRequest(value, "triage.requested");
  const routed = appendTriageCompletion(value, first, "ready-to-plan");

  await requestHostedFactoryPhase({
    request: {
      ...phaseRequest(value, "triage"),
      intent: "restart",
      expectedPredecessor: routed.id,
    },
    runtime: value.runtime,
  });

  const requests = phaseRequests(value, "triage.requested");
  expect(requests).toHaveLength(2);
  expect(requests.map((event) => event.data.intent)).toEqual(["start", "restart"]);
  expect(requests[1]?.phaseRunId).not.toBe(requests[0]?.phaseRunId);
});

test("hosted planning restart is allowed from needs-human", async () => {
  const value = authorityFixture();
  await requestHostedFactoryPhase({
    request: phaseRequest(value, "planning"),
    runtime: value.runtime,
  });
  const first = latestRequest(value, "planning.requested");
  const needsHuman = appendPlanningInputRequired(value, first);

  await requestHostedFactoryPhase({
    request: {
      ...phaseRequest(value, "planning"),
      intent: "restart",
      expectedPredecessor: needsHuman.id,
    },
    runtime: value.runtime,
  });

  const requests = phaseRequests(value, "planning.requested");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ data: { intent: "restart" } });
  expect(requests[1]?.phaseRunId).not.toBe(requests[0]?.phaseRunId);
});

test("hosted implementation creates authority and converges a pending valid restart", async () => {
  const value = authorityFixture();
  const ready = seedDirectImplementation(value);
  const startRequest = implementationRequest(value, "start", ready.id);
  await requestHostedFactoryPhase({ request: startRequest, runtime: value.runtime });
  const first = latestRequest(value, "implementation.requested");
  const failed = appendActionFailure(value, first, "produceImplementationCandidate", "terminal");
  const restartRequest = implementationRequest(value, "restart", failed.id);

  await requestHostedFactoryPhase({ request: restartRequest, runtime: value.runtime });
  await requestHostedFactoryPhase({ request: restartRequest, runtime: value.runtime });

  const requests = phaseRequests(value, "implementation.requested");
  expect(requests).toHaveLength(2);
  expect(requests.map((event) => event.data.intent)).toEqual(["start", "restart"]);
  expect(requests[1]?.phaseRunId).not.toBe(requests[0]?.phaseRunId);
  expect(value.ensureWorkspace).toHaveBeenCalledTimes(2);
  expect(value.runtime.deliver).toHaveBeenCalledTimes(3);
});

test("invalid hosted restart fails before Grove acquisition or delivery", async () => {
  const value = authorityFixture();

  await expect(
    requestHostedFactoryPhase({
      request: { ...phaseRequest(value, "triage"), intent: "restart" },
      runtime: value.runtime,
    }),
  ).rejects.toThrow(/Invalid Factory transition/);
  expect(value.ensureWorkspace).not.toHaveBeenCalled();
  expect(value.runtime.deliver).not.toHaveBeenCalled();
});

test("implementation restart with a reusable candidate fails before Grove or delivery", async () => {
  const value = authorityFixture();
  const ready = seedDirectImplementation(value);
  await requestHostedFactoryPhase({
    request: implementationRequest(value, "start", ready.id),
    runtime: value.runtime,
  });
  const first = latestRequest(value, "implementation.requested");
  const candidate = appendImplementationCandidate(value, first);
  vi.mocked(value.ensureWorkspace).mockClear();
  vi.mocked(value.runtime.deliver).mockClear();

  await expect(
    requestHostedFactoryPhase({
      request: implementationRequest(value, "restart", candidate.id),
      runtime: value.runtime,
    }),
  ).rejects.toThrow(/failure without a reusable candidate/);
  expect(value.ensureWorkspace).not.toHaveBeenCalled();
  expect(value.runtime.deliver).not.toHaveBeenCalled();
});

function authorityFixture(): {
  root: string;
  repository: string;
  baseSha: string;
  repositoryId: string;
  store: FactoryStoreMeta;
  workItem: { id: string; source: "manual"; title: string; body: string; labels: string[] };
  ensureWorkspace: ReturnType<typeof vi.fn>;
  runtime: HostedFactoryAuthorityRuntime & { deliver: ReturnType<typeof vi.fn> };
} {
  const root = mkdtempSync(join(tmpdir(), "factory-hosted-authority-"));
  roots.push(root);
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Factory Test"]);
  git(repository, ["config", "user.email", "factory@example.test"]);
  writeFileSync(join(repository, "README.md"), "base\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "base"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  const repositoryId = deriveFactoryRepoIdentity(repository).id;
  const projectId = "authority-project";
  const projectRoot = join(root, "store/projects", projectId);
  const store: FactoryStoreMeta = {
    storeRoot: join(root, "store"),
    projectId,
    projectRoot,
    factoryStateRoot: join(projectRoot, "factory"),
    factoryRunsDir: join(projectRoot, "runs/factory"),
    reviewRunsDir: join(projectRoot, "runs/reviews"),
    repo: { name: "repository", id: projectId, idSource: "config" },
    overrides: {},
    warnings: [],
  };
  ensureFactoryStoreFormat(store.factoryStateRoot);
  const workItem = {
    id: "manual:AUTH-1",
    source: "manual" as const,
    title: "Hosted authority",
    body: "Exercise the boundary",
    labels: [],
  };
  const ensureWorkspace = vi.fn(async ({ intent }) => {
    checkoutIntent(repository, intent);
    return { leaseId: intent.leaseId, workspace: repository, intent };
  });
  const deliver = vi.fn(async () => undefined);
  const providerFactory = () => ({ name: "cursor" as const, run: vi.fn<Agent["run"]>() });
  const runtime = {
    projectId,
    repositoryId,
    factoryStore: store,
    grove: {
      controllerRepository: repository,
      poolDirectory: join(root, "pool"),
      poolCapacity: 1,
      setupCommand: "true",
    },
    baseRef: "main",
    deliver,
    ensureWorkspace,
    triage: {
      executionProfile: { provider: "cursor" as const, model: "triager" },
      maxRuntimeMs: 1000,
      agentProviderFactory: providerFactory,
    },
    planning: {
      plannerRole: { agent: "cursor" as const, model: "planner" },
      reviewerRole: { agent: "cursor" as const, model: "reviewer" },
      maxRuntimeMs: 1000,
      agentProviderFactory: providerFactory,
      publicationMode: "local" as const,
      outputPlan: "dev/plans/authority.md",
    },
    implementation: {
      implementerRole: { agent: "cursor" as const, model: "implementer" },
      reviewerRole: { agent: "cursor" as const, model: "reviewer" },
    },
  };
  return { root, repository, baseSha, repositoryId, store, workItem, ensureWorkspace, runtime };
}

function phaseRequest(value: ReturnType<typeof authorityFixture>, phase: "triage" | "planning") {
  return {
    projectId: value.store.projectId,
    workItem: value.workItem,
    phase,
    intent: "start" as const,
    expectedPredecessor: null,
  };
}

function implementationRequest(
  value: ReturnType<typeof authorityFixture>,
  intent: "start" | "restart",
  expectedPredecessor: string,
) {
  return {
    projectId: value.store.projectId,
    workItem: value.workItem,
    phase: "implementation" as const,
    intent,
    expectedPredecessor,
  };
}

function checkoutIntent(
  repository: string,
  intent: Parameters<NonNullable<HostedFactoryAuthorityRuntime["ensureWorkspace"]>>[0]["intent"],
): void {
  if (intent.target.mode === "detached") {
    git(repository, ["checkout", "--detach", intent.baseSha]);
    return;
  }
  git(repository, ["checkout", "-B", intent.target.branch, intent.baseSha]);
}

function appendPlanningCandidate(
  value: ReturnType<typeof authorityFixture>,
  requested: Extract<FactoryLifecycleEvent, { type: "planning.requested" }>,
): Extract<FactoryLifecycleEvent, { type: "planning.candidate.produced" }> {
  const actionKey = factoryActionKey({
    phaseRunId: requested.phaseRunId,
    handler: "producePlanCandidate",
    attempt: 1,
    causationEventId: requested.id,
  });
  const actionDir = join(
    value.store.factoryRunsDir,
    requested.phaseRunId,
    "actions/1/producePlanCandidate",
    actionKey,
  );
  mkdirSync(join(actionDir, "evidence"), { recursive: true });
  writeFileSync(join(actionDir, "candidate.md"), "# Candidate\n");
  writeFileSync(join(actionDir, "evidence/summary.md"), "Produced\n");
  const ref = (path: string) =>
    createFactoryArtifactRef({
      base: "factory-store",
      root: value.store.projectRoot,
      path: relative(value.store.projectRoot, join(actionDir, path)),
    });
  const event: Extract<FactoryLifecycleEvent, { type: "planning.candidate.produced" }> = {
    version: 1,
    id: `planning.candidate.produced:${actionKey}`,
    type: "planning.candidate.produced",
    workItemKey: value.workItem.id,
    occurredAt: new Date().toISOString(),
    phaseRunId: requested.phaseRunId,
    data: {
      handler: "producePlanCandidate",
      handlerVersion: 1,
      attempt: 1,
      causationEventId: requested.id,
      execution: { workspaceRef: value.store.repo.id, runRef: ref("evidence/summary.md") },
      evidence: [ref("evidence/summary.md")],
      candidate: ref("candidate.md"),
      effectiveSession: { provider: "cursor", id: "session-1" },
    },
  };
  appendFactoryActionEvent({
    factoryStateRoot: value.store.factoryStateRoot,
    event,
    expectedLastEventId: requested.id,
  });
  return event;
}

async function planningContinuationRequest(value: ReturnType<typeof authorityFixture>) {
  await requestHostedFactoryPhase({
    request: phaseRequest(value, "planning"),
    runtime: value.runtime,
  });
  const requested = latestRequest(value, "planning.requested");
  const candidate = appendPlanningCandidate(value, requested);
  return {
    projectId: value.store.projectId,
    workItemKey: value.workItem.id,
    phase: "planning" as const,
    decision: "revise" as const,
    response: "Apply the accepted findings.",
    expectedPredecessor: candidate.id,
    phaseRunId: requested.phaseRunId,
    candidateEventId: candidate.id,
  };
}

function rewritePhaseStateRoot(
  value: ReturnType<typeof authorityFixture>,
  phaseRunId: string,
  factoryStateRoot: string,
): void {
  const path = join(value.store.factoryRunsDir, phaseRunId, "context/phase-run.json");
  const identity = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify({ ...identity, factoryStateRoot }, null, 2)}\n`);
}

type PhaseRequestEvent = Extract<
  FactoryLifecycleEvent,
  { type: "triage.requested" | "planning.requested" | "implementation.requested" }
>;

function phaseRequests(
  value: ReturnType<typeof authorityFixture>,
  type: PhaseRequestEvent["type"],
): PhaseRequestEvent[] {
  return readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id).filter(
    (event): event is PhaseRequestEvent => event.type === type,
  );
}

function latestRequest(
  value: ReturnType<typeof authorityFixture>,
  type: "triage.requested",
): Extract<FactoryLifecycleEvent, { type: "triage.requested" }>;
function latestRequest(
  value: ReturnType<typeof authorityFixture>,
  type: "planning.requested",
): Extract<FactoryLifecycleEvent, { type: "planning.requested" }>;
function latestRequest(
  value: ReturnType<typeof authorityFixture>,
  type: "implementation.requested",
): Extract<FactoryLifecycleEvent, { type: "implementation.requested" }>;
function latestRequest(
  value: ReturnType<typeof authorityFixture>,
  type: PhaseRequestEvent["type"],
): PhaseRequestEvent {
  const request = readFactoryActionEvents(value.store.factoryStateRoot, value.workItem.id).findLast(
    (event): event is PhaseRequestEvent => event.type === type,
  );
  if (!request) throw new Error(`missing ${type}`);
  return request;
}

function appendTriageCompletion(
  value: ReturnType<typeof authorityFixture>,
  requested: Extract<FactoryLifecycleEvent, { type: "triage.requested" }>,
  route: "ready-to-plan" | "ready-to-implement",
): Extract<FactoryLifecycleEvent, { type: "triage.work_item.completed" }> {
  const actionKey = factoryActionKey({
    phaseRunId: requested.phaseRunId,
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: requested.id,
  });
  const ref = writeActionArtifact(value, requested.phaseRunId, "triageWorkItem", actionKey, {
    name: "readiness.json",
    content: `${JSON.stringify({ route })}\n`,
  });
  const event: Extract<FactoryLifecycleEvent, { type: "triage.work_item.completed" }> = {
    version: 1,
    id: `triage.work_item.completed:${actionKey}`,
    type: "triage.work_item.completed",
    workItemKey: value.workItem.id,
    occurredAt: new Date().toISOString(),
    phaseRunId: requested.phaseRunId,
    data: {
      handler: "triageWorkItem",
      handlerVersion: 1,
      attempt: 1,
      causationEventId: requested.id,
      execution: { workspaceRef: value.store.repo.id, runRef: ref },
      evidence: [ref],
      route,
      rationale: "ready",
    },
  };
  appendEvent(value, requested.id, event);
  return event;
}

function appendPlanningInputRequired(
  value: ReturnType<typeof authorityFixture>,
  requested: Extract<FactoryLifecycleEvent, { type: "planning.requested" }>,
): Extract<FactoryLifecycleEvent, { type: "planning.input.required" }> {
  const handler = "producePlanCandidate" as const;
  const actionKey = factoryActionKey({
    phaseRunId: requested.phaseRunId,
    handler,
    attempt: 1,
    causationEventId: requested.id,
  });
  const questions = writeActionArtifact(value, requested.phaseRunId, handler, actionKey, {
    name: "questions.json",
    content: '["Clarify the target"]\n',
  });
  const event: Extract<FactoryLifecycleEvent, { type: "planning.input.required" }> = {
    version: 1,
    id: `planning.input.required:${actionKey}`,
    type: "planning.input.required",
    workItemKey: value.workItem.id,
    occurredAt: new Date().toISOString(),
    phaseRunId: requested.phaseRunId,
    data: {
      handler,
      handlerVersion: 1,
      attempt: 1,
      causationEventId: requested.id,
      execution: { workspaceRef: value.store.repo.id, runRef: questions },
      evidence: [questions],
      questions,
    },
  };
  appendEvent(value, requested.id, event);
  return event;
}

function seedDirectImplementation(
  value: ReturnType<typeof authorityFixture>,
): Extract<FactoryLifecycleEvent, { type: "triage.work_item.completed" }> {
  const inputDir = join(value.store.projectRoot, "inputs");
  mkdirSync(inputDir, { recursive: true });
  const workItemPath = join(inputDir, "work-item.json");
  writeFileSync(workItemPath, `${JSON.stringify(value.workItem)}\n`);
  const workItemRef = createFactoryArtifactRef({
    base: "factory-store",
    root: value.store.projectRoot,
    path: relative(value.store.projectRoot, workItemPath),
  });
  const imported: Extract<FactoryLifecycleEvent, { type: "work_item.imported" }> = {
    version: 1,
    id: `work_item.imported:${value.workItem.id}`,
    type: "work_item.imported",
    workItemKey: value.workItem.id,
    occurredAt: new Date().toISOString(),
    data: { source: value.workItem.source },
  };
  appendEvent(value, null, imported);
  const requested: Extract<FactoryLifecycleEvent, { type: "triage.requested" }> = {
    version: 1,
    id: "triage.requested:direct-readiness",
    type: "triage.requested",
    workItemKey: value.workItem.id,
    occurredAt: new Date().toISOString(),
    phaseRunId: "direct-readiness",
    data: { expectedPredecessor: imported.id, inputRefs: [workItemRef], intent: "start" },
  };
  appendEvent(value, imported.id, requested);
  return appendTriageCompletion(value, requested, "ready-to-implement");
}

function appendActionFailure(
  value: ReturnType<typeof authorityFixture>,
  requested: Extract<FactoryLifecycleEvent, { type: "implementation.requested" }>,
  handler: "produceImplementationCandidate",
  failureKind: "terminal" | "human-required",
): Extract<FactoryLifecycleEvent, { type: "factory.action.failed" }> {
  const actionKey = factoryActionKey({
    phaseRunId: requested.phaseRunId,
    handler,
    attempt: 1,
    causationEventId: requested.id,
  });
  const failure = writeActionArtifact(value, requested.phaseRunId, handler, actionKey, {
    name: "failure.json",
    content: `${JSON.stringify({ failureKind })}\n`,
  });
  const event: Extract<FactoryLifecycleEvent, { type: "factory.action.failed" }> = {
    version: 1,
    id: `factory.action.failed:${actionKey}`,
    type: "factory.action.failed",
    workItemKey: value.workItem.id,
    occurredAt: new Date().toISOString(),
    phaseRunId: requested.phaseRunId,
    data: {
      handler,
      handlerVersion: 1,
      attempt: 1,
      causationEventId: requested.id,
      execution: { workspaceRef: value.store.repo.id, runRef: failure },
      evidence: [failure],
      phase: "implementation",
      failureKind,
      message: "implementation failed",
    },
  };
  appendEvent(value, requested.id, event);
  return event;
}

function appendImplementationCandidate(
  value: ReturnType<typeof authorityFixture>,
  requested: Extract<FactoryLifecycleEvent, { type: "implementation.requested" }>,
): Extract<FactoryLifecycleEvent, { type: "implementation.candidate.produced" }> {
  const handler = "produceImplementationCandidate" as const;
  const actionKey = factoryActionKey({
    phaseRunId: requested.phaseRunId,
    handler,
    attempt: 1,
    causationEventId: requested.id,
  });
  const candidate = writeActionArtifact(value, requested.phaseRunId, handler, actionKey, {
    name: "candidate.json",
    content: '{"head":"candidate"}\n',
  });
  const event: Extract<FactoryLifecycleEvent, { type: "implementation.candidate.produced" }> = {
    version: 1,
    id: `implementation.candidate.produced:${actionKey}`,
    type: "implementation.candidate.produced",
    workItemKey: value.workItem.id,
    occurredAt: new Date().toISOString(),
    phaseRunId: requested.phaseRunId,
    data: {
      handler,
      handlerVersion: 1,
      attempt: 1,
      causationEventId: requested.id,
      execution: { workspaceRef: value.store.repo.id, runRef: candidate },
      evidence: [candidate],
      commit: "candidate-commit",
      tree: "candidate-tree",
      candidate,
      effectiveSession: { provider: "cursor", id: "implementation-session" },
    },
  };
  appendEvent(value, requested.id, event);
  return event;
}

function writeActionArtifact(
  value: ReturnType<typeof authorityFixture>,
  phaseRunId: string,
  handler: string,
  actionKey: string,
  artifact: { name: string; content: string },
) {
  const actionDir = join(value.store.factoryRunsDir, phaseRunId, "actions/1", handler, actionKey);
  const path = join(actionDir, "evidence", artifact.name);
  mkdirSync(join(actionDir, "evidence"), { recursive: true });
  writeFileSync(path, artifact.content);
  return createFactoryArtifactRef({
    base: "factory-store",
    root: value.store.projectRoot,
    path: relative(value.store.projectRoot, path),
  });
}

function appendEvent(
  value: ReturnType<typeof authorityFixture>,
  expectedLastEventId: string | null,
  event: FactoryLifecycleEvent,
): void {
  appendFactoryActionEvent({
    factoryStateRoot: value.store.factoryStateRoot,
    expectedLastEventId,
    event,
  });
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
