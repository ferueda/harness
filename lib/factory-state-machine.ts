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
const PhaseState = Common.extend({
  phaseRunId: FactoryPhaseRunIdSchema,
});
const ReviewState = PhaseState.extend({
  reviewCeiling: z.number().int().positive(),
  attempt: z.number().int().positive(),
});
const PlanningState = ReviewState.extend({
  publicationMode: z.enum(["local", "pull-request"]),
  outputPlan: z.string().min(1),
  reviewedPlan: FactoryArtifactRefSchema.optional(),
  planPrHead: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  planMergeCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});
export const FactoryLifecycleStateSchema = z.union([
  Common.extend({ phase: z.literal("idle"), status: z.literal("idle") }),
  PhaseState.extend({
    phase: z.literal("triage"),
    status: z.literal("awaiting-result"),
  }),
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
    planPrUrl: z.url().optional(),
    status: z.enum([
      "awaiting-candidate",
      "awaiting-review",
      "needs-revision",
      "needs-human",
      "awaiting-plan-publication",
      "awaiting-plan-merge",
      "approved",
      "failed",
    ]),
  }),
  ReviewState.extend({
    phase: z.literal("implementation"),
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
    status: z.enum([
      "awaiting-candidate",
      "awaiting-review",
      "needs-revision",
      "needs-human",
      "awaiting-pr-publication",
      "awaiting-pr-merge",
      "complete",
      "failed",
    ]),
  }),
]);
export type FactoryLifecycleState = z.infer<typeof FactoryLifecycleStateSchema>;

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
      kind: "wait";
      reason:
        | "phase-command"
        | "human"
        | "plan-publication"
        | "plan-merge"
        | "pr-publication"
        | "pr-merge"
        | "complete"
        | "failed"
        | "stale-event";
      command?: string;
    };

export function reduceFactoryLifecycleEvents(
  events: readonly FactoryLifecycleEvent[],
): FactoryLifecycleState | undefined {
  let state: FactoryLifecycleState | undefined;
  for (const [index, event] of events.entries()) {
    state = reduce(state, event, {
      allowMaterializedUnguidedRestartReplay: isMaterializedUnguidedRestart(
        event,
        events[index + 1],
      ),
    });
  }
  return state;
}

