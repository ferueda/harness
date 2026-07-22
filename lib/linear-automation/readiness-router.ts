import type { Inngest, InngestFunction } from "inngest";
import {
  LinearIssueRevisionObservedEvent,
  linearIssueRevisionEventId,
  type LinearIssueRevisionData,
} from "./events/linear-revision-events.ts";
import { createWorkRequestedEvent } from "./events/work-events.ts";
import {
  classifyLinearReadiness,
  LinearReadinessConfigSchema,
  type LinearReadinessConfig,
  type LinearReadinessDecision,
} from "./readiness.ts";
import { LinearError } from "../linear/error.ts";
import type { LinearIssueContext } from "../linear/read.ts";

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
      triggers: [LinearIssueRevisionObservedEvent],
    },
    async ({ event, step }) => {
      const loaded = await step.run(LINEAR_READINESS_LOAD_STEP_ID, () =>
        loadReadiness(input.linear, event.data, config.readiness),
      );
      if (loaded.kind === "stale") {
        return {
          outcome: "stale" as const,
          reason: "revision-changed" as const,
          issueId: loaded.issueId,
        };
      }

      const { observed } = loaded;
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
              const confirmed = await loadReadiness(input.linear, event.data, config.readiness);
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
        causationEventId: linearIssueRevisionEventId(event.data),
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
  revision: LinearIssueRevisionData,
  config: LinearReadinessConfig,
): Promise<LoadedReadiness> {
  const context = await linear.getIssueContext(revision.issueId);
  if (context.id !== revision.issueId) {
    throw new LinearError(
      "invalid-response",
      `Linear readiness read returned issue ${context.id}, expected ${revision.issueId}.`,
    );
  }
  if (context.identifier !== revision.issueIdentifier) {
    throw new LinearError(
      "invalid-response",
      `Linear readiness read returned ${context.identifier}, expected ${revision.issueIdentifier}.`,
    );
  }
  if (context.updatedAt !== revision.updatedAt) {
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
