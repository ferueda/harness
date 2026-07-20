import { Buffer } from "node:buffer";
import type { Inngest, InngestFunction } from "inngest";
import { createWorkRequestedEvent } from "./inngest/work-events.ts";
import {
  LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX,
  LinearWebhookReceivedEvent,
} from "./inngest/linear-webhook-transform.ts";
import {
  classifyLinearReadiness,
  LinearReadinessConfigSchema,
  type LinearReadinessConfig,
  type LinearReadinessDecision,
} from "./linear-readiness.ts";
import { LinearError } from "./linear/error.ts";
import type { LinearIssueContext } from "./linear/read.ts";
import {
  verifyLinearIssueChangedWebhook,
  type LinearIssueChangedDelivery,
} from "./linear/webhook.ts";

export const LINEAR_READINESS_ROUTER_FUNCTION_ID = "route-linear-readiness-v1";
export const LINEAR_READINESS_ROUTER_RETRIES = 3;
export const LINEAR_READINESS_VERIFY_STEP_ID = "verify-linear-webhook-v1";
export const LINEAR_READINESS_LOAD_STEP_ID = "load-linear-readiness-v1";
export const LINEAR_READINESS_CONFIRM_STEP_ID = "confirm-linear-readiness-v1";
export const LINEAR_READINESS_SEND_STEP_ID = "send-linear-work-request-v1";

export type LinearReadinessRouterLinear = Readonly<{
  getIssueContext: (issueRef: string) => Promise<LinearIssueContext>;
}>;

export type LinearReadinessRouterConfig = Readonly<{
  webhookSecret: string;
  organizationId: string;
  readiness: LinearReadinessConfig;
}>;

type VerifiedDelivery =
  | Readonly<{ kind: "verified"; delivery: LinearIssueChangedDelivery }>
  | Readonly<{
      kind: "ignored";
      reason: "invalid-delivery" | "authenticated-irrelevant" | "wrong-organization";
    }>;

type ObservedReadiness = Readonly<{
  issueId: string;
  issueIdentifier: string;
  decision: LinearReadinessDecision;
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
      triggers: [LinearWebhookReceivedEvent],
    },
    async ({ event, step }) => {
      const verification = await step.run(LINEAR_READINESS_VERIFY_STEP_ID, () =>
        verifyDelivery({
          rawBody: event.data.rawBody,
          signature: event.data.signature,
          deliveryId: event.data.deliveryId,
          receivedAt: event.ts,
          config,
        }),
      );
      if (verification.kind === "ignored") {
        return { outcome: "ignored" as const, reason: verification.reason };
      }

      const { delivery } = verification;
      const observed = await step.run(LINEAR_READINESS_LOAD_STEP_ID, () =>
        loadReadiness(input.linear, delivery.issueId, config.readiness),
      );
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
          : await step.run(LINEAR_READINESS_CONFIRM_STEP_ID, () =>
              loadReadiness(input.linear, delivery.issueId, config.readiness),
            );
      if (!sameDispatch(observed, ready)) {
        return {
          outcome: "stale" as const,
          reason: "readiness-changed" as const,
          issueId: delivery.issueId,
        };
      }

      const route = observed.decision.route;
      const request = createWorkRequestedEvent(route, {
        issueId: ready.issueId,
        issueIdentifier: ready.issueIdentifier,
        causationEventId: `${LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX}${delivery.deliveryId}`,
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
  verifiedIssueId: string,
  config: LinearReadinessConfig,
): Promise<ObservedReadiness> {
  const context = await linear.getIssueContext(verifiedIssueId);
  if (context.id !== verifiedIssueId) {
    throw new LinearError(
      "invalid-response",
      `Linear readiness read returned issue ${context.id}, expected ${verifiedIssueId}.`,
    );
  }
  return {
    issueId: context.id,
    issueIdentifier: context.identifier,
    decision: classifyLinearReadiness({ context, config }),
  };
}

function verifyDelivery(input: {
  rawBody: string;
  signature: string;
  deliveryId: string;
  receivedAt: number;
  config: LinearReadinessRouterConfig;
}): VerifiedDelivery {
  let delivery: LinearIssueChangedDelivery | null;
  try {
    delivery = verifyLinearIssueChangedWebhook({
      secret: input.config.webhookSecret,
      rawBody: Buffer.from(input.rawBody, "utf8"),
      signature: input.signature,
      deliveryId: input.deliveryId,
      receivedAt: input.receivedAt,
    });
  } catch (error) {
    if (
      error instanceof LinearError &&
      (error.code === "invalid-input" || error.code === "rejected")
    ) {
      return { kind: "ignored", reason: "invalid-delivery" };
    }
    throw error;
  }

  if (!delivery) return { kind: "ignored", reason: "authenticated-irrelevant" };
  if (delivery.organizationId !== input.config.organizationId) {
    return { kind: "ignored", reason: "wrong-organization" };
  }
  return { kind: "verified", delivery };
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
    webhookSecret: requiredString(config.webhookSecret, "webhookSecret"),
    organizationId: requiredString(config.organizationId, "organizationId"),
    readiness: LinearReadinessConfigSchema.parse(config.readiness),
  };
}

function requiredString(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LinearError("invalid-config", `Linear readiness ${label} must be non-empty.`);
  }
  return value;
}