function reduce(
  current: FactoryLifecycleState | undefined,
  event: FactoryLifecycleEvent,
  options: { allowMaterializedUnguidedRestartReplay: boolean },
): FactoryLifecycleState {
  const base = {
    projectionVersion: 1 as const,
    workItemKey: event.workItemKey,
    lastEventId: event.id,
    updatedAt: event.occurredAt,
  };
  if (current && current.workItemKey !== event.workItemKey)
    throw new Error("Factory event work-item mismatch");
  validateFactoryTransition(current, event, options);
  switch (event.type) {
    case "work_item.imported":
      return { ...base, phase: "idle", status: "idle" };
    case "triage.requested":
      return { ...base, phase: "triage", status: "awaiting-result", phaseRunId: event.phaseRunId };
    case "triage.work_item.completed": {
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
    }
    case "planning.requested":
      return {
        ...base,
        phase: "planning",
        status: "awaiting-candidate",
        phaseRunId: event.phaseRunId,
        reviewCeiling: event.data.reviewCeiling,
        attempt: 1,
        publicationMode: event.data.publicationMode,
        outputPlan: event.data.outputPlan,
      };
    case "planning.candidate.produced":
      return {
        ...base,
        phase: "planning",
        status: "awaiting-review",
        phaseRunId: event.phaseRunId,
        reviewCeiling: current!.phase === "planning" ? current!.reviewCeiling : 1,
        attempt: event.data.attempt,
        publicationMode: current!.phase === "planning" ? current!.publicationMode : "local",
        outputPlan: current!.phase === "planning" ? current!.outputPlan : "dev/plans/plan.md",
        reviewedPlan: event.data.candidate,
      };
    case "planning.input.required":
      return {
        ...base,
        phase: "planning",
        status: "needs-human",
        phaseRunId: event.phaseRunId,
        reviewCeiling: current!.phase === "planning" ? current!.reviewCeiling : 1,
        attempt: event.data.attempt,
        publicationMode: current!.phase === "planning" ? current!.publicationMode : "local",
        outputPlan: current!.phase === "planning" ? current!.outputPlan : "dev/plans/plan.md",
      };
    case "planning.review.completed":
      return {
        ...base,
        phase: "planning",
        status:
          event.data.verdict === "pass"
            ? current!.phase === "planning" && current!.publicationMode === "local"
              ? "approved"
              : "awaiting-plan-publication"
            : event.data.verdict === "needs_changes" &&
                event.data.attempt < event.data.reviewCeiling
              ? "needs-revision"
              : "needs-human",
        phaseRunId: event.phaseRunId,
        reviewCeiling:
          current!.phase === "planning" ? current!.reviewCeiling : event.data.reviewCeiling,
        attempt: event.data.attempt,
        publicationMode: current!.phase === "planning" ? current!.publicationMode : "local",
        outputPlan: current!.phase === "planning" ? current!.outputPlan : "dev/plans/plan.md",
        reviewedPlan: current!.phase === "planning" ? current!.reviewedPlan : undefined,
      };
    case "plan_pr.opened":
      return {
        ...base,
        phase: "planning",
        status: "awaiting-plan-merge",
        phaseRunId: event.phaseRunId,
        reviewCeiling: current!.phase === "planning" ? current!.reviewCeiling : 1,
        attempt: current!.phase === "planning" ? current!.attempt : 1,
        publicationMode: current!.phase === "planning" ? current!.publicationMode : "pull-request",
        outputPlan: current!.phase === "planning" ? current!.outputPlan : "dev/plans/plan.md",
        reviewedPlan: current!.phase === "planning" ? current!.reviewedPlan : event.data.plan,
        planPrUrl: event.data.url,
        planPrHead: event.data.head,
      };
    case "plan_pr.merged":
      return {
        ...base,
        phase: "planning",
        status: "approved",
        phaseRunId: event.phaseRunId,
        reviewCeiling: current!.phase === "planning" ? current!.reviewCeiling : 1,
        attempt: current!.phase === "planning" ? current!.attempt : 1,
        publicationMode: current!.phase === "planning" ? current!.publicationMode : "pull-request",
        outputPlan: current!.phase === "planning" ? current!.outputPlan : "dev/plans/plan.md",
        reviewedPlan: current!.phase === "planning" ? current!.reviewedPlan : undefined,
        planPrUrl: event.data.url,
        planPrHead: current!.phase === "planning" ? current!.planPrHead : undefined,
        planMergeCommit: event.data.commit,
      };
    case "implementation.requested":
      return {
        ...base,
        phase: "implementation",
        status: "awaiting-candidate",
        phaseRunId: event.phaseRunId,
        reviewCeiling: event.data.reviewCeiling,
        attempt: 1,
      };
    case "implementation.candidate.produced":
      return {
        ...base,
        phase: "implementation",
        status: "awaiting-review",
        phaseRunId: event.phaseRunId,
        reviewCeiling: current!.phase === "implementation" ? current!.reviewCeiling : 1,
        attempt: event.data.attempt,
        reviewedHead: event.data.commit,
      };
    case "implementation.review.completed":
      return {
        ...base,
        phase: "implementation",
        status:
          event.data.verdict === "pass"
            ? "awaiting-pr-publication"
            : event.data.verdict === "needs_changes" &&
                event.data.attempt < event.data.reviewCeiling
              ? "needs-revision"
              : "needs-human",
        phaseRunId: event.phaseRunId,
        reviewCeiling:
          current!.phase === "implementation" ? current!.reviewCeiling : event.data.reviewCeiling,
        attempt: event.data.attempt,
        reviewedHead: current!.phase === "implementation" ? current!.reviewedHead : undefined,
      };
    case "implementation_pr.opened":
      return {
        ...base,
        phase: "implementation",
        status: "awaiting-pr-merge",
        phaseRunId: event.phaseRunId,
        reviewCeiling: current!.phase === "implementation" ? current!.reviewCeiling : 1,
        attempt: current!.phase === "implementation" ? current!.attempt : 1,
        reviewedHead: current!.phase === "implementation" ? current!.reviewedHead : event.data.head,
        implementationPrUrl: event.data.url,
        implementationPrHead: event.data.head,
      };
    case "implementation_pr.merged":
      return {
        ...base,
        phase: "implementation",
        status: "complete",
        phaseRunId: event.phaseRunId,
        reviewCeiling: current!.phase === "implementation" ? current!.reviewCeiling : 1,
        attempt: current!.phase === "implementation" ? current!.attempt : 1,
        reviewedHead: current!.phase === "implementation" ? current!.reviewedHead : undefined,
        implementationPrUrl: event.data.url,
        implementationPrHead:
          current!.phase === "implementation" ? current!.implementationPrHead : undefined,
        implementationMergeCommit: event.data.commit,
      };
    case "factory.action.failed":
      if (!current) throw new Error("factory.action.failed requires an active Factory phase");
      if (current.phase === "triage") {
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
      }
      if (current.phase !== "planning" && current.phase !== "implementation")
        throw new Error("factory.action.failed requires an active Factory phase");
      if (event.data.failureKind === "retryable") {
        if (current.phase === "planning")
          return {
            ...base,
            phase: "planning",
            status: event.data.handler.startsWith("produce")
              ? "awaiting-candidate"
              : "awaiting-review",
            phaseRunId: event.phaseRunId,
            reviewCeiling: current.reviewCeiling,
            attempt: event.data.attempt,
            publicationMode: current.publicationMode,
            outputPlan: current.outputPlan,
            reviewedPlan: current.reviewedPlan,
            planPrUrl: current.planPrUrl,
            planPrHead: current.planPrHead,
            planMergeCommit: current.planMergeCommit,
          };
        const failedState = {
          ...base,
          phase: current.phase,
          status: (event.data.handler.startsWith("produce")
            ? "awaiting-candidate"
            : "awaiting-review") as "awaiting-candidate" | "awaiting-review",
          phaseRunId: event.phaseRunId,
          reviewCeiling: current.reviewCeiling,
          attempt: event.data.attempt,
          reviewedHead: current.reviewedHead,
          implementationPrUrl: current.implementationPrUrl,
          implementationPrHead: current.implementationPrHead,
          implementationMergeCommit: current.implementationMergeCommit,
        };
        return failedState;
      }
      if (current.phase === "planning")
        return {
          ...base,
          phase: "planning",
          status: (event.data.failureKind === "terminal" ? "failed" : "needs-human") as
            | "failed"
            | "needs-human",
          phaseRunId: event.phaseRunId,
          reviewCeiling: current.reviewCeiling,
          attempt: event.data.attempt,
          publicationMode: current.publicationMode,
          outputPlan: current.outputPlan,
        };
      const failedState = {
        ...base,
        phase: "implementation" as const,
        status: (event.data.failureKind === "terminal" ? "failed" : "needs-human") as
          | "failed"
          | "needs-human",
        phaseRunId: event.phaseRunId,
        reviewCeiling: current.reviewCeiling,
        attempt: event.data.attempt,
      };
      return failedState;
  }
}

