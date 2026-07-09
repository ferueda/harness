import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { AGENT_PROVIDERS } from "./agents.ts";
import {
  FactoryNextActionSchema,
  FactoryRouteSchema,
  FactoryStageSchema,
  FactoryTrackerRefSchema,
  FactoryWorkItemMetadataSchema,
  type FactoryNextAction,
  type FactoryRoute,
  type FactoryStage,
  type FactoryTrackerRef,
  type FactoryWorkItem,
  type FactoryWorkItemMetadata,
} from "./factory-schemas.ts";
import { formatZodError } from "./schemas.ts";

const LIFECYCLE_VERSION = 1 as const;
const LIFECYCLE_SOURCE = "harness" as const;

export class FactoryLifecycleError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryLifecycleError";
  }
}

const ExecutionSchema = z
  .object({
    workspace: z.string().min(1),
    runDir: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    head: z.string().min(1).optional(),
  })
  .strict();

const BaseEventSchema = z
  .object({
    version: z.literal(LIFECYCLE_VERSION),
    id: z.string().min(1),
    workItemKey: z.string().min(1),
    occurredAt: z.iso.datetime(),
    runId: z.string().min(1).optional(),
    source: z.literal(LIFECYCLE_SOURCE),
    execution: ExecutionSchema.optional(),
  })
  .strict();

const WorkItemImportedEventSchema = BaseEventSchema.extend({
  type: z.literal("work_item.imported"),
  data: z
    .object({
      source: z.string().min(1),
      title: z.string().min(1),
      tracker: FactoryTrackerRefSchema.optional(),
      url: z.url().optional(),
      labels: z.array(z.string()).optional(),
      // File/item-file planned entry may skip planning.completed / plan_pr.merged;
      // seed retry fields so implementation.completed can preserve them on base.
      approvedPlanPath: z.string().min(1).optional(),
      approvedPlanPrUrl: z.url().optional(),
      approvedPlanCommit: z.string().min(1).optional(),
    })
    .strict(),
});

const TriageStartedEventSchema = BaseEventSchema.extend({
  type: z.literal("triage.started"),
  data: z
    .object({
      linearIssue: z.string().min(1).optional(),
      itemFile: z.string().min(1).optional(),
    })
    .strict(),
});

const TriageCompletedEventSchema = BaseEventSchema.extend({
  type: z.literal("triage.completed"),
  runId: z.string().min(1),
  data: z
    .object({
      route: FactoryRouteSchema,
      nextAction: FactoryNextActionSchema,
      rationale: z.string().min(1),
      routeArtifactPath: z.string().min(1),
      triageArtifactPath: z.string().min(1),
      questions: z.array(z.string().min(1)).optional(),
      reconsiderWhen: z.string().min(1).optional(),
    })
    .strict(),
});

const TriageFailedEventSchema = BaseEventSchema.extend({
  type: z.literal("triage.failed"),
  runId: z.string().min(1),
  data: z
    .object({
      error: z.string().min(1),
      summaryPath: z.string().min(1).optional(),
    })
    .strict(),
});

const PlanningStartedEventSchema = BaseEventSchema.extend({
  type: z.literal("planning.started"),
  data: z
    .object({
      linearIssue: z.string().min(1).optional(),
      itemFile: z.string().min(1).optional(),
    })
    .strict(),
});

const PlanningStatusSchema = z.enum([
  "plan-approved",
  "plan-needs-human",
  "plan-review-unresolved",
]);

const PlanningCompletedEventSchema = BaseEventSchema.extend({
  type: z.literal("planning.completed"),
  runId: z.string().min(1),
  data: z
    .object({
      status: PlanningStatusSchema,
      approvedPlanPath: z.string().min(1).optional(),
      humanQuestions: z.array(z.string().min(1)).optional(),
      reviewFindingsPath: z.string().min(1).optional(),
      planReviewRefPath: z.string().min(1).optional(),
      iterationCount: z.number().int().nonnegative().optional(),
    })
    .strict(),
});

