import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  type FactoryLifecycleEvent,
  type FactoryLifecycleExecution,
  type FactoryLifecyclePrecondition,
} from "./factory-lifecycle.ts";
import {
  ArtifactPointerSchema,
  CandidateTupleSchema,
  EffectiveReviewLimitSchema,
  type ArtifactPointer,
  type CandidateTuple,
  type EffectiveReviewLimit,
  type PartialRecovery,
  type RunRootProvenance,
  type WorkspaceProvenance,
} from "./factory-implementation-review-schemas.ts";
import type { AgentSessionRef } from "./agents.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";

type ReviewLifecycleBase = {
  factoryStateRoot: string;
  workItem: FactoryWorkItem;
  execution?: FactoryLifecycleExecution;
  occurredAt?: string;
};

export type FactoryImplementationReviewStartedInput = ReviewLifecycleBase & {
  owningImplementationRunId: string;
  activeReviewAttemptId: string;
  attemptIndex: number;
  activeReviewIndex?: number;
  priorReviewAttemptId?: string;
  resume: boolean;
  expectedCheckpointId: string | null;
  originalReviewBase: string;
  approvedCandidate: CandidateTuple;
  implementerSession: AgentSessionRef;
  workspace: WorkspaceProvenance;
  runRoots: RunRootProvenance;
  effectiveReviewLimit: EffectiveReviewLimit;
  candidateVersion: number;
  completedReviewCount: number;
  expectedActiveReviewAttemptId?: string | null;
};

export function appendImplementationReviewStartedEvent(
  input: FactoryImplementationReviewStartedInput,
): FactoryLifecycleEvent {
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  const event: FactoryLifecycleEvent = {
    version: 1,
    id: `implementation.review.started:${input.activeReviewAttemptId}`,
    type: "implementation.review.started",
    workItemKey,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    runId: input.activeReviewAttemptId,
    source: "harness",
    ...(input.execution ? { execution: input.execution } : {}),
    data: {
      owningImplementationRunId: input.owningImplementationRunId,
      activeReviewAttemptId: input.activeReviewAttemptId,
      attemptIndex: input.attemptIndex,
      ...(input.activeReviewIndex !== undefined
        ? { activeReviewIndex: input.activeReviewIndex }
        : {}),
      ...(input.priorReviewAttemptId ? { priorReviewAttemptId: input.priorReviewAttemptId } : {}),
      resume: input.resume,
      expectedCheckpointId: input.expectedCheckpointId,
      originalReviewBase: input.originalReviewBase,
      approvedCandidate: CandidateTupleSchema.parse(input.approvedCandidate),
      implementerSession: input.implementerSession,
      workspace: input.workspace,
      runRoots: input.runRoots,
      effectiveReviewLimit: EffectiveReviewLimitSchema.parse(input.effectiveReviewLimit),
      candidateVersion: input.candidateVersion,
      completedReviewCount: input.completedReviewCount,
    },
  };
  return appendFactoryLifecycleEvent({
    factoryStateRoot: input.factoryStateRoot,
    event,
    precondition: {
      allowedStages: [
        "implementation-complete",
        "review-running",
        "review-failed",
        "ready-for-human",
      ],
      expectedFactoryRunId: input.owningImplementationRunId,
      expectedImplementationRunId: input.owningImplementationRunId,
      expectedActiveReviewAttemptId: input.expectedActiveReviewAttemptId,
      expectedLastCheckpointId: input.expectedCheckpointId,
    },
  });
}

export type FactoryImplementationReviewCheckpointInput = ReviewLifecycleBase & {
  checkpointId: string;
  owningImplementationRunId: string;
  activeReviewAttemptId: string;
  phase: "review" | "remediation";
  completedReviewCount: number;
  candidateVersion: number;
  originalReviewBase: string;
  approvedCandidate: CandidateTuple;
  implementerSession: AgentSessionRef;
  workspace: WorkspaceProvenance;
  runRoots: RunRootProvenance;
  activeReviewIndex?: number;
  priorReviewAttemptId?: string;
  review?: ArtifactPointer;
  decision?: ArtifactPointer;
  candidate?: ArtifactPointer;
  workspaceStatus?: ArtifactPointer;
  partialRecovery?: PartialRecovery;
  effectiveReviewLimit: EffectiveReviewLimit;
  latestOutcome?: string;
  latestErrorClass?: string;
  expectedCheckpointId: string;
};