function validateFactoryTransition(
  current: FactoryLifecycleState | undefined,
  event: FactoryLifecycleEvent,
  options: { allowMaterializedUnguidedRestartReplay: boolean },
): void {
  if (event.type === "work_item.imported") {
    if (current) throw new Error("work_item.imported must be the first Factory event");
    return;
  }
  if (!current) throw new Error(`${event.type} requires an imported work item`);
  if (
    "expectedPredecessor" in event.data &&
    event.data.expectedPredecessor !== current.lastEventId
  ) {
    throw new Error(`${event.type} expected predecessor does not match the Factory cursor`);
  }
  if ("causationEventId" in event.data && event.data.causationEventId !== current.lastEventId) {
    throw new Error(`${event.type} causation does not match the Factory cursor`);
  }
  if ("phaseRunId" in current && event.phaseRunId && current.phaseRunId !== event.phaseRunId) {
    const startsPhase = event.type.endsWith(".requested");
    if (!startsPhase) throw new Error(`${event.type} phase run does not match active state`);
  }
  const allowed = (() => {
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
          event.phaseRunId !== current.phaseRunId
        );
      case "planning.candidate.produced":
        return (
          current.phase === "planning" &&
          (current.status === "awaiting-candidate" || current.status === "needs-revision") &&
          event.data.attempt ===
            (current.status === "needs-revision" ? current.attempt + 1 : current.attempt) &&
          event.data.handler === "producePlanCandidate"
        );
      case "planning.input.required":
        return (
          current.phase === "planning" &&
          (current.status === "awaiting-candidate" || current.status === "needs-revision") &&
          event.data.attempt ===
            (current.status === "needs-revision" ? current.attempt + 1 : current.attempt) &&
          event.data.handler === "producePlanCandidate"
        );
      case "planning.review.completed":
        return (
          current.phase === "planning" &&
          current.status === "awaiting-review" &&
          event.data.attempt === current.attempt &&
          event.data.reviewCeiling === current.reviewCeiling &&
          (event.data.verdict !== "needs_changes" || event.data.blockingFindings !== undefined) &&
          event.data.handler === "reviewPlanCandidate"
        );
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
        if (current.phase !== "implementation" || event.phaseRunId === current.phaseRunId)
          return false;
        if (current.status === "awaiting-review")
          return (
            event.data.restartGuidance !== undefined ||
            options.allowMaterializedUnguidedRestartReplay
          );
        return (
          (current.status === "needs-human" || current.status === "failed") &&
          event.data.restartGuidance === undefined
        );
      case "implementation.candidate.produced":
        return (
          current.phase === "implementation" &&
          (current.status === "awaiting-candidate" || current.status === "needs-revision") &&
          event.data.attempt ===
            (current.status === "needs-revision" ? current.attempt + 1 : current.attempt) &&
          event.data.handler === "produceImplementationCandidate"
        );
      case "implementation.review.completed":
        return (
          current.phase === "implementation" &&
          current.status === "awaiting-review" &&
          event.data.attempt === current.attempt &&
          event.data.reviewCeiling === current.reviewCeiling &&
          (event.data.verdict !== "needs_changes" || event.data.blockingFindings !== undefined) &&
          event.data.handler === "reviewImplementationCandidate"
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
        if (event.data.phase !== current.phase) return false;
        if (current.phase === "triage")
          return (
            current.status === "awaiting-result" &&
            event.data.handler === "triageWorkItem" &&
            event.data.attempt === 1
          );
        if (current.phase === "planning") {
          if (event.data.handler === "producePlanCandidate")
            return (
              (current.status === "awaiting-candidate" && event.data.attempt === current.attempt) ||
              (current.status === "needs-revision" && event.data.attempt === current.attempt + 1)
            );
          return (
            event.data.handler === "reviewPlanCandidate" &&
            current.status === "awaiting-review" &&
            event.data.attempt === current.attempt
          );
        }
        if (event.data.handler === "produceImplementationCandidate")
          return (
            (current.status === "awaiting-candidate" && event.data.attempt === current.attempt) ||
            (current.status === "needs-revision" && event.data.attempt === current.attempt + 1)
          );
        return (
          event.data.handler === "reviewImplementationCandidate" &&
          current.status === "awaiting-review" &&
          event.data.attempt === current.attempt
        );
    }
  })();
  if (!allowed)
    throw new Error(
      `Invalid Factory transition: ${current.phase}/${current.status} -> ${event.type}`,
    );
}