const PlanningFailedEventSchema = BaseEventSchema.extend({
  type: z.literal("planning.failed"),
  runId: z.string().min(1),
  data: z
    .object({
      error: z.string().min(1),
      summaryPath: z.string().min(1).optional(),
    })
    .strict(),
});

const ImplementationStartedEventSchema = BaseEventSchema.extend({
  type: z.literal("implementation.started"),
  data: z
    .object({
      linearIssue: z.string().min(1).optional(),
      itemFile: z.string().min(1).optional(),
    })
    .strict(),
});

const ImplementationCompletedEventSchema = BaseEventSchema.extend({
  type: z.literal("implementation.completed"),
  runId: z.string().min(1),
  data: z
    .object({
      diffPath: z.string().min(1),
      changeReviewHandoffPath: z.string().min(1),
      reviewBase: z.string().min(1),
      reviewHead: z.string().min(1),
      reviewCommitSha: z.string().min(1),
      rawOutputPath: z.string().min(1).optional(),
      streamLogPath: z.string().min(1).optional(),
      workspaceStatusPath: z.string().min(1).optional(),
      session: z
        .object({
          provider: z.enum(AGENT_PROVIDERS),
          id: z.string().min(1),
        })
        .strict()
        .optional(),
    })
    .strict(),
});

const ImplementationFailedEventSchema = BaseEventSchema.extend({
  type: z.literal("implementation.failed"),
  runId: z.string().min(1),
  data: z
    .object({
      error: z.string().min(1),
      summaryPath: z.string().min(1).optional(),
      rawOutputPath: z.string().min(1).optional(),
      streamLogPath: z.string().min(1).optional(),
      workspaceStatusPath: z.string().min(1).optional(),
      reviewBase: z.string().min(1).optional(),
    })
    .strict(),
});

const PlanPrOpenedEventSchema = BaseEventSchema.extend({
  type: z.literal("plan_pr.opened"),
  runId: z.string().min(1),
  data: z
    .object({
      approvedPlanPath: z.string().min(1),
      approvedPlanPrUrl: z.url(),
    })
    .strict(),
});

const PlanPrMergedEventSchema = BaseEventSchema.extend({
  type: z.literal("plan_pr.merged"),
  runId: z.string().min(1),
  data: z
    .object({
      approvedPlanPath: z.string().min(1),
      approvedPlanPrUrl: z.url(),
      approvedPlanCommit: z.string().min(1),
    })
    .strict(),
});

export const FactoryLifecycleEventSchema = z.discriminatedUnion("type", [
  WorkItemImportedEventSchema,
  TriageStartedEventSchema,
  TriageCompletedEventSchema,
  TriageFailedEventSchema,
  PlanningStartedEventSchema,
  PlanningCompletedEventSchema,
  PlanningFailedEventSchema,
  ImplementationStartedEventSchema,
  ImplementationCompletedEventSchema,
  ImplementationFailedEventSchema,
  PlanPrOpenedEventSchema,
  PlanPrMergedEventSchema,
]);

export const FactoryLifecycleStateSchema = z
  .object({
    version: z.literal(LIFECYCLE_VERSION),
    workItemKey: z.string().min(1),
    source: z.string().min(1).optional(),
    tracker: FactoryTrackerRefSchema.optional(),
    title: z.string().min(1).optional(),
    factoryStage: FactoryStageSchema.optional(),
    factoryRoute: FactoryRouteSchema.optional(),
    factoryNextAction: FactoryNextActionSchema.optional(),
    factoryRunId: z.string().min(1).optional(),
    approvedPlanPath: z.string().min(1).optional(),
    approvedPlanPrUrl: z.url().optional(),
    approvedPlanCommit: z.string().min(1).optional(),
    lastEventId: z.string().min(1).optional(),
    updatedAt: z.iso.datetime().optional(),
  })
  .strict();

export type FactoryLifecycleEvent = z.infer<typeof FactoryLifecycleEventSchema>;
export type FactoryLifecycleState = z.infer<typeof FactoryLifecycleStateSchema>;
export type FactoryLifecycleExecution = z.infer<typeof ExecutionSchema>;

