import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Agent, AgentProviderOptions } from "./agents.ts";
import {
  factoryActionKey,
  FactoryHandlerSchema,
  FactoryPhaseRunIdSchema,
  type FactoryHandler,
  type FactoryPhase,
} from "./factory-action-contract.ts";
import { factoryActionResultPath, readFactoryActionResult } from "./factory-action-result.ts";
import { readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryActionEvent } from "./factory-lifecycle-events.ts";
import { produceImplementationCandidate } from "./factory-implementation-candidate-action.ts";
import { reviewImplementationCandidate } from "./factory-implementation-review-action.ts";
import { openFactoryImplementationRunContext } from "./factory-implementation-run-context.ts";
import { producePlanCandidate } from "./factory-plan-candidate-action.ts";
import { reviewPlanCandidate } from "./factory-plan-review-action.ts";
import { openFactoryPlanningRunContext } from "./factory-planning-run-context.ts";
import { readFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { openFactoryRunContext, type FactoryRunMeta } from "./factory-run-context.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";
import type { WorkflowEventSink } from "./workflow-events.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryReaction,
} from "./factory-state-machine.ts";
import { triageWorkItem } from "../workflows/factory-triage.workflow.ts";

export const FactoryOperationRefSchema = z
  .object({
    phaseRunId: FactoryPhaseRunIdSchema,
    handler: FactoryHandlerSchema,
    attempt: z.number().int().positive(),
    causationEventId: z.string().min(1),
    actionKey: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type FactoryOperationRef = z.infer<typeof FactoryOperationRefSchema>;

type InvokeReaction = Extract<FactoryReaction, { kind: "invoke" }>;
type WaitReaction = Extract<FactoryReaction, { kind: "wait" }>;

export type FactoryOperationResolution =
  | { status: "completed"; operation: FactoryOperationRef; event: FactoryActionEvent }
  | { status: "current"; operation: FactoryOperationRef; reaction: InvokeReaction }
  | { status: "stale"; operation: FactoryOperationRef; reaction: InvokeReaction }
  | { status: "wait"; operation: FactoryOperationRef; reaction: WaitReaction };

export class FactoryOperationResolutionError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryOperationResolutionError";
  }
}

export type ExecuteFactoryOperationInput = {
  operation: FactoryOperationRef;
  factoryStore: FactoryStoreMeta;
  workspace: string;
  workItem: FactoryWorkItem;
  maxRuntimeMs: number;
  signal?: AbortSignal;
  eventSink?: WorkflowEventSink;
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
  triage?: {
    nextLiveRunRequiresRerun: boolean;
    runProvider?: Parameters<typeof triageWorkItem>[0]["runProvider"];
    onMeta?: (meta: FactoryRunMeta) => void;
  };
  planReviewRunner?: Parameters<typeof reviewPlanCandidate>[0]["reviewRunner"];
  implementationReviewRunner?: Parameters<typeof reviewImplementationCandidate>[0]["reviewRunner"];
  implementationReviewHeadFactory?: Parameters<
    typeof produceImplementationCandidate
  >[0]["reviewHeadFactory"];
};

