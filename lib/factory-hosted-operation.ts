import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentProviderOptions } from "./agents.ts";
import { verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import {
  deriveFactoryGroveWorkspaceIntent,
  ensureFactoryGroveWorkspace,
  factoryGroveIntentMatchesPhaseGit,
  type FactoryGroveWorkspaceConfig,
} from "./factory-grove-workspace.ts";
import {
  executeFactoryOperation,
  FactoryOperationReceiptSchema,
  FactoryOperationRequestSchema,
  FactoryOperationResolutionError,
  recoverCompletedFactoryOperation,
  resolveFactoryOperation,
  type ExecuteFactoryOperationInput,
  type FactoryOperationReceipt,
  type FactoryOperationRequest,
} from "./factory-operation.ts";
import { assertFactoryPhaseWorkspace, requireFactoryPhaseGit } from "./factory-phase-git.ts";
import { readFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import { parseFactoryWorkItem, type FactoryWorkItem } from "./factory-schemas.ts";
import { deriveFactoryRepoIdentity, type FactoryStoreMeta } from "./factory-store.ts";
import type { WorkflowEventSink } from "./workflow-events.ts";

export type HostedFactoryRuntime = {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly factoryStore: FactoryStoreMeta;
  readonly grove: FactoryGroveWorkspaceConfig;
  readonly maxRuntimeMs: number;
  readonly signal?: AbortSignal;
  readonly eventSink?: WorkflowEventSink;
  readonly agentProviderFactory: (options: AgentProviderOptions) => Agent;
  readonly triage?: ExecuteFactoryOperationInput["triage"];
  readonly planReviewRunner?: ExecuteFactoryOperationInput["planReviewRunner"];
  readonly implementationReviewRunner?: ExecuteFactoryOperationInput["implementationReviewRunner"];
  readonly implementationReviewHeadFactory?: ExecuteFactoryOperationInput["implementationReviewHeadFactory"];
  /** Test seam at the external Grove boundary. */
  readonly ensureWorkspace?: typeof ensureFactoryGroveWorkspace;
};

/** Run one identifier-only Factory delivery against trusted runtime configuration. */
export async function runHostedFactoryOperation(input: {
  readonly request: FactoryOperationRequest;
  readonly runtime: HostedFactoryRuntime;
}): Promise<FactoryOperationReceipt> {
  const request = parseRequest(input.request);
  const { runtime } = input;
  authenticateRuntime(request, runtime);
  const before = resolve(runtime.factoryStore, request);
  const early = receiptWithoutExecution(runtime.factoryStore, request, before);
  if (early) return early;

  const phaseRunDir = join(runtime.factoryStore.factoryRunsDir, request.operation.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(phaseRunDir);
  const gitIdentity = requireFactoryPhaseGit(identity);
  if (gitIdentity.repositoryId !== runtime.repositoryId)
    throw new FactoryOperationResolutionError("Factory operation repository identity mismatch");
  const phaseRequest = findPhaseRequest(runtime.factoryStore, request, identity.phase);
  const workItem = readAuthenticatedWorkItem(
    phaseRunDir,
    request.workItemKey,
    phaseRequest,
    runtime,
  );

  if (phaseRequest.data.expectedPredecessor === null)
    throw new FactoryOperationResolutionError(
      "Factory phase request lacks hosted phase generation authority",
    );
  const intent = deriveFactoryGroveWorkspaceIntent({
    controllerRepository: runtime.grove.controllerRepository,
    workItemKey: request.workItemKey,
    phase: identity.phase,
    phaseGeneration: phaseRequest.data.expectedPredecessor,
    baseSha: gitIdentity.baseSha,
  });
  assertIntentMatchesIdentity(intent, gitIdentity);

  const ensured = await (runtime.ensureWorkspace ?? ensureFactoryGroveWorkspace)({
    config: runtime.grove,
    intent,
  });
  if (
    ensured.leaseId !== intent.leaseId ||
    JSON.stringify(ensured.intent) !== JSON.stringify(intent)
  )
    throw new FactoryOperationResolutionError("Grove returned a divergent Factory lease");
  try {
    assertFactoryPhaseWorkspace(identity, ensured.workspace);
  } catch (cause) {
    throw new FactoryOperationResolutionError("Grove workspace failed phase identity validation", {
      cause,
    });
  }

  const afterAcquire = resolve(runtime.factoryStore, request);
  const changed = receiptWithoutExecution(runtime.factoryStore, request, afterAcquire);
  if (changed) return changed;

  const recoveringImplementationResult =
    afterAcquire.status === "completed" && isImplementationHandler(request.operation.handler);

  await executeFactoryOperation({
    operation: request.operation,
    factoryStore: runtime.factoryStore,
    workspace: ensured.workspace,
    workItem,
    maxRuntimeMs: runtime.maxRuntimeMs,
    signal: runtime.signal,
    eventSink: runtime.eventSink,
    agentProviderFactory: runtime.agentProviderFactory,
    triage: runtime.triage,
    planReviewRunner: runtime.planReviewRunner,
    implementationReviewRunner: runtime.implementationReviewRunner,
    implementationReviewHeadFactory: runtime.implementationReviewHeadFactory,
  });
  const completed = recover(runtime.factoryStore, request);
  return FactoryOperationReceiptSchema.parse({
    version: 1,
    ...request,
    outcome: recoveringImplementationResult ? "recovered" : "executed",
    resultEventId: completed.event.id,
    ...(completed.next ? { next: completed.next } : {}),
  });
}

function parseRequest(request: FactoryOperationRequest): FactoryOperationRequest {
  const parsed = FactoryOperationRequestSchema.safeParse(request);
  if (parsed.success) return parsed.data;
  throw new FactoryOperationResolutionError("Invalid hosted Factory operation request", {
    cause: parsed.error,
  });
}

function authenticateRuntime(
  request: FactoryOperationRequest,
  runtime: HostedFactoryRuntime,
): void {
  if (
    request.projectId !== runtime.projectId ||
    request.projectId !== runtime.factoryStore.projectId ||
    deriveFactoryRepoIdentity(runtime.grove.controllerRepository).id !== runtime.repositoryId
  )
    throw new FactoryOperationResolutionError("Hosted Factory runtime identity mismatch");
}

function readAuthenticatedWorkItem(
  runDir: string,
  expectedKey: string,
  phaseRequest: PhaseRequest,
  runtime: HostedFactoryRuntime,
): FactoryWorkItem {
  const persisted = parseFactoryWorkItem(
    JSON.parse(readFileSync(join(runDir, "context/work-item.json"), "utf8")),
  );
  const authoritativePath = verifyFactoryArtifactRef(phaseRequest.data.inputRefs[0], {
    "factory-store": runtime.factoryStore.projectRoot,
    repository: runtime.grove.controllerRepository,
  });
  const authoritative = parseFactoryWorkItem(JSON.parse(readFileSync(authoritativePath, "utf8")));
  if (
    deriveFactoryWorkItemKey(persisted) !== expectedKey ||
    deriveFactoryWorkItemKey(authoritative) !== expectedKey
  )
    throw new FactoryOperationResolutionError("Factory operation work-item identity mismatch");
  return authoritative;
}

type PhaseRequest = Extract<
  FactoryLifecycleEvent,
  { type: "triage.requested" | "planning.requested" | "implementation.requested" }
>;

function findPhaseRequest(
  store: FactoryStoreMeta,
  request: FactoryOperationRequest,
  phase: "triage" | "planning" | "implementation",
): PhaseRequest {
  const expectedType = `${phase}.requested`;
  const event = readFactoryActionEvents(store.factoryStateRoot, request.workItemKey, {
    mode: "inspection",
  }).find(
    (candidate): candidate is PhaseRequest =>
      candidate.type === expectedType && candidate.phaseRunId === request.operation.phaseRunId,
  );
  if (!event)
    throw new FactoryOperationResolutionError("Factory phase request identity is unavailable");
  return event;
}

function resolve(store: FactoryStoreMeta, request: FactoryOperationRequest) {
  return resolveFactoryOperation({
    projectId: request.projectId,
    projectRoot: store.projectRoot,
    factoryStateRoot: store.factoryStateRoot,
    workspaceRef: store.repo.id,
    factoryStore: store,
    workItemKey: request.workItemKey,
    operation: request.operation,
  });
}

function recover(store: FactoryStoreMeta, request: FactoryOperationRequest) {
  return recoverCompletedFactoryOperation({
    projectId: request.projectId,
    projectRoot: store.projectRoot,
    factoryStateRoot: store.factoryStateRoot,
    workspaceRef: store.repo.id,
    factoryStore: store,
    workItemKey: request.workItemKey,
    operation: request.operation,
  });
}

function receiptWithoutExecution(
  store: FactoryStoreMeta,
  request: FactoryOperationRequest,
  resolution: ReturnType<typeof resolve>,
): FactoryOperationReceipt | undefined {
  const common = { version: 1 as const, ...request };
  if (resolution.status === "completed") {
    // An unrecorded implementation result may be a crash-gap artifact and still
    // needs Grove plus the action's live Git checks. A recorded event is already
    // canonical and can safely regenerate its receipt without workspace access.
    if (isImplementationHandler(request.operation.handler) && !resolution.eventRecorded)
      return undefined;
    const completed = recoverCompletedFactoryOperation({
      projectId: request.projectId,
      projectRoot: store.projectRoot,
      factoryStateRoot: store.factoryStateRoot,
      workspaceRef: store.repo.id,
      factoryStore: store,
      workItemKey: request.workItemKey,
      operation: request.operation,
    });
    return FactoryOperationReceiptSchema.parse({
      ...common,
      outcome: "recovered",
      resultEventId: completed.event.id,
      ...(completed.next ? { next: completed.next } : {}),
    });
  }
  if (resolution.status === "stale")
    return FactoryOperationReceiptSchema.parse({
      ...common,
      outcome: "stale",
      observedEventId: resolution.observedEventId,
    });
  if (resolution.status === "wait")
    return FactoryOperationReceiptSchema.parse({
      ...common,
      outcome: "waiting",
      observedEventId: resolution.observedEventId,
      reason: resolution.reaction.reason,
    });
  return undefined;
}

function isImplementationHandler(
  handler: FactoryOperationRequest["operation"]["handler"],
): boolean {
  return (
    handler === "produceImplementationCandidate" || handler === "reviewImplementationCandidate"
  );
}

function assertIntentMatchesIdentity(
  intent: ReturnType<typeof deriveFactoryGroveWorkspaceIntent>,
  git: ReturnType<typeof requireFactoryPhaseGit>,
): void {
  if (!factoryGroveIntentMatchesPhaseGit(intent, git))
    throw new FactoryOperationResolutionError("Grove intent conflicts with Factory phase identity");
}