export type AppendFactoryLifecycleEventInput = {
  factoryStateRoot: string;
  event: FactoryLifecycleEvent;
};

export function deriveFactoryWorkItemKey(workItem: FactoryWorkItem): string {
  const metadata = FactoryWorkItemMetadataSchema.safeParse(workItem.metadata ?? {});
  const tracker = metadata.success ? metadata.data.tracker : undefined;
  if (tracker) return `${tracker.source}:${tracker.id}`;
  if (workItem.id.includes(":")) return workItem.id;
  return `${workItem.source}:${workItem.id}`;
}

export function workItemKeyToFilename(workItemKey: string): string {
  const readable =
    workItemKey
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "work-item";
  const hash = createHash("sha256").update(workItemKey).digest("hex").slice(0, 12);
  return `${readable}-${hash}`;
}

export function resolveFactoryStateRoot(input: {
  workspace: string;
  factoryStateRoot?: string;
}): string {
  return resolve(input.factoryStateRoot ?? join(input.workspace, ".harness/factory"));
}

export function factoryLifecycleEventPath(factoryStateRoot: string, workItemKey: string): string {
  return join(resolve(factoryStateRoot), "events", `${workItemKeyToFilename(workItemKey)}.jsonl`);
}

export function factoryLifecycleStatePath(factoryStateRoot: string, workItemKey: string): string {
  return join(resolve(factoryStateRoot), "state", `${workItemKeyToFilename(workItemKey)}.json`);
}

export function readFactoryLifecycleEvents(input: {
  factoryStateRoot: string;
  workItemKey: string;
}): FactoryLifecycleEvent[] {
  const eventPath = factoryLifecycleEventPath(input.factoryStateRoot, input.workItemKey);
  if (!existsSync(eventPath)) return [];
  return readFileSync(eventPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseFactoryLifecycleEventLine(line, eventPath, index + 1));
}

export function appendFactoryLifecycleEvent(
  input: AppendFactoryLifecycleEventInput,
): FactoryLifecycleEvent {
  const event = parseFactoryLifecycleEvent(input.event);
  const eventPath = factoryLifecycleEventPath(input.factoryStateRoot, event.workItemKey);
  const existingEvents = readFactoryLifecycleEvents({
    factoryStateRoot: input.factoryStateRoot,
    workItemKey: event.workItemKey,
  });
  const existing = existingEvents.find((candidate) => candidate.id === event.id);
  if (existing) return existing;

  mkdirSync(dirname(eventPath), { recursive: true });
  appendFileSync(eventPath, `${JSON.stringify(event)}\n`, "utf8");
  writeFactoryLifecycleState({
    factoryStateRoot: input.factoryStateRoot,
    state: requireReducedState([...existingEvents, event], event.workItemKey),
  });
  return event;
}

export function reduceFactoryLifecycleEvents(
  events: readonly FactoryLifecycleEvent[],
): FactoryLifecycleState | undefined {
  let state: FactoryLifecycleState | undefined;
  for (const event of events) {
    state = reduceFactoryLifecycleEvent(state, parseFactoryLifecycleEvent(event));
  }
  return state;
}

export function loadFactoryLifecycleState(input: {
  factoryStateRoot: string;
  workItemKey: string;
}): FactoryLifecycleState | undefined {
  const events = readFactoryLifecycleEvents(input);
  if (events.length === 0) return undefined;

  const statePath = factoryLifecycleStatePath(input.factoryStateRoot, input.workItemKey);
  if (existsSync(statePath)) {
    const cached = parseFactoryLifecycleStateFile(statePath);
    const lastEventId = events.at(-1)?.id;
    if (cached.lastEventId === lastEventId) return cached;
  }

  const reduced = reduceFactoryLifecycleEvents(events);
  if (!reduced) return undefined;
  writeFactoryLifecycleState({
    factoryStateRoot: input.factoryStateRoot,
    state: reduced,
  });
  return reduced;
}

