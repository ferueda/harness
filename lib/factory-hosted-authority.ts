import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { Agent, AgentProviderOptions } from "./agents.ts";
import type { FactoryRoleAgent } from "./config.ts";
import { FactoryPhaseSchema } from "./factory-action-contract.ts";
import { FactoryContinuationDecisionSchema } from "./factory-lifecycle-events.ts";
import {
  recordFactoryContinuation,
  type FactoryContinuationObservation,
} from "./factory-continuation.ts";
import {
  deriveFactoryGroveWorkspaceIntent,
  ensureFactoryGroveWorkspace,
  factoryGroveIntentMatchesPhaseGit,
  type FactoryGroveWorkspaceConfig,
} from "./factory-grove-workspace.ts";
import { resolveFactoryImplementationInput } from "./factory-implementation-input.ts";
import { createFactoryImplementationRunContext } from "./factory-implementation-run-context.ts";
import { readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import {
  reconcileFactoryOperations,
  type FactoryOperationDelivery,
  type FactoryOperationReconciliationResult,
} from "./factory-operation-reconciliation.ts";
import {
  appendPreparedFactoryPhaseRequest,
  prepareFactoryPhaseRequest,
} from "./factory-phase-request.ts";
import { requireFactoryPhaseGit } from "./factory-phase-git.ts";
import {
  readFactoryPhaseRunIdentity,
  type FactoryActionExecutionProfile,
} from "./factory-phase-run.ts";
import {
  createFactoryPlanningRunContext,
  type FactoryPlanningReviewRunner,
} from "./factory-planning-run-context.ts";
import { createFactoryRunContext } from "./factory-run-context.ts";
import { FactoryWorkItemSchema } from "./factory-schemas.ts";
import { deriveFactoryRepoIdentity, type FactoryStoreMeta } from "./factory-store.ts";
import type { WorkflowEventSink } from "./workflow-events.ts";

const CursorSchema = z.string().min(1).nullable();

export const HostedFactoryPhaseRequestSchema = z
  .object({
    projectId: z.string().min(1),
    workItem: FactoryWorkItemSchema,
    phase: FactoryPhaseSchema,
    intent: z.enum(["start", "restart"]),
    expectedPredecessor: CursorSchema,
  })
  .strict();
export type HostedFactoryPhaseRequest = Readonly<z.infer<typeof HostedFactoryPhaseRequestSchema>>;

export const HostedFactoryContinuationRequestSchema = z
  .object({
    projectId: z.string().min(1),
    workItemKey: z.string().min(1),
    phase: z.enum(["planning", "implementation"]),
    decision: FactoryContinuationDecisionSchema,
    response: z.string(),
    expectedPredecessor: z.string().min(1),
    phaseRunId: z.string().min(1),
    candidateEventId: z.string().min(1),
    reviewEventId: z.string().min(1).optional(),
  })
  .strict();
export type HostedFactoryContinuationRequest = Readonly<
  z.infer<typeof HostedFactoryContinuationRequestSchema>
>;

export type HostedFactoryAuthorityRuntime = Readonly<{
  projectId: string;
  repositoryId: string;
  factoryStore: FactoryStoreMeta;
  grove: FactoryGroveWorkspaceConfig;
  baseRef: string;
  deliver: FactoryOperationDelivery;
  ensureWorkspace?: typeof ensureFactoryGroveWorkspace;
  triage: Readonly<{
    executionProfile: FactoryActionExecutionProfile;
    maxRuntimeMs: number;
    agentProviderFactory: (options: AgentProviderOptions) => Agent;
    signal?: AbortSignal;
    eventSink?: WorkflowEventSink;
  }>;
  planning: Readonly<{
    plannerRole: FactoryRoleAgent;
    reviewerRole: FactoryRoleAgent;
    maxRuntimeMs: number;
    agentProviderFactory: (options: AgentProviderOptions) => Agent;
    publicationMode: "local" | "pull-request";
    outputPlan?: string;
    signal?: AbortSignal;
    eventSink?: WorkflowEventSink;
    planReviewRunner?: FactoryPlanningReviewRunner;
  }>;
  implementation: Readonly<{
    implementerRole: FactoryRoleAgent;
    reviewerRole: FactoryRoleAgent;
    eventSink?: WorkflowEventSink;
  }>;
}>;

/** Persist phase authority, then ask reconciliation to deliver the canonical operation hint. */
export async function requestHostedFactoryPhase(input: {
  readonly request: HostedFactoryPhaseRequest;
  readonly runtime: HostedFactoryAuthorityRuntime;
}): Promise<FactoryOperationReconciliationResult> {
  const request = HostedFactoryPhaseRequestSchema.parse(input.request);
  authenticateRuntime(request.projectId, input.runtime);
  const prepared = prepareFactoryPhaseRequest({
    ...request,
    factoryStore: input.runtime.factoryStore,
  });
  if (!prepared.duplicate) {
    const baseSha = controllerHead(input.runtime.grove.controllerRepository);
    const intent = deriveFactoryGroveWorkspaceIntent({
      controllerRepository: input.runtime.grove.controllerRepository,
      workItemKey: prepared.workItemKey,
      phase: request.phase,
      phaseGeneration: prepared.predecessor,
      baseSha,
    });
    const ensured = await (input.runtime.ensureWorkspace ?? ensureFactoryGroveWorkspace)({
      config: input.runtime.grove,
      intent,
    });
    authenticateWorkspace(ensured, intent, input.runtime.repositoryId);
    const phaseRunId = createPhaseContext(request, input.runtime, ensured.workspace);
    const identity = readFactoryPhaseRunIdentity(
      `${input.runtime.factoryStore.factoryRunsDir}/${phaseRunId}`,
    );
    const git = requireFactoryPhaseGit(identity);
    if (!factoryGroveIntentMatchesPhaseGit(intent, git))
      throw new Error("Factory phase context conflicts with Grove authority");
    appendPreparedFactoryPhaseRequest({ prepared, phaseRunId });
  }
  return reconcileOne(input.runtime, prepared.workItemKey);
}

/** Persist an explicitly observed continuation, then reconcile its exact next operation. */
export async function recordHostedFactoryContinuation(input: {
  readonly request: HostedFactoryContinuationRequest;
  readonly runtime: HostedFactoryAuthorityRuntime;
}): Promise<FactoryOperationReconciliationResult> {
  const request = HostedFactoryContinuationRequestSchema.parse(input.request);
  authenticateRuntime(request.projectId, input.runtime);
  const observed: FactoryContinuationObservation = {
    expectedPredecessor: request.expectedPredecessor,
    phaseRunId: request.phaseRunId,
    candidateEventId: request.candidateEventId,
    ...(request.reviewEventId ? { reviewEventId: request.reviewEventId } : {}),
  };
  recordFactoryContinuation({
    phase: request.phase,
    decision: request.decision,
    response: request.response,
    factoryStateRoot: input.runtime.factoryStore.factoryStateRoot,
    factoryStore: input.runtime.factoryStore,
    workItemKey: request.workItemKey,
    observed,
  });
  return reconcileOne(input.runtime, request.workItemKey);
}

function authenticateRuntime(projectId: string, runtime: HostedFactoryAuthorityRuntime): void {
  if (
    projectId !== runtime.projectId ||
    projectId !== runtime.factoryStore.projectId ||
    deriveFactoryRepoIdentity(runtime.grove.controllerRepository).id !== runtime.repositoryId
  )
    throw new Error("Hosted Factory authority runtime identity mismatch");
}

function controllerHead(repository: string): string {
  return git(repository, ["rev-parse", "--verify", "HEAD^{commit}"]);
}

function authenticateWorkspace(
  workspace: Awaited<ReturnType<typeof ensureFactoryGroveWorkspace>>,
  intent: ReturnType<typeof deriveFactoryGroveWorkspaceIntent>,
  repositoryId: string,
): void {
  if (
    workspace.leaseId !== intent.leaseId ||
    JSON.stringify(workspace.intent) !== JSON.stringify(intent) ||
    deriveFactoryRepoIdentity(workspace.workspace).id !== repositoryId ||
    git(workspace.workspace, ["rev-parse", "--verify", "HEAD^{commit}"]) !== intent.baseSha
  )
    throw new Error("Grove returned a divergent Factory workspace");
  const branch = tryGit(workspace.workspace, ["symbolic-ref", "-q", "HEAD"]);
  const targetMatches =
    (intent.target.mode === "detached" && branch === undefined) ||
    (intent.target.mode === "branch" && branch === `refs/heads/${intent.target.branch}`);
  if (!targetMatches) throw new Error("Grove workspace target conflicts with Factory intent");
}

function createPhaseContext(
  request: HostedFactoryPhaseRequest,
  runtime: HostedFactoryAuthorityRuntime,
  workspace: string,
): string {
  if (request.phase === "triage")
    return createFactoryRunContext({
      workspace,
      runsDir: runtime.factoryStore.factoryRunsDir,
      workItem: request.workItem,
      factoryStore: runtime.factoryStore,
      ...runtime.triage,
    }).runId;
  if (request.phase === "planning")
    return createFactoryPlanningRunContext({
      workspace,
      runsDir: runtime.factoryStore.factoryRunsDir,
      workItem: request.workItem,
      factoryStore: runtime.factoryStore,
      reviewRunsDir: runtime.factoryStore.reviewRunsDir,
      baseRef: runtime.baseRef,
      ...runtime.planning,
    }).runId;
  const events = readFactoryActionEvents(
    runtime.factoryStore.factoryStateRoot,
    deriveWorkItemKey(request),
  );
  return createFactoryImplementationRunContext({
    workspace,
    runsDir: runtime.factoryStore.factoryRunsDir,
    workItem: request.workItem,
    factoryStore: runtime.factoryStore,
    implementationInput: resolveFactoryImplementationInput(events),
    baseRef: runtime.baseRef,
    ...runtime.implementation,
  }).runId;
}

function deriveWorkItemKey(request: HostedFactoryPhaseRequest): string {
  return deriveFactoryWorkItemKey(request.workItem);
}

async function reconcileOne(
  runtime: HostedFactoryAuthorityRuntime,
  workItemKey: string,
): Promise<FactoryOperationReconciliationResult> {
  const results = await reconcileFactoryOperations(
    [{ projectId: runtime.projectId, workItemKey, factoryStore: runtime.factoryStore }],
    runtime.deliver,
  );
  const result = results[0];
  if (!result) throw new Error("Factory reconciliation returned no result");
  return result;
}

function tryGit(repository: string, args: readonly string[]): string | undefined {
  try {
    return git(repository, args);
  } catch {
    return undefined;
  }
}

function git(repository: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