export function appendImplementationReviewCheckpointedEvent(
  input: FactoryImplementationReviewCheckpointInput,
): FactoryLifecycleEvent {
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  const event: FactoryLifecycleEvent = {
    version: 1,
    id: input.checkpointId,
    type: "implementation.review.checkpointed",
    workItemKey,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    runId: input.activeReviewAttemptId,
    source: "harness",
    ...(input.execution ? { execution: input.execution } : {}),
    data: {
      checkpointId: input.checkpointId,
      owningImplementationRunId: input.owningImplementationRunId,
      activeReviewAttemptId: input.activeReviewAttemptId,
      phase: input.phase,
      completedReviewCount: input.completedReviewCount,
      candidateVersion: input.candidateVersion,
      originalReviewBase: input.originalReviewBase,
      approvedCandidate: CandidateTupleSchema.parse(input.approvedCandidate),
      implementerSession: input.implementerSession,
      workspace: input.workspace,
      runRoots: input.runRoots,
      ...(input.activeReviewIndex !== undefined
        ? { activeReviewIndex: input.activeReviewIndex }
        : {}),
      ...(input.priorReviewAttemptId ? { priorReviewAttemptId: input.priorReviewAttemptId } : {}),
      ...(input.review ? { review: ArtifactPointerSchema.parse(input.review) } : {}),
      ...(input.decision ? { decision: ArtifactPointerSchema.parse(input.decision) } : {}),
      ...(input.candidate ? { candidate: ArtifactPointerSchema.parse(input.candidate) } : {}),
      ...(input.workspaceStatus
        ? { workspaceStatus: ArtifactPointerSchema.parse(input.workspaceStatus) }
        : {}),
      ...(input.partialRecovery ? { partialRecovery: input.partialRecovery } : {}),
      effectiveReviewLimit: EffectiveReviewLimitSchema.parse(input.effectiveReviewLimit),
      ...(input.latestOutcome ? { latestOutcome: input.latestOutcome } : {}),
      ...(input.latestErrorClass ? { latestErrorClass: input.latestErrorClass } : {}),
    },
  };
  return appendFactoryLifecycleEvent({
    factoryStateRoot: input.factoryStateRoot,
    event,
    precondition: {
      allowedStages: ["review-running"],
      expectedFactoryRunId: input.owningImplementationRunId,
      expectedImplementationRunId: input.owningImplementationRunId,
      expectedActiveReviewAttemptId: input.activeReviewAttemptId,
      expectedLastCheckpointId: input.expectedCheckpointId,
    },
  });
}

type ReviewTerminalBase = ReviewLifecycleBase & {
  runId: string;
  owningImplementationRunId: string;
  activeReviewAttemptId: string;
  latestCheckpointId: string;
};

type ReviewCompletedEvent = Extract<
  FactoryLifecycleEvent,
  { type: "implementation.review.completed" }
>;
type ReviewUnresolvedEvent = Extract<
  FactoryLifecycleEvent,
  { type: "implementation.review.unresolved" }
>;
type ReviewFailedEvent = Extract<FactoryLifecycleEvent, { type: "implementation.review.failed" }>;

