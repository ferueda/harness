import type { Inngest, InngestFunction } from "inngest";
import {
  LINEAR_ISSUE_READINESS_CHECK_EVENT_NAME,
  LinearIssueReadinessCheckRequestedEvent,
} from "./events/linear-readiness-events.ts";
import {
  LINEAR_ISSUE_REVISION_EVENT_NAME,
  LinearIssueRevisionObservedEvent,
} from "./events/linear-revision-events.ts";
import { createWorkRequestedEvent } from "./events/work-events.ts";
import {
  classifyLinearReadiness,
  LinearReadinessConfigSchema,
  type LinearReadinessConfig,
  type LinearReadinessDecision,
} from "./readiness.ts";
import { LinearError } from "../linear/error.ts";
import type { LinearIssueContext } from "../linear/types.ts";

export const LINEAR_READINESS_ROUTER_FUNCTION_ID = "route-linear-readiness-v1";
export const LINEAR_READINESS_ROUTER_RETRIES = 3;
export const LINEAR_READINESS_LOAD_STEP_ID = "load-linear-readiness-v1";
export const LINEAR_READINESS_CONFIRM_STEP_ID = "confirm-linear-readiness-v1";
export const LINEAR_READINESS_SEND_STEP_ID = "send-linear-work-request-v1";

export type LinearReadinessRouterLinear = Readonly<{
  getIssueContext: (issueRef: string) => Promise<LinearIssueContext>;
}>;

export type LinearReadinessRouterConfig = Readonly<{
  readiness: LinearReadinessConfig;
}>;

type ObservedReadiness = Readonly<{
  issueId: string;
  issueIdentifier: string;
  decision: LinearReadinessDecision;
}>;

type LoadedReadiness =
  | Readonly<{ kind: "current"; observed: ObservedReadiness }>
  | Readonly<{ kind: "stale"; issueId: string }>;

type ReadinessObservation = Readonly<{
  issueId: string;
  issueIdentifier: string;
  expectedUpdatedAt?: string;
}>;

export function createLinearReadinessRouter(input: {
  client: Inngest.Any;
  linear: LinearReadinessRouterLinear;
  config: LinearReadinessRouterConfig;
}): InngestFunction.Any {
  const config = normalizeConfig(input.config);

  return input.client.createFunction(
    {
      id: LINEAR_READINESS_ROUTER_FUNCTION_ID,
      concurrency: 1,
      retries: LINEAR_READINESS_ROUTER_RETRIES,
      triggers: [LinearIssueRevisionObservedEvent, LinearIssueReadinessCheckRequestedEvent],
    },
    async ({ event, step }) => {
      const observation: ReadinessObservation =
        event.name === LINEAR_ISSUE_REVISION_EVENT_NAME
          ? {
              issueId: event.data.issueId,
              issueIdentifier: event.data.issueIdentifier,
              expectedUpdatedAt: event.data.updatedAt,
            }
          : {
              issueId: event.data.issueId,
              issueIdentifier: event.data.issueIdentifier,
            };
      const loaded = await step.run(LINEAR_READINESS_LOAD_STEP_ID, () =>
        loadReadiness(input.linear, observation, config.readiness),
      );
      if (loaded.kind === "stale") {
        return {
          outcome: "stale" as const,
          reason: "revision-changed" as const,
          issueId: loaded.issueId,
        };
      }

      const { observed } = loaded;
      if (
        event.name === LINEAR_ISSUE_READINESS_CHECK_EVENT_NAME &&
        observed.decision.kind === "dispatch" &&
        observed.decision.route === "triage"
      ) {
        return {
          outcome: "ignore" as const,
          reason: "not-open" as const,
          issueId: observed.issueId,
          snapshotGeneration: observed.decision.snapshotGeneration,
        };
      }
      if (observed.decision.kind !== "dispatch") {
        return {
          outcome: observed.decision.kind,
          reason: observed.decision.reason,
          issueId: observed.issueId,
          snapshotGeneration: observed.decision.snapshotGeneration,
        };
      }

      const ready =
        observed.decision.route === "triage"
          ? observed
          : await step.run(LINEAR_READINESS_CONFIRM_STEP_ID, async () => {
              const confirmed = await loadReadiness(input.linear, observation, config.readiness);
              return confirmed.kind === "current" ? confirmed.observed : null;
            });
      if (!ready) {
        return {
          outcome: "stale" as const,
          reason: "revision-changed" as const,
          issueId: event.data.issueId,
        };
      }
      if (!sameDispatch(observed, ready)) {
        return {
          outcome: "stale" as const,
          reason: "readiness-changed" as const,
          issueId: event.data.issueId,
        };
      }

      const route = observed.decision.route;
      const request = createWorkRequestedEvent(route, {
        issueId: ready.issueId,
        issueIdentifier: ready.issueIdentifier,
        causationEventId: event.id,
        snapshotGeneration: ready.decision.snapshotGeneration,
      });
      await step.sendEvent(LINEAR_READINESS_SEND_STEP_ID, request);

      return {
        outcome: "dispatched" as const,
        route,
        issueId: ready.issueId,
        snapshotGeneration: ready.decision.snapshotGeneration,
        workEventId: request.id,
      };
    },
  );
}

async function loadReadiness(
  linear: LinearReadinessRouterLinear,
  observation: ReadinessObservation,
  config: LinearReadinessConfig,
): Promise<LoadedReadiness> {
  const context = await linear.getIssueContext(observation.issueId);
  if (context.id !== observation.issueId) {
    throw new LinearError(
      "invalid-response",
      `Linear readiness read returned issue ${context.id}, expected ${observation.issueId}.`,
    );
  }
  if (context.identifier !== observation.issueIdentifier) {
    throw new LinearError(
      "invalid-response",
      `Linear readiness read returned ${context.identifier}, expected ${observation.issueIdentifier}.`,
    );
  }
  if (observation.expectedUpdatedAt && context.updatedAt !== observation.expectedUpdatedAt) {
    return { kind: "stale", issueId: context.id };
  }
  return {
    kind: "current",
    observed: {
      issueId: context.id,
      issueIdentifier: context.identifier,
      decision: classifyLinearReadiness({ context, config }),
    },
  };
}

function sameDispatch(initial: ObservedReadiness, current: ObservedReadiness): boolean {
  return (
    initial.issueId === current.issueId &&
    initial.decision.kind === "dispatch" &&
    current.decision.kind === "dispatch" &&
    initial.decision.route === current.decision.route &&
    initial.decision.snapshotGeneration === current.decision.snapshotGeneration
  );
}

function normalizeConfig(config: LinearReadinessRouterConfig): LinearReadinessRouterConfig {
  return {
    readiness: LinearReadinessConfigSchema.parse(config.readiness),
  };
}
