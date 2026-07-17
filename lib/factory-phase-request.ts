import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createFactoryArtifactRef, verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import type { FactoryPhase } from "./factory-action-contract.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import {
  appendFactoryActionEvent,
  FactoryLifecycleConflictError,
  readFactoryActionEvents,
} from "./factory-lifecycle-kernel.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { readFactoryPhaseRunIdentity, type FactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import { parseFactoryWorkItem, type FactoryWorkItem } from "./factory-schemas.ts";
import { decideNextFactoryAction, reduceFactoryLifecycleEvents } from "./factory-state-machine.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";

type PhaseRequest = Extract<
  FactoryLifecycleEvent,
  { type: "triage.requested" | "planning.requested" | "implementation.requested" }
>;

export type FactoryPhaseRequestInput = Readonly<{
  projectId: string;
  workItem: FactoryWorkItem;
  phase: FactoryPhase;
  intent: "start" | "restart";
  expectedPredecessor: string | null;
  factoryStore: FactoryStoreMeta;
}>;

export type PreparedFactoryPhaseRequest = Readonly<{
  input: FactoryPhaseRequestInput;
  workItemKey: string;
  predecessor: string;
  duplicate?: PhaseRequest;
}>;

export type AppendedFactoryPhaseRequest = ReturnType<typeof appendFactoryActionEvent> & {
  readonly next: ReturnType<typeof decideNextFactoryAction>;
  readonly duplicate: boolean;
};

type PrepareFactoryPhaseRequestHooks = Readonly<{
  afterImported?: () => void;
}>;

/** Validate an observed phase request without retaining the lifecycle lock across workspace work. */
export function prepareFactoryPhaseRequest(
  input: FactoryPhaseRequestInput,
): PreparedFactoryPhaseRequest {
  return prepareFactoryPhaseRequestWithHooks(input, {});
}

export function prepareFactoryPhaseRequestForTest(
  input: FactoryPhaseRequestInput,
  hooks: PrepareFactoryPhaseRequestHooks,
): PreparedFactoryPhaseRequest {
  return prepareFactoryPhaseRequestWithHooks(input, hooks);
}

function prepareFactoryPhaseRequestWithHooks(
  input: FactoryPhaseRequestInput,
  hooks: PrepareFactoryPhaseRequestHooks,
): PreparedFactoryPhaseRequest {
  authenticateInput(input);
  const workItem = parseFactoryWorkItem(input.workItem);
  const workItemKey = deriveFactoryWorkItemKey(workItem);
  let events = readFactoryActionEvents(input.factoryStore.factoryStateRoot, workItemKey);
  let latest = events.at(-1);
  const importedEventId = `work_item.imported:${workItemKey}`;
  let establishedImport = false;

  if (!latest) {
    if (input.expectedPredecessor !== null)
      throw new Error("Factory phase request observed a stale predecessor");
    const imported: FactoryLifecycleEvent = {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: new Date().toISOString(),
      data: { source: workItem.source },
    };
    appendImportedOrReuse(input.factoryStore.factoryStateRoot, imported);
    hooks.afterImported?.();
    events = readFactoryActionEvents(input.factoryStore.factoryStateRoot, workItemKey);
    latest = events.at(-1);
    establishedImport = true;
  }

  if (
    !establishedImport &&
    latest?.type === "work_item.imported" &&
    input.expectedPredecessor === null
  ) {
    const imported: FactoryLifecycleEvent = {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: latest.occurredAt,
      data: { source: workItem.source },
    };
    appendFactoryActionEvent({
      factoryStateRoot: input.factoryStore.factoryStateRoot,
      event: imported,
      expectedLastEventId: null,
    });
    hooks.afterImported?.();
    events = readFactoryActionEvents(input.factoryStore.factoryStateRoot, workItemKey);
    latest = events.at(-1);
    establishedImport = true;
  }

  if (!latest) throw new Error("Factory phase request has no durable predecessor");
  if (establishedImport && (latest.id !== importedEventId || latest.type !== "work_item.imported"))
    throw new Error(
      `Factory command lost the durable CAS: expected ${importedEventId}, found ${latest.id}`,
    );
  const duplicate = matchingDuplicate(latest, input);
  if (duplicate) {
    try {
      authenticateExistingRequest(duplicate, workItem, input.factoryStore);
    } catch (cause) {
      throw new Error(
        "Factory command lost the durable CAS: recorded phase request is not an authenticated duplicate",
        { cause },
      );
    }
    return {
      input: { ...input, workItem },
      workItemKey,
      predecessor: duplicate.data.expectedPredecessor!,
      duplicate,
    };
  }
  if (!establishedImport && latest.id !== input.expectedPredecessor)
    throw new Error(
      `Factory command lost the durable CAS: expected ${String(input.expectedPredecessor)}, found ${latest.id}`,
    );

  const state = reduceFactoryLifecycleEvents(events);
  if (!state) throw new Error("Factory phase request has no durable state");
  assertPhaseEligibility(state, input.phase, input.intent);
  return { input: { ...input, workItem }, workItemKey, predecessor: latest.id };
}