export function writeFactoryLifecycleState(input: {
  factoryStateRoot: string;
  state: FactoryLifecycleState;
}): FactoryLifecycleState {
  const state = parseFactoryLifecycleState(input.state);
  const statePath = factoryLifecycleStatePath(input.factoryStateRoot, state.workItemKey);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export function mergeFactoryStateIntoWorkItem(
  workItem: FactoryWorkItem,
  state: FactoryLifecycleState | undefined,
): FactoryWorkItem {
  if (!state) return workItem;
  const metadata = FactoryWorkItemMetadataSchema.parse(workItem.metadata ?? {});
  return {
    ...workItem,
    metadata: compactMetadata({
      ...metadata,
      ...definedLifecycleMetadata(state),
    }),
  };
}

function reduceFactoryLifecycleEvent(
  current: FactoryLifecycleState | undefined,
  event: FactoryLifecycleEvent,
): FactoryLifecycleState {
  const state =
    current ??
    ({
      version: LIFECYCLE_VERSION,
      workItemKey: event.workItemKey,
    } satisfies FactoryLifecycleState);
  const base = markEvent(state, event);

  switch (event.type) {
    case "work_item.imported":
      return {
        ...base,
        source: event.data.source,
        title: event.data.title,
        ...(event.data.tracker ? { tracker: event.data.tracker } : {}),
        ...(event.data.approvedPlanPath ? { approvedPlanPath: event.data.approvedPlanPath } : {}),
        ...(event.data.approvedPlanPrUrl
          ? { approvedPlanPrUrl: event.data.approvedPlanPrUrl }
          : {}),
        ...(event.data.approvedPlanCommit
          ? { approvedPlanCommit: event.data.approvedPlanCommit }
          : {}),
      };
    case "triage.started":
    case "planning.started":
    case "implementation.started":
      return base;
    case "triage.completed":
      return {
        ...base,
        factoryStage: stageForTriageRoute(event.data.route),
        factoryRoute: event.data.route,
        factoryNextAction: event.data.nextAction,
        factoryRunId: event.runId,
      };
    case "triage.failed":
      return {
        ...base,
        factoryRunId: event.runId,
      };
    case "planning.completed":
      return stateAfterPlanningCompleted(base, event);
    case "planning.failed":
      return withoutPublicationReadyFields({
        ...base,
        factoryStage: "planning-failed",
        factoryRunId: event.runId,
      });
    case "implementation.completed":
      return {
        ...base,
        factoryStage: "implementation-complete",
        factoryRunId: event.runId,
      };
    case "implementation.failed":
      return {
        ...base,
        factoryStage: "implementation-failed",
        factoryRunId: event.runId,
      };
    case "plan_pr.opened":
      return withoutApprovedPlanCommit({
        ...base,
        factoryStage: "plan-pr-open",
        factoryRunId: event.runId,
        approvedPlanPath: event.data.approvedPlanPath,
        approvedPlanPrUrl: event.data.approvedPlanPrUrl,
      });
    case "plan_pr.merged":
      return {
        ...base,
        factoryStage: "plan-approved",
        factoryRunId: event.runId,
        approvedPlanPath: event.data.approvedPlanPath,
        approvedPlanPrUrl: event.data.approvedPlanPrUrl,
        approvedPlanCommit: event.data.approvedPlanCommit,
      };
  }
}

function stateAfterPlanningCompleted(
  state: FactoryLifecycleState,
  event: Extract<FactoryLifecycleEvent, { type: "planning.completed" }>,
): FactoryLifecycleState {
  if (event.data.status === "plan-approved") {
    return withoutPublicationReadyFields({
      ...state,
      factoryStage: requiresPlanPr(state.tracker) ? "plan-pr-open" : "plan-approved",
      factoryRunId: event.runId,
      ...(event.data.approvedPlanPath ? { approvedPlanPath: event.data.approvedPlanPath } : {}),
    });
  }
  return withoutPublicationReadyFields({
    ...state,
    factoryStage: event.data.status,
    factoryRunId: event.runId,
  });
}

function markEvent(
  state: FactoryLifecycleState,
  event: FactoryLifecycleEvent,
): FactoryLifecycleState {
  return {
    ...state,
    lastEventId: event.id,
    updatedAt: event.occurredAt,
  };
}

function stageForTriageRoute(route: FactoryRoute): FactoryStage {
  switch (route) {
    case "ready-to-implement":
      return "ready-to-implement";
    case "ready-to-plan":
      return "ready-to-plan";
    case "needs-info":
      return "needs-info";
    case "wait-to-implement":
      return "wait-to-implement";
  }
}

function requiresPlanPr(tracker: FactoryTrackerRef | undefined): boolean {
  return tracker?.source === "linear" || tracker?.source === "github";
}

function withoutPublicationReadyFields(state: FactoryLifecycleState): FactoryLifecycleState {
  const { approvedPlanPrUrl: _url, approvedPlanCommit: _commit, ...rest } = state;
  return rest;
}

function withoutApprovedPlanCommit(state: FactoryLifecycleState): FactoryLifecycleState {
  const { approvedPlanCommit: _commit, ...rest } = state;
  return rest;
}

function definedLifecycleMetadata(state: FactoryLifecycleState): Partial<FactoryWorkItemMetadata> {
  return {
    ...(state.factoryStage ? { factoryStage: state.factoryStage } : {}),
    ...(state.factoryRoute ? { factoryRoute: state.factoryRoute } : {}),
    ...(state.factoryNextAction ? { factoryNextAction: state.factoryNextAction } : {}),
    ...(state.factoryRunId ? { factoryRunId: state.factoryRunId } : {}),
    ...(state.approvedPlanPath ? { approvedPlanPath: state.approvedPlanPath } : {}),
    ...(state.approvedPlanPrUrl ? { approvedPlanPrUrl: state.approvedPlanPrUrl } : {}),
    ...(state.approvedPlanCommit ? { approvedPlanCommit: state.approvedPlanCommit } : {}),
  };
}

function compactMetadata(
  metadata: Partial<FactoryWorkItemMetadata>,
): NonNullable<FactoryWorkItem["metadata"]> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined,
    ),
  );
}