export function appendImplementationReviewCompletedEvent(
  input: ReviewTerminalBase & {
    finalCandidate: CandidateTuple;
    handoff: ArtifactPointer;
    acceptedDebt?: ArtifactPointer;
    acceptedDebtCount: number;
  },
): FactoryLifecycleEvent {
  const event: ReviewCompletedEvent = {
    version: 1,
    id: `implementation.review.completed:${input.runId}`,
    type: "implementation.review.completed",
    workItemKey: deriveFactoryWorkItemKey(input.workItem),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    runId: input.runId,
    source: "harness",
    ...(input.execution ? { execution: input.execution } : {}),
    data: {
      owningImplementationRunId: input.owningImplementationRunId,
      activeReviewAttemptId: input.activeReviewAttemptId,
      latestCheckpointId: input.latestCheckpointId,
      finalCandidate: input.finalCandidate,
      handoff: input.handoff,
      ...(input.acceptedDebt ? { acceptedDebt: input.acceptedDebt } : {}),
      acceptedDebtCount: input.acceptedDebtCount,
    },
  };
  return appendReviewTerminalEvent({ input, event });
}

export function appendImplementationReviewUnresolvedEvent(
  input: ReviewTerminalBase & {
    reason:
      | "blocked"
      | "missing-session"
      | "incompatible-session"
      | "legacy-incomplete"
      | "declined-must-fix"
      | "max-iterations"
      | "stale-owner";
    summary: ArtifactPointer;
  },
): FactoryLifecycleEvent {
  const event: ReviewUnresolvedEvent = {
    version: 1,
    id: `implementation.review.unresolved:${input.runId}`,
    type: "implementation.review.unresolved",
    workItemKey: deriveFactoryWorkItemKey(input.workItem),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    runId: input.runId,
    source: "harness",
    ...(input.execution ? { execution: input.execution } : {}),
    data: {
      owningImplementationRunId: input.owningImplementationRunId,
      activeReviewAttemptId: input.activeReviewAttemptId,
      latestCheckpointId: input.latestCheckpointId,
      reason: input.reason,
      summary: input.summary,
    },
  };
  return appendReviewTerminalEvent({ input, event });
}

export function appendImplementationReviewFailedEvent(
  input: ReviewTerminalBase & {
    classification: "reviewer" | "provider" | "git" | "artifact" | "protocol" | "workspace";
    retryable: boolean;
    error: string;
    summary: ArtifactPointer;
    recovery?: ArtifactPointer;
    partialRecovery?: PartialRecovery;
    writerBoundaryBefore?: ArtifactPointer;
    writerBoundaryAfter?: ArtifactPointer;
  },
): FactoryLifecycleEvent {
  const event: ReviewFailedEvent = {
    version: 1,
    id: `implementation.review.failed:${input.runId}`,
    type: "implementation.review.failed",
    workItemKey: deriveFactoryWorkItemKey(input.workItem),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    runId: input.runId,
    source: "harness",
    ...(input.execution ? { execution: input.execution } : {}),
    data: {
      owningImplementationRunId: input.owningImplementationRunId,
      activeReviewAttemptId: input.activeReviewAttemptId,
      latestCheckpointId: input.latestCheckpointId,
      classification: input.classification,
      retryable: input.retryable,
      error: input.error,
      summary: input.summary,
      ...(input.recovery ? { recovery: input.recovery } : {}),
      ...(input.partialRecovery ? { partialRecovery: input.partialRecovery } : {}),
      ...(input.writerBoundaryBefore ? { writerBoundaryBefore: input.writerBoundaryBefore } : {}),
      ...(input.writerBoundaryAfter ? { writerBoundaryAfter: input.writerBoundaryAfter } : {}),
    },
  };
  return appendReviewTerminalEvent({ input, event });
}

function appendReviewTerminalEvent(input: {
  input: ReviewTerminalBase;
  event: ReviewCompletedEvent | ReviewUnresolvedEvent | ReviewFailedEvent;
}): FactoryLifecycleEvent {
  const precondition: FactoryLifecyclePrecondition = {
    allowedStages: ["review-running"],
    expectedFactoryRunId: input.input.owningImplementationRunId,
    expectedImplementationRunId: input.input.owningImplementationRunId,
    expectedActiveReviewAttemptId: input.input.activeReviewAttemptId,
    expectedLastCheckpointId: input.input.latestCheckpointId,
  };
  return appendFactoryLifecycleEvent({
    factoryStateRoot: input.input.factoryStateRoot,
    event: input.event,
    precondition,
  });
}
