import { z } from "zod";
import type { FactoryHandler, FactoryPhase } from "./factory-action-contract.ts";
import { FactoryPhaseRunIdSchema } from "./factory-action-contract.ts";
import { FactoryArtifactRefSchema } from "./factory-artifact-ref.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";

const Common = z
  .object({
    projectionVersion: z.literal(1),
    workItemKey: z.string(),
    lastEventId: z.string(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
const PhaseState = Common.extend({ phaseRunId: FactoryPhaseRunIdSchema });
const CandidateProgress = PhaseState.extend({
  candidateAttempt: z.number().int().nonnegative(),
  reviewRound: z.number().int().nonnegative(),
  candidateEventId: z.string().min(1).optional(),
  reviewEventId: z.string().min(1).optional(),
});
const PlanningState = CandidateProgress.extend({
  publicationMode: z.enum(["local", "pull-request"]),
  outputPlan: z.string().min(1),
  reviewedPlan: FactoryArtifactRefSchema.optional(),
  planPrUrl: z.url().optional(),
  planPrHead: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  planMergeCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});
const ImplementationState = CandidateProgress.extend({
  reviewedHead: z.string().min(1).optional(),
  implementationPrUrl: z.url().optional(),
  implementationPrHead: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  implementationMergeCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

export const FactoryLifecycleStateSchema = z.union([
  Common.extend({ phase: z.literal("idle"), status: z.literal("idle") }),
  PhaseState.extend({ phase: z.literal("triage"), status: z.literal("awaiting-result") }),
  PhaseState.extend({
    phase: z.literal("triage"),
    status: z.literal("routed"),
    route: z.enum(["ready-to-plan", "ready-to-implement"]),
  }),
  PhaseState.extend({
    phase: z.literal("triage"),
    status: z.literal("needs-human"),
    route: z.literal("needs-info").optional(),
  }),
  PhaseState.extend({
    phase: z.literal("triage"),
    status: z.literal("parked"),
    route: z.literal("wait-to-implement"),
  }),
  PhaseState.extend({ phase: z.literal("triage"), status: z.literal("failed") }),
  PlanningState.extend({
    phase: z.literal("planning"),
    status: z.enum([
      "awaiting-candidate",
      "awaiting-review",
      "awaiting-continuation",
      "needs-human",
      "awaiting-plan-publication",
      "awaiting-plan-merge",
      "approved",
      "failed",
    ]),
  }),
  ImplementationState.extend({
    phase: z.literal("implementation"),
    status: z.enum([
      "awaiting-candidate",
      "awaiting-review",
      "awaiting-continuation",
      "needs-human",
      "awaiting-pr-publication",
      "awaiting-pr-merge",
      "complete",
      "failed",
    ]),
  }),
]);
export type FactoryLifecycleState = z.infer<typeof FactoryLifecycleStateSchema>;

export const FactoryWaitReasonSchema = z.enum([
  "human",
  "plan-publication",
  "plan-merge",
  "pr-publication",
  "pr-merge",
  "complete",
  "failed",
  "stale-event",
]);
export type FactoryWaitReason = z.infer<typeof FactoryWaitReasonSchema>;

export type FactoryPhaseStartEvent = Extract<
  FactoryLifecycleEvent,
  {
    type:
      | "work_item.imported"
      | "triage.work_item.completed"
      | "planning.review.completed"
      | "plan_pr.merged";
  }
>;

export type FactoryReaction =
  | {
      kind: "invoke";
      phase: FactoryPhase;
      handler: FactoryHandler;
      attempt: number;
      causationEventId: string;
      scheduling: "immediate" | "retry";
      reason: string;
      command?: string;
    }
  | {
      kind: "start-phase";
      phase: FactoryPhase;
      event: FactoryPhaseStartEvent;
      command?: string;
    }
  | {
      kind: "wait";
      reason: FactoryWaitReason;
      command?: string;
    };

export function reduceFactoryLifecycleEvents(
  events: readonly FactoryLifecycleEvent[],
): FactoryLifecycleState | undefined {
  let state: FactoryLifecycleState | undefined;
  for (const event of events) state = reduce(state, event);
  return state;
}

function reduce(
  current: FactoryLifecycleState | undefined,
  event: FactoryLifecycleEvent,
): FactoryLifecycleState {
  const base = {
    projectionVersion: 1 as const,
    workItemKey: event.workItemKey,
    lastEventId: event.id,
    updatedAt: event.occurredAt,
  };
  if (current && current.workItemKey !== event.workItemKey)
    throw new Error("Factory event work-item mismatch");
  validateFactoryTransition(current, event);
  switch (event.type) {
    case "work_item.imported":
      return { ...base, phase: "idle", status: "idle" };
    case "triage.requested":
      return { ...base, phase: "triage", status: "awaiting-result", phaseRunId: event.phaseRunId };
    case "triage.work_item.completed":
      if (event.data.route === "needs-info")
        return {
          ...base,
          phase: "triage",
          status: "needs-human",
          phaseRunId: event.phaseRunId,
          route: event.data.route,
        };
      if (event.data.route === "wait-to-implement")
        return {
          ...base,
          phase: "triage",
          status: "parked",
          phaseRunId: event.phaseRunId,
          route: event.data.route,
        };
      return {
        ...base,
        phase: "triage",
        status: "routed",
        phaseRunId: event.phaseRunId,
        route: event.data.route,
      };
    case "planning.requested":
      return {
        ...base,
        phase: "planning",
        status: "awaiting-candidate",
        phaseRunId: event.phaseRunId,
        candidateAttempt: 0,
        reviewRound: 0,
        publicationMode: event.data.publicationMode,
        outputPlan: event.data.outputPlan,
      };
    case "planning.candidate.produced": {
      const prior = planning(current);
      return {
        ...base,
        ...planningIdentity(prior),
        phase: "planning",
        status: "awaiting-review",
        candidateAttempt: event.data.attempt,
        reviewRound: prior.reviewRound,
        candidateEventId: event.id,
        reviewedPlan: event.data.candidate,
      };
    }
    case "planning.input.required": {
      const prior = planning(current);
      return {
        ...base,
        ...planningIdentity(prior),
        phase: "planning",
        status: prior.candidateEventId ? "awaiting-continuation" : "needs-human",
        candidateAttempt: prior.candidateAttempt,
        reviewRound: prior.reviewRound,
        ...(prior.candidateEventId ? { candidateEventId: prior.candidateEventId } : {}),
        ...(prior.reviewEventId ? { reviewEventId: prior.reviewEventId } : {}),
        ...(prior.reviewedPlan ? { reviewedPlan: prior.reviewedPlan } : {}),
      };
    }
    case "planning.review.completed": {
      const prior = planning(current);
      return {
        ...base,
        ...planningIdentity(prior),
        phase: "planning",
        status:
          event.data.verdict === "pass"
            ? prior.publicationMode === "local"
              ? "approved"
              : "awaiting-plan-publication"
            : "awaiting-continuation",
        candidateAttempt: prior.candidateAttempt,
        reviewRound: event.data.attempt,
        candidateEventId: prior.candidateEventId,
        reviewEventId: event.id,
        reviewedPlan: prior.reviewedPlan,
      };
    }
    case "implementation.requested":
      return {
        ...base,
        phase: "implementation",
        status: "awaiting-candidate",
        phaseRunId: event.phaseRunId,
        candidateAttempt: 0,
        reviewRound: 0,
      };
    case "implementation.candidate.produced": {
      const prior = implementation(current);
      return {
        ...base,
        ...implementationIdentity(prior),
        phase: "implementation",
        status: "awaiting-review",
        candidateAttempt: event.data.attempt,
        reviewRound: prior.reviewRound,
        candidateEventId: event.id,
        reviewedHead: event.data.commit,
      };
    }
    case "implementation.review.completed": {
      const prior = implementation(current);
      return {
        ...base,
        ...implementationIdentity(prior),
        phase: "implementation",
        status: event.data.verdict === "pass" ? "awaiting-pr-publication" : "awaiting-continuation",
        candidateAttempt: prior.candidateAttempt,
        reviewRound: event.data.attempt,
        candidateEventId: prior.candidateEventId,
        reviewEventId: event.id,
        reviewedHead: prior.reviewedHead,
      };
    }
    case "factory.continuation.recorded":
      if (event.data.phase === "planning") {
        const prior = planning(current);
        return {
          ...base,
          ...planningIdentity(prior),
          phase: "planning",
          status: event.data.decision === "revise" ? "awaiting-candidate" : "awaiting-review",
          candidateAttempt: prior.candidateAttempt,
          reviewRound: prior.reviewRound,
          candidateEventId: prior.candidateEventId,
          ...(prior.reviewEventId ? { reviewEventId: prior.reviewEventId } : {}),
          reviewedPlan: prior.reviewedPlan,
        };
      }
      {
        const prior = implementation(current);
        return {
          ...base,
          ...implementationIdentity(prior),
          phase: "implementation",
          status: event.data.decision === "revise" ? "awaiting-candidate" : "awaiting-review",
          candidateAttempt: prior.candidateAttempt,
          reviewRound: prior.reviewRound,
          candidateEventId: prior.candidateEventId,
          ...(prior.reviewEventId ? { reviewEventId: prior.reviewEventId } : {}),
          reviewedHead: prior.reviewedHead,
        };
      }
    case "plan_pr.opened": {
      const prior = planning(current);
      return {
        ...base,
        ...prior,
        status: "awaiting-plan-merge",
        lastEventId: event.id,
        updatedAt: event.occurredAt,
        planPrUrl: event.data.url,
        planPrHead: event.data.head,
      };
    }
    case "plan_pr.merged": {
      const prior = planning(current);
      return {
        ...base,
        ...prior,
        status: "approved",
        lastEventId: event.id,
        updatedAt: event.occurredAt,
        planPrUrl: event.data.url,
        planMergeCommit: event.data.commit,
      };
    }
    case "implementation_pr.opened": {
      const prior = implementation(current);
      return {
        ...base,
        ...prior,
        status: "awaiting-pr-merge",
        lastEventId: event.id,
        updatedAt: event.occurredAt,
        implementationPrUrl: event.data.url,
        implementationPrHead: event.data.head,
      };
    }
    case "implementation_pr.merged": {
      const prior = implementation(current);
      return {
        ...base,
        ...prior,
        status: "complete",
        lastEventId: event.id,
        updatedAt: event.occurredAt,
        implementationPrUrl: event.data.url,
        implementationMergeCommit: event.data.commit,
      };
    }
    case "factory.action.failed":
      return reduceFailure(base, current, event);
  }
}

function reduceFailure(
  base: Omit<FactoryLifecycleState, "phase" | "status">,
  current: FactoryLifecycleState | undefined,
  event: Extract<FactoryLifecycleEvent, { type: "factory.action.failed" }>,
): FactoryLifecycleState {
  if (!current || current.phase === "idle")
    throw new Error("factory.action.failed requires an active Factory phase");
  if (current.phase === "triage")
    return {
      ...base,
      phase: "triage",
      status:
        event.data.failureKind === "retryable"
          ? "awaiting-result"
          : event.data.failureKind === "terminal"
            ? "failed"
            : "needs-human",
      phaseRunId: event.phaseRunId,
    };
  const retained =
    event.data.retainedCandidateEventId !== undefined &&
    event.data.retainedCandidateEventId === current.candidateEventId;
  const status =
    event.data.failureKind === "retryable"
      ? event.data.handler.startsWith("produce")
        ? "awaiting-candidate"
        : "awaiting-review"
      : retained
        ? "awaiting-continuation"
        : event.data.failureKind === "terminal"
          ? "failed"
          : "needs-human";
  if (current.phase === "planning")
    return {
      ...base,
      ...planningIdentity(current),
      phase: "planning",
      status,
      candidateAttempt: current.candidateAttempt,
      reviewRound: current.reviewRound,
      ...(event.data.failureKind === "retryable" || retained
        ? {
            ...(current.candidateEventId ? { candidateEventId: current.candidateEventId } : {}),
            ...(current.reviewEventId ? { reviewEventId: current.reviewEventId } : {}),
            ...(current.reviewedPlan ? { reviewedPlan: current.reviewedPlan } : {}),
          }
        : {}),
    };
  return {
    ...base,
    ...implementationIdentity(current),
    phase: "implementation",
    status,
    candidateAttempt: current.candidateAttempt,
    reviewRound: current.reviewRound,
    ...(event.data.failureKind === "retryable" || retained
      ? {
          ...(current.candidateEventId ? { candidateEventId: current.candidateEventId } : {}),
          ...(current.reviewEventId ? { reviewEventId: current.reviewEventId } : {}),
          ...(current.reviewedHead ? { reviewedHead: current.reviewedHead } : {}),
        }
      : {}),
  };
}

function validateFactoryTransition(
  current: FactoryLifecycleState | undefined,
  event: FactoryLifecycleEvent,
): void {
  if (event.type === "work_item.imported") {
    if (current) throw new Error("work_item.imported must be the first Factory event");
    return;
  }
  if (!current) throw new Error(`${event.type} requires an imported work item`);
  if ("expectedPredecessor" in event.data && event.data.expectedPredecessor !== current.lastEventId)
    throw new Error(`${event.type} expected predecessor does not match the Factory cursor`);
  if ("causationEventId" in event.data && event.data.causationEventId !== current.lastEventId)
    throw new Error(`${event.type} causation does not match the Factory cursor`);
  if ("phaseRunId" in current && event.phaseRunId && current.phaseRunId !== event.phaseRunId) {
    if (!event.type.endsWith(".requested"))
      throw new Error(`${event.type} phase run does not match active state`);
  }
  const allowed = transitionAllowed(current, event);
  if (!allowed)
    throw new Error(
      `Invalid Factory transition: ${current.phase}/${current.status} -> ${event.type}`,
    );
}

function transitionAllowed(current: FactoryLifecycleState, event: FactoryLifecycleEvent): boolean {
  switch (event.type) {
    case "triage.requested":
      if (current.phase === "idle") return event.data.intent === "start";
      return (
        current.phase === "triage" &&
        ["routed", "parked", "needs-human", "failed"].includes(current.status) &&
        event.data.intent === "restart" &&
        event.phaseRunId !== current.phaseRunId
      );
    case "triage.work_item.completed":
      return (
        current.phase === "triage" &&
        current.status === "awaiting-result" &&
        event.data.handler === "triageWorkItem" &&
        event.data.attempt === 1
      );
    case "planning.requested":
      if (event.data.intent === "start")
        return (
          (current.phase === "idle" ||
            (current.phase === "triage" &&
              current.status === "routed" &&
              current.route === "ready-to-plan")) &&
          (!("phaseRunId" in current) || event.phaseRunId !== current.phaseRunId)
        );
      return (
        current.phase === "planning" &&
        (current.status === "needs-human" || current.status === "failed") &&
        !current.candidateEventId &&
        event.phaseRunId !== current.phaseRunId
      );
    case "planning.candidate.produced":
      return candidateAllowed(current, event.data.handler, event.data.attempt, "planning");
    case "planning.input.required":
      return candidateAllowed(current, event.data.handler, event.data.attempt, "planning");
    case "planning.review.completed":
      return reviewAllowed(current, event, "planning");
    case "implementation.requested":
      if (event.data.intent === "start")
        return (
          "phaseRunId" in current &&
          event.phaseRunId !== current.phaseRunId &&
          ((current.phase === "triage" &&
            current.status === "routed" &&
            current.route === "ready-to-implement") ||
            (current.phase === "planning" && current.status === "approved"))
        );
      return (
        current.phase === "implementation" &&
        (current.status === "needs-human" || current.status === "failed") &&
        !current.candidateEventId &&
        event.phaseRunId !== current.phaseRunId
      );
    case "implementation.candidate.produced":
      return candidateAllowed(current, event.data.handler, event.data.attempt, "implementation");
    case "implementation.review.completed":
      return reviewAllowed(current, event, "implementation");
    case "factory.continuation.recorded":
      return continuationAllowed(current, event);
    case "plan_pr.opened":
      return (
        current.phase === "planning" &&
        current.status === "awaiting-plan-publication" &&
        current.planPrUrl === undefined &&
        JSON.stringify(current.reviewedPlan) === JSON.stringify(event.data.plan)
      );
    case "plan_pr.merged":
      return (
        current.phase === "planning" &&
        current.status === "awaiting-plan-merge" &&
        current.planPrUrl === event.data.url
      );
    case "implementation_pr.opened":
      return (
        current.phase === "implementation" &&
        current.status === "awaiting-pr-publication" &&
        current.reviewedHead === event.data.head &&
        current.implementationPrUrl === undefined
      );
    case "implementation_pr.merged":
      return (
        current.phase === "implementation" &&
        current.status === "awaiting-pr-merge" &&
        current.implementationPrUrl === event.data.url
      );
    case "factory.action.failed":
      return failureAllowed(current, event);
  }
  return false;
}

function candidateAllowed(
  current: FactoryLifecycleState,
  handler: FactoryHandler,
  attempt: number,
  phase: "planning" | "implementation",
): boolean {
  return (
    current.phase === phase &&
    current.status === "awaiting-candidate" &&
    handler ===
      (phase === "planning" ? "producePlanCandidate" : "produceImplementationCandidate") &&
    attempt === current.candidateAttempt + 1
  );
}

function reviewAllowed(
  current: FactoryLifecycleState,
  event: Extract<
    FactoryLifecycleEvent,
    { type: "planning.review.completed" | "implementation.review.completed" }
  >,
  phase: "planning" | "implementation",
): boolean {
  return (
    current.phase === phase &&
    current.status === "awaiting-review" &&
    event.data.handler ===
      (phase === "planning" ? "reviewPlanCandidate" : "reviewImplementationCandidate") &&
    event.data.attempt === current.reviewRound + 1 &&
    event.data.candidateEventId === current.candidateEventId &&
    event.data.candidateAttempt === current.candidateAttempt &&
    (event.data.verdict !== "needs_changes" || event.data.blockingFindings !== undefined)
  );
}

function continuationAllowed(
  current: FactoryLifecycleState,
  event: Extract<FactoryLifecycleEvent, { type: "factory.continuation.recorded" }>,
): boolean {
  if (
    current.phase !== event.data.phase ||
    (current.phase !== "planning" && current.phase !== "implementation") ||
    current.candidateEventId !== event.data.candidateEventId
  )
    return false;
  if (current.status === "awaiting-review")
    return (
      event.data.decision === "revise" &&
      event.data.reviewEventId === undefined &&
      current.lastEventId === current.candidateEventId
    );
  if (current.status !== "awaiting-continuation") return false;
  return current.reviewEventId
    ? event.data.reviewEventId === current.reviewEventId
    : event.data.reviewEventId === undefined;
}

function failureAllowed(
  current: FactoryLifecycleState,
  event: Extract<FactoryLifecycleEvent, { type: "factory.action.failed" }>,
): boolean {
  if (event.data.phase !== current.phase) return false;
  if (
    event.data.retainedCandidateEventId !== undefined &&
    (current.phase === "triage" || event.data.retainedCandidateEventId !== current.candidateEventId)
  )
    return false;
  if (current.phase === "triage")
    return (
      current.status === "awaiting-result" &&
      event.data.handler === "triageWorkItem" &&
      event.data.attempt === 1
    );
  if (event.data.handler.startsWith("produce"))
    return (
      current.status === "awaiting-candidate" && event.data.attempt === current.candidateAttempt + 1
    );
  return current.status === "awaiting-review" && event.data.attempt === current.reviewRound + 1;
}

export function decideNextFactoryAction(
  state: FactoryLifecycleState,
  latestEvent: FactoryLifecycleEvent,
): FactoryReaction {
  if (state.lastEventId !== latestEvent.id) return { kind: "wait", reason: "stale-event" };
  if (latestEvent.type === "work_item.imported") return startPhase("triage", latestEvent);
  if (
    latestEvent.type === "triage.work_item.completed" &&
    latestEvent.data.route === "ready-to-plan"
  )
    return startPhase("planning", latestEvent);
  if (
    latestEvent.type === "triage.work_item.completed" &&
    latestEvent.data.route === "ready-to-implement"
  )
    return startPhase("implementation", latestEvent);
  if (
    latestEvent.type === "planning.review.completed" &&
    latestEvent.data.verdict === "pass" &&
    state.phase === "planning" &&
    state.status === "approved"
  )
    return startPhase("implementation", latestEvent);
  if (latestEvent.type === "plan_pr.merged") return startPhase("implementation", latestEvent);
  if (latestEvent.type === "triage.requested")
    return invoke("triage", "triageWorkItem", 1, latestEvent.id, "triage-requested");
  if (latestEvent.type === "planning.requested")
    return invoke("planning", "producePlanCandidate", 1, latestEvent.id, "planning-requested");
  if (latestEvent.type === "implementation.requested")
    return invoke(
      "implementation",
      "produceImplementationCandidate",
      1,
      latestEvent.id,
      "implementation-requested",
    );
  if (latestEvent.type === "planning.candidate.produced")
    return invoke(
      "planning",
      "reviewPlanCandidate",
      planning(state).reviewRound + 1,
      latestEvent.id,
      "candidate-produced",
    );
  if (latestEvent.type === "implementation.candidate.produced")
    return invoke(
      "implementation",
      "reviewImplementationCandidate",
      implementation(state).reviewRound + 1,
      latestEvent.id,
      "candidate-produced",
    );
  if (latestEvent.type === "factory.continuation.recorded") {
    if (latestEvent.data.decision === "revise")
      return invoke(
        latestEvent.data.phase,
        latestEvent.data.phase === "planning"
          ? "producePlanCandidate"
          : "produceImplementationCandidate",
        state.phase === "planning" || state.phase === "implementation"
          ? state.candidateAttempt + 1
          : 1,
        latestEvent.id,
        "operator-revise",
      );
    return invoke(
      latestEvent.data.phase,
      latestEvent.data.phase === "planning"
        ? "reviewPlanCandidate"
        : "reviewImplementationCandidate",
      state.phase === "planning" || state.phase === "implementation" ? state.reviewRound + 1 : 1,
      latestEvent.id,
      "operator-re-review",
    );
  }
  if (latestEvent.type === "factory.action.failed" && latestEvent.data.failureKind === "retryable")
    return {
      ...invoke(
        latestEvent.data.phase,
        latestEvent.data.handler,
        latestEvent.data.attempt,
        latestEvent.id,
        "retryable-failure",
      ),
      scheduling: "retry",
    };
  if (state.status === "failed") return { kind: "wait", reason: "failed" };
  if (
    state.status === "needs-human" ||
    state.status === "parked" ||
    state.status === "awaiting-continuation"
  )
    return { kind: "wait", reason: "human" };
  if (state.phase === "planning" && state.status === "awaiting-plan-merge")
    return { kind: "wait", reason: "plan-merge" };
  if (state.phase === "planning" && state.status === "awaiting-plan-publication")
    return { kind: "wait", reason: "plan-publication" };
  if (state.phase === "implementation" && state.status === "awaiting-pr-publication")
    return { kind: "wait", reason: "pr-publication" };
  if (state.phase === "implementation" && state.status === "awaiting-pr-merge")
    return { kind: "wait", reason: "pr-merge" };
  if (state.status === "complete") return { kind: "wait", reason: "complete" };
  throw new Error(
    `Factory state ${state.phase}/${state.status} has no reaction for ${latestEvent.type}`,
  );
}

function startPhase(
  phase: FactoryPhase,
  event: FactoryPhaseStartEvent,
): Extract<FactoryReaction, { kind: "start-phase" }> {
  return { kind: "start-phase", phase, event };
}

function invoke(
  phase: FactoryPhase,
  handler: FactoryHandler,
  attempt: number,
  causationEventId: string,
  reason: string,
): Extract<FactoryReaction, { kind: "invoke" }> {
  return {
    kind: "invoke",
    phase,
    handler,
    attempt,
    causationEventId,
    scheduling: "immediate",
    reason,
  };
}

function planning(state: FactoryLifecycleState | undefined) {
  if (state?.phase !== "planning") throw new Error("Factory planning state is unavailable");
  return state;
}

function implementation(state: FactoryLifecycleState | undefined) {
  if (state?.phase !== "implementation")
    throw new Error("Factory implementation state is unavailable");
  return state;
}

function planningIdentity(state: ReturnType<typeof planning>) {
  return {
    phaseRunId: state.phaseRunId,
    publicationMode: state.publicationMode,
    outputPlan: state.outputPlan,
    ...(state.planPrUrl ? { planPrUrl: state.planPrUrl } : {}),
    ...(state.planPrHead ? { planPrHead: state.planPrHead } : {}),
    ...(state.planMergeCommit ? { planMergeCommit: state.planMergeCommit } : {}),
  };
}

function implementationIdentity(state: ReturnType<typeof implementation>) {
  return {
    phaseRunId: state.phaseRunId,
    ...(state.implementationPrUrl ? { implementationPrUrl: state.implementationPrUrl } : {}),
    ...(state.implementationPrHead ? { implementationPrHead: state.implementationPrHead } : {}),
    ...(state.implementationMergeCommit
      ? { implementationMergeCommit: state.implementationMergeCommit }
      : {}),
  };
}