/** Execute exactly one authenticated reaction against an existing Factory workspace. */
export async function executeFactoryOperation(input: ExecuteFactoryOperationInput) {
  const operation = authenticateOperationIdentity({
    projectId: input.factoryStore.projectId,
    projectRoot: input.factoryStore.projectRoot,
    factoryStateRoot: input.factoryStore.factoryStateRoot,
    workItemKey: deriveFactoryWorkItemKey(input.workItem),
    operation: input.operation,
    runsDir: input.factoryStore.factoryRunsDir,
  });
  const runsDir = input.factoryStore.factoryRunsDir;

  switch (operation.handler) {
    case "triageWorkItem": {
      if (!input.triage) {
        throw new FactoryOperationResolutionError("Factory triage runtime controls are required");
      }
      const ctx = openFactoryRunContext({
        workspace: input.workspace,
        runsDir,
        phaseRunId: operation.phaseRunId,
        workItem: input.workItem,
        factoryStore: input.factoryStore,
        maxRuntimeMs: input.maxRuntimeMs,
        signal: input.signal,
        eventSink: input.eventSink,
        agentProviderFactory: input.agentProviderFactory,
      });
      const reaction = requireCurrentInvoke(input.factoryStore, ctx.workItem, operation);
      return triageWorkItem({
        ctx,
        factoryStateRoot: input.factoryStore.factoryStateRoot,
        reaction,
        nextLiveRunRequiresRerun: input.triage.nextLiveRunRequiresRerun,
        runProvider: input.triage.runProvider,
        onMeta: input.triage.onMeta,
      });
    }
    case "producePlanCandidate": {
      const ctx = openFactoryPlanningRunContext({
        workspace: input.workspace,
        runsDir,
        phaseRunId: operation.phaseRunId,
        workItem: input.workItem,
        factoryStore: input.factoryStore,
        eventSink: input.eventSink,
      });
      const reaction = requireCurrentInvoke(input.factoryStore, ctx.workItem, operation);
      return producePlanCandidate({
        ctx,
        factoryStateRoot: input.factoryStore.factoryStateRoot,
        reaction,
        maxRuntimeMs: input.maxRuntimeMs,
        signal: input.signal,
        agentProviderFactory: input.agentProviderFactory,
      });
    }
    case "reviewPlanCandidate": {
      const ctx = openFactoryPlanningRunContext({
        workspace: input.workspace,
        runsDir,
        phaseRunId: operation.phaseRunId,
        workItem: input.workItem,
        factoryStore: input.factoryStore,
        eventSink: input.eventSink,
      });
      const reaction = requireCurrentInvoke(input.factoryStore, ctx.workItem, operation);
      return reviewPlanCandidate({
        ctx,
        factoryStateRoot: input.factoryStore.factoryStateRoot,
        reaction,
        maxRuntimeMs: input.maxRuntimeMs,
        signal: input.signal,
        agentProviderFactory: input.agentProviderFactory,
        reviewRunner: input.planReviewRunner,
      });
    }
    case "produceImplementationCandidate": {
      const ctx = openFactoryImplementationRunContext({
        workspace: input.workspace,
        runsDir,
        phaseRunId: operation.phaseRunId,
        workItem: input.workItem,
        factoryStore: input.factoryStore,
        eventSink: input.eventSink,
      });
      const reaction = requireCurrentInvoke(input.factoryStore, ctx.workItem, operation);
      return produceImplementationCandidate({
        ctx,
        factoryStateRoot: input.factoryStore.factoryStateRoot,
        reaction,
        maxRuntimeMs: input.maxRuntimeMs,
        signal: input.signal,
        agentProviderFactory: input.agentProviderFactory,
        reviewHeadFactory: input.implementationReviewHeadFactory,
      });
    }
    case "reviewImplementationCandidate": {
      const ctx = openFactoryImplementationRunContext({
        workspace: input.workspace,
        runsDir,
        phaseRunId: operation.phaseRunId,
        workItem: input.workItem,
        factoryStore: input.factoryStore,
        eventSink: input.eventSink,
      });
      const reaction = requireCurrentInvoke(input.factoryStore, ctx.workItem, operation);
      return reviewImplementationCandidate({
        ctx,
        factoryStateRoot: input.factoryStore.factoryStateRoot,
        reaction,
        maxRuntimeMs: input.maxRuntimeMs,
        signal: input.signal,
        agentProviderFactory: input.agentProviderFactory,
        reviewRunner: input.implementationReviewRunner,
      });
    }
    default:
      return assertNever(operation.handler);
  }
}

export function createFactoryOperationRef(input: {
  phaseRunId: string;
  handler: FactoryHandler;
  attempt: number;
  causationEventId: string;
}): FactoryOperationRef {
  return FactoryOperationRefSchema.parse({
    ...input,
    actionKey: factoryActionKey(input),
  });
}

/** Resolve durable operation state without opening or inspecting its workspace. */
export function resolveFactoryOperation(input: {
  projectId: string;
  projectRoot: string;
  factoryStateRoot: string;
  workItemKey: string;
  operation: FactoryOperationRef;
}): FactoryOperationResolution {
  const operation = authenticateOperationIdentity(input);
  const projectRoot = resolve(input.projectRoot);
  const factoryStateRoot = resolve(input.factoryStateRoot);
  const runDir = join(projectRoot, "runs", "factory", operation.phaseRunId);

  const actionDir = join(
    runDir,
    "actions",
    String(operation.attempt),
    operation.handler,
    operation.actionKey,
  );
  if (existsSync(factoryActionResultPath(actionDir))) {
    const event = readResult(actionDir);
    assertCompletedIdentity(event, input.workItemKey, operation);
    return { status: "completed", operation, event };
  }

  const events = readFactoryActionEvents(factoryStateRoot, input.workItemKey, {
    mode: "inspection",
  });
  const latest = events.at(-1);
  const state = reduceFactoryLifecycleEvents(events);
  if (!latest || !state) {
    throw new FactoryOperationResolutionError("Factory operation has no durable lifecycle state");
  }
  const reaction = decideNextFactoryAction(state, latest);
  if (reaction.kind === "wait") return { status: "wait", operation, reaction };
  if (matchesReaction(operation, latest.phaseRunId, reaction)) {
    return { status: "current", operation, reaction };
  }
  return { status: "stale", operation, reaction };
}