function appendImportedOrReuse(
  factoryStateRoot: string,
  imported: Extract<FactoryLifecycleEvent, { type: "work_item.imported" }>,
): void {
  try {
    appendFactoryActionEvent({
      factoryStateRoot,
      event: imported,
      expectedLastEventId: null,
    });
  } catch (error) {
    if (!(error instanceof FactoryLifecycleConflictError)) throw error;
    const existing = readFactoryActionEvents(factoryStateRoot, imported.workItemKey).find(
      (event) => event.id === imported.id,
    );
    if (
      existing?.type !== "work_item.imported" ||
      existing.workItemKey !== imported.workItemKey ||
      existing.data.source !== imported.data.source
    )
      throw error;
  }
}

/** Derive and conditionally append a phase request from an immutable phase-run context. */
export function appendPreparedFactoryPhaseRequest(input: {
  readonly prepared: PreparedFactoryPhaseRequest;
  readonly phaseRunId?: string;
}): AppendedFactoryPhaseRequest {
  const { prepared } = input;
  if (prepared.duplicate) {
    const events = readFactoryActionEvents(
      prepared.input.factoryStore.factoryStateRoot,
      prepared.workItemKey,
    );
    const current = events.find((event) => event.id === prepared.duplicate!.id);
    if (!current || current.type !== prepared.duplicate.type)
      throw new Error("Factory phase request duplicate is no longer durable");
    const state = reduceFactoryLifecycleEvents(events);
    if (!state) throw new Error("Factory phase request duplicate has no durable state");
    return {
      event: prepared.duplicate,
      state,
      next: decideNextFactoryAction(state, prepared.duplicate),
      duplicate: true,
    };
  }
  if (!input.phaseRunId) throw new Error("Factory phase request requires a phase run");

  const runDir = join(prepared.input.factoryStore.factoryRunsDir, input.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(runDir);
  authenticatePhaseIdentity(identity, prepared, input.phaseRunId);
  const event = phaseRequestEvent(prepared, identity, runDir);
  const appended = appendFactoryActionEvent({
    factoryStateRoot: prepared.input.factoryStore.factoryStateRoot,
    event,
    expectedLastEventId: prepared.predecessor,
  });
  return {
    ...appended,
    next: decideNextFactoryAction(appended.state, appended.event),
    duplicate: false,
  };
}

function authenticateInput(input: FactoryPhaseRequestInput): void {
  if (
    input.projectId !== input.factoryStore.projectId ||
    input.factoryStore.repo.id !== input.projectId
  )
    throw new Error("Factory phase request project identity mismatch");
}

function matchingDuplicate(
  latest: FactoryLifecycleEvent,
  input: FactoryPhaseRequestInput,
): PhaseRequest | undefined {
  const request = asPhaseRequest(latest, input.phase);
  if (
    !request ||
    request.data.intent !== input.intent ||
    (request.data.expectedPredecessor !== input.expectedPredecessor &&
      !(
        input.expectedPredecessor === null &&
        request.data.expectedPredecessor === `work_item.imported:${request.workItemKey}`
      ))
  )
    return undefined;
  return request;
}

function asPhaseRequest(
  event: FactoryLifecycleEvent,
  phase: FactoryPhase,
): PhaseRequest | undefined {
  if (phase === "triage" && event.type === "triage.requested") return event;
  if (phase === "planning" && event.type === "planning.requested") return event;
  if (phase === "implementation" && event.type === "implementation.requested") return event;
  return undefined;
}

function authenticateExistingRequest(
  request: PhaseRequest,
  workItem: FactoryWorkItem,
  store: FactoryStoreMeta,
): void {
  const identity = readFactoryPhaseRunIdentity(join(store.factoryRunsDir, request.phaseRunId));
  if (
    identity.phase !== request.type.replace(".requested", "") ||
    identity.phaseRunId !== request.phaseRunId ||
    identity.workItemKey !== request.workItemKey ||
    identity.projectId !== store.projectId ||
    resolve(identity.factoryStateRoot) !== resolve(store.factoryStateRoot)
  )
    throw new Error("Factory phase request conflicts with phase-run identity");
  const ref = request.data.inputRefs[0];
  if (!ref) throw new Error("Factory phase request lacks immutable work-item evidence");
  const path = verifyFactoryArtifactRef(ref, {
    "factory-store": store.projectRoot,
    repository: identity.workspace,
  });
  const persisted = parseFactoryWorkItem(JSON.parse(readFileSync(path, "utf8")));
  if (!samePhaseWorkItemEvidence(requestPhase(request), persisted, workItem))
    throw new Error("Factory phase request work-item evidence changed");
  for (const inputRef of request.data.inputRefs)
    verifyFactoryArtifactRef(inputRef, {
      "factory-store": store.projectRoot,
      repository: identity.workspace,
    });
  if (
    request.type === "planning.requested" &&
    (identity.phase !== "planning" ||
      request.data.publicationMode !== identity.publicationMode ||
      request.data.outputPlan !== identity.outputPlan)
  )
    throw new Error("Factory planning request options changed");
  if (request.type === "implementation.requested") {
    if (identity.phase !== "implementation")
      throw new Error("Factory implementation request identity changed");
    const expectedRefs =
      identity.input.mode === "direct"
        ? [identity.input.workItem, identity.input.readiness]
        : [identity.input.workItem, identity.input.approvedPlan ?? identity.input.planCandidate];
    if (JSON.stringify(request.data.inputRefs) !== JSON.stringify(expectedRefs))
      throw new Error("Factory implementation request inputs changed");
  }
}

function assertPhaseEligibility(
  state: NonNullable<ReturnType<typeof reduceFactoryLifecycleEvents>>,
  phase: FactoryPhase,
  intent: "start" | "restart",
): void {
  if (phase === "triage") {
    const allowed =
      (intent === "start" && state.phase === "idle") ||
      (intent === "restart" &&
        state.phase === "triage" &&
        ["routed", "parked", "needs-human", "failed"].includes(state.status));
    if (!allowed)
      throw new Error(
        `Invalid Factory transition: ${state.phase}/${state.status} -> triage.requested`,
      );
    return;
  }
  if (phase === "planning") {
    const allowed =
      (intent === "start" &&
        (state.phase === "idle" ||
          (state.phase === "triage" &&
            state.status === "routed" &&
            state.route === "ready-to-plan"))) ||
      (intent === "restart" &&
        state.phase === "planning" &&
        (state.status === "needs-human" || state.status === "failed"));
    if (!allowed) {
      if (intent === "restart")
        throw new Error("planning --rerun is allowed only from needs-human or failed");
      throw new Error(
        `Invalid Factory transition: ${state.phase}/${state.status} -> planning.requested`,
      );
    }
    return;
  }
  const allowed =
    (intent === "start" &&
      ((state.phase === "triage" &&
        state.status === "routed" &&
        state.route === "ready-to-implement") ||
        (state.phase === "planning" && state.status === "approved"))) ||
    (intent === "restart" &&
      state.phase === "implementation" &&
      (state.status === "needs-human" || state.status === "failed") &&
      !state.candidateEventId);
  if (!allowed) {
    if (intent === "restart")
      throw new Error(
        "implementation --rerun is allowed only after a failure without a reusable candidate",
      );
    throw new Error(
      `Invalid Factory transition: ${state.phase}/${state.status} -> implementation.requested`,
    );
  }
}

function authenticatePhaseIdentity(
  identity: FactoryPhaseRunIdentity,
  prepared: PreparedFactoryPhaseRequest,
  phaseRunId: string,
): void {
  const { input, workItemKey } = prepared;
  if (
    identity.phaseRunId !== phaseRunId ||
    identity.phase !== input.phase ||
    identity.workItemKey !== workItemKey ||
    identity.projectId !== input.projectId ||
    resolve(identity.factoryStateRoot) !== resolve(input.factoryStore.factoryStateRoot)
  )
    throw new Error("Factory phase request conflicts with phase-run identity");
  const persisted = parseFactoryWorkItem(
    JSON.parse(
      readFileSync(
        join(input.factoryStore.factoryRunsDir, phaseRunId, "context/work-item.json"),
        "utf8",
      ),
    ),
  );
  if (
    deriveFactoryWorkItemKey(persisted) !== workItemKey ||
    !samePhaseWorkItemEvidence(identity.phase, persisted, input.workItem)
  )
    throw new Error("Factory phase request work-item evidence changed");
}

function samePhaseWorkItemEvidence(
  phase: FactoryPhase,
  left: FactoryWorkItem,
  right: FactoryWorkItem,
): boolean {
  if (deriveFactoryWorkItemKey(left) !== deriveFactoryWorkItemKey(right)) return false;
  // Implementation consumes the authenticated triage/planning artifact. The live tracker copy
  // may have gained projection comments between phases and is not implementation authority.
  if (phase === "implementation") return true;
  const { metadata: _leftMetadata, ...leftEvidence } = left;
  const { metadata: _rightMetadata, ...rightEvidence } = right;
  return JSON.stringify(leftEvidence) === JSON.stringify(rightEvidence);
}

function requestPhase(request: PhaseRequest): FactoryPhase {
  if (request.type === "triage.requested") return "triage";
  if (request.type === "planning.requested") return "planning";
  return "implementation";
}

function phaseRequestEvent(
  prepared: PreparedFactoryPhaseRequest,
  identity: FactoryPhaseRunIdentity,
  runDir: string,
): PhaseRequest {
  const common = {
    version: 1 as const,
    id: `${prepared.input.phase}.requested:${identity.phaseRunId}`,
    workItemKey: prepared.workItemKey,
    occurredAt: new Date().toISOString(),
    phaseRunId: identity.phaseRunId,
  };
  const workItemRef = createFactoryArtifactRef({
    base: "factory-store",
    root: prepared.input.factoryStore.projectRoot,
    path: relative(prepared.input.factoryStore.projectRoot, join(runDir, "context/work-item.json")),
  });
  if (identity.phase === "triage")
    return {
      ...common,
      type: "triage.requested",
      data: {
        expectedPredecessor: prepared.predecessor,
        intent: prepared.input.intent,
        inputRefs: [workItemRef],
      },
    };
  if (identity.phase === "planning")
    return {
      ...common,
      type: "planning.requested",
      data: {
        expectedPredecessor: prepared.predecessor,
        intent: prepared.input.intent,
        inputRefs: [workItemRef],
        publicationMode: identity.publicationMode,
        outputPlan: identity.outputPlan,
      },
    };
  const inputRefs =
    identity.input.mode === "direct"
      ? [identity.input.workItem, identity.input.readiness]
      : [identity.input.workItem, identity.input.approvedPlan ?? identity.input.planCandidate];
  return {
    ...common,
    type: "implementation.requested",
    data: {
      expectedPredecessor: prepared.predecessor,
      intent: prepared.input.intent,
      inputRefs,
    },
  };
}