function requireReducedState(
  events: readonly FactoryLifecycleEvent[],
  workItemKey: string,
): FactoryLifecycleState {
  const reduced = reduceFactoryLifecycleEvents(events);
  if (!reduced) {
    throw new FactoryLifecycleError(`Lifecycle event append did not produce state: ${workItemKey}`);
  }
  return reduced;
}

function parseFactoryLifecycleEvent(value: unknown): FactoryLifecycleEvent {
  const parsed = FactoryLifecycleEventSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new FactoryLifecycleError(
    `Invalid factory lifecycle event: ${formatZodError(parsed.error)}`,
    {
      cause: parsed.error,
    },
  );
}

function parseFactoryLifecycleEventLine(
  line: string,
  path: string,
  lineNumber: number,
): FactoryLifecycleEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new FactoryLifecycleError(
      `Invalid factory lifecycle JSONL at ${path}:${lineNumber}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    return parseFactoryLifecycleEvent(value);
  } catch (error) {
    throw new FactoryLifecycleError(
      `Invalid factory lifecycle event at ${path}:${lineNumber}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function parseFactoryLifecycleState(value: unknown): FactoryLifecycleState {
  const parsed = FactoryLifecycleStateSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new FactoryLifecycleError(
    `Invalid factory lifecycle state: ${formatZodError(parsed.error)}`,
    {
      cause: parsed.error,
    },
  );
}

function parseFactoryLifecycleStateFile(path: string): FactoryLifecycleState {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new FactoryLifecycleError(
      `Invalid factory lifecycle state JSON at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    return parseFactoryLifecycleState(value);
  } catch (error) {
    throw new FactoryLifecycleError(
      `Invalid factory lifecycle state at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