function isMaterializedUnguidedRestart(
  event: FactoryLifecycleEvent,
  next: FactoryLifecycleEvent | undefined,
): boolean {
  if (
    event.type !== "implementation.requested" ||
    event.data.intent !== "restart" ||
    event.data.restartGuidance !== undefined
  )
    return false;
  // Completed pre-guidance restarts remain replayable; a new request alone still fails closed.
  return (
    next?.type === "implementation.candidate.produced" &&
    next.workItemKey === event.workItemKey &&
    next.phaseRunId === event.phaseRunId &&
    next.data.handler === "produceImplementationCandidate" &&
    next.data.attempt === 1 &&
    next.data.causationEventId === event.id
  );
}

export function decideNextFactoryAction(
  state: FactoryLifecycleState,
  latestEvent: FactoryLifecycleEvent,
): FactoryReaction {
  if (state.lastEventId !== latestEvent.id) return { kind: "wait", reason: "stale-event" };
  if (latestEvent.type === "triage.requested")
    return {
      kind: "invoke",
      phase: "triage",
      handler: "triageWorkItem",
      attempt: 1,
      causationEventId: latestEvent.id,
      scheduling: "immediate",
      reason: "triage-requested",
    };
  if (
    latestEvent.type === "planning.requested" ||
    (latestEvent.type === "planning.review.completed" && state.status === "needs-revision")
  )
    return {
      kind: "invoke",
      phase: "planning",
      handler: "producePlanCandidate",
      attempt: latestEvent.type === "planning.requested" ? 1 : latestEvent.data.attempt + 1,
      causationEventId: latestEvent.id,
      scheduling: "immediate",
      reason:
        latestEvent.type === "planning.requested" ? "planning-requested" : "review-needs-changes",
    };
  if (latestEvent.type === "planning.candidate.produced")
    return {
      kind: "invoke",
      phase: "planning",
      handler: "reviewPlanCandidate",
      attempt: latestEvent.data.attempt,
      causationEventId: latestEvent.id,
      scheduling: "immediate",
      reason: "candidate-produced",
    };
  if (
    latestEvent.type === "implementation.requested" ||
    (latestEvent.type === "implementation.review.completed" && state.status === "needs-revision")
  )
    return {
      kind: "invoke",
      phase: "implementation",
      handler: "produceImplementationCandidate",
      attempt: latestEvent.type === "implementation.requested" ? 1 : latestEvent.data.attempt + 1,
      causationEventId: latestEvent.id,
      scheduling: "immediate",
      reason:
        latestEvent.type === "implementation.requested"
          ? "implementation-requested"
          : "review-needs-changes",
    };
  if (latestEvent.type === "implementation.candidate.produced")
    return {
      kind: "invoke",
      phase: "implementation",
      handler: "reviewImplementationCandidate",
      attempt: latestEvent.data.attempt,
      causationEventId: latestEvent.id,
      scheduling: "immediate",
      reason: "candidate-produced",
    };
  if (latestEvent.type === "factory.action.failed" && latestEvent.data.failureKind === "retryable")
    return {
      kind: "invoke",
      phase: latestEvent.data.phase,
      handler: latestEvent.data.handler,
      attempt: latestEvent.data.attempt,
      causationEventId: latestEvent.id,
      scheduling: "retry",
      reason: "retryable-failure",
    };
  if (state.status === "failed") return { kind: "wait", reason: "failed" };
  if (state.status === "needs-human" || state.status === "parked")
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
  return {
    kind: "wait",
    reason: "phase-command",
    ...(latestEvent.type === "triage.work_item.completed"
      ? latestEvent.data.nextCommand
        ? { command: latestEvent.data.nextCommand }
        : {}
      : {}),
  };
}