function authenticateOperationIdentity(input: {
  projectId: string;
  projectRoot: string;
  factoryStateRoot: string;
  workItemKey: string;
  operation: FactoryOperationRef;
  runsDir?: string;
}): FactoryOperationRef {
  const operation = parseOperation(input.operation);
  if (operation.actionKey !== factoryActionKey(operation)) {
    throw new FactoryOperationResolutionError("Factory operation action identity mismatch");
  }
  const runDir = join(
    resolve(input.runsDir ?? join(input.projectRoot, "runs", "factory")),
    operation.phaseRunId,
  );
  const identity = readIdentity(runDir);
  if (
    identity.projectId !== input.projectId ||
    identity.workItemKey !== input.workItemKey ||
    identity.phaseRunId !== operation.phaseRunId ||
    resolve(identity.factoryStateRoot) !== resolve(input.factoryStateRoot) ||
    identity.phase !== handlerPhase(operation.handler)
  ) {
    throw new FactoryOperationResolutionError("Factory operation phase-run identity mismatch");
  }
  return operation;
}

function requireCurrentInvoke(
  factoryStore: FactoryStoreMeta,
  workItem: FactoryWorkItem,
  operation: FactoryOperationRef,
): InvokeReaction {
  const events = readFactoryActionEvents(
    factoryStore.factoryStateRoot,
    deriveFactoryWorkItemKey(workItem),
  );
  const latest = events.at(-1);
  const state = reduceFactoryLifecycleEvents(events);
  if (!latest || !state) {
    throw new FactoryOperationResolutionError("Factory operation has no durable lifecycle state");
  }
  const reaction = decideNextFactoryAction(state, latest);
  if (reaction.kind !== "invoke" || !matchesReaction(operation, latest.phaseRunId, reaction)) {
    throw new FactoryOperationResolutionError(
      reaction.kind === "wait"
        ? "Factory operation is waiting and cannot be invoked"
        : "Factory operation is stale and cannot be invoked",
    );
  }
  return reaction;
}

function parseOperation(value: FactoryOperationRef): FactoryOperationRef {
  const parsed = FactoryOperationRefSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new FactoryOperationResolutionError("Invalid Factory operation reference", {
    cause: parsed.error,
  });
}

function readIdentity(runDir: string): ReturnType<typeof readFactoryPhaseRunIdentity> {
  try {
    return readFactoryPhaseRunIdentity(runDir);
  } catch (error) {
    throw new FactoryOperationResolutionError(
      "Factory operation phase-run identity is unavailable",
      {
        cause: error,
      },
    );
  }
}

function readResult(actionDir: string): FactoryActionEvent {
  try {
    return readFactoryActionResult(actionDir);
  } catch (error) {
    throw new FactoryOperationResolutionError("Factory operation result failed authentication", {
      cause: error,
    });
  }
}

function assertCompletedIdentity(
  event: FactoryActionEvent,
  workItemKey: string,
  operation: FactoryOperationRef,
): void {
  if (
    event.workItemKey !== workItemKey ||
    event.phaseRunId !== operation.phaseRunId ||
    event.data.handler !== operation.handler ||
    event.data.attempt !== operation.attempt ||
    event.data.causationEventId !== operation.causationEventId ||
    !event.id.endsWith(`:${operation.actionKey}`)
  ) {
    throw new FactoryOperationResolutionError("Factory operation result identity mismatch");
  }
  if (!isTerminalResultForHandler(operation.handler, event)) {
    throw new FactoryOperationResolutionError(
      "Factory operation result type does not match handler",
    );
  }
}

function isTerminalResultForHandler(handler: FactoryHandler, event: FactoryActionEvent): boolean {
  if (event.type === "factory.action.failed") return true;
  switch (handler) {
    case "triageWorkItem":
      return event.type === "triage.work_item.completed";
    case "producePlanCandidate":
      return (
        event.type === "planning.candidate.produced" || event.type === "planning.input.required"
      );
    case "reviewPlanCandidate":
      return event.type === "planning.review.completed";
    case "produceImplementationCandidate":
      return event.type === "implementation.candidate.produced";
    case "reviewImplementationCandidate":
      return event.type === "implementation.review.completed";
    default:
      return assertNever(handler);
  }
}

function assertNever(value: never): never {
  throw new FactoryOperationResolutionError(`Unknown Factory handler: ${String(value)}`);
}

function matchesReaction(
  operation: FactoryOperationRef,
  phaseRunId: string | undefined,
  reaction: InvokeReaction,
): boolean {
  return (
    phaseRunId === operation.phaseRunId &&
    reaction.handler === operation.handler &&
    reaction.attempt === operation.attempt &&
    reaction.causationEventId === operation.causationEventId
  );
}

function handlerPhase(handler: FactoryHandler): FactoryPhase {
  if (handler === "triageWorkItem") return "triage";
  if (handler === "producePlanCandidate" || handler === "reviewPlanCandidate") return "planning";
  return "implementation";
}
