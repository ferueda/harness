import { describe, expect, test } from "vitest";
import { factoryActionKey, type FactoryHandler } from "./factory-action-contract.ts";
import {
  classifyFactoryActionFailure,
  type FactoryActionFailure,
} from "./factory-action-failure.ts";
import type { FactoryArtifactRef } from "./factory-artifact-ref.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import type { FactoryPhaseRunIdentity } from "./factory-phase-run.ts";

const execution = {
  workspaceRef: "repo",
  runRef: artifact("failure.json"),
};
const proposed: FactoryActionFailure = {
  failureKind: "retryable",
  message: "provider unavailable",
};

test("keeps legacy phase retry behavior when no policy was snapshotted", () => {
  const identity = phaseIdentity();
  const first = failure({ causationEventId: "request" });
  const second = failure({ causationEventId: first.id });

  expect(
    classifyFactoryActionFailure({
      identity,
      events: [first, second],
      handler: "triageWorkItem",
      attempt: 1,
      causationEventId: second.id,
      proposed,
    }),
  ).toEqual(proposed);
});

test("allows executions one and two, then requires a human on execution three", () => {
  const identity = phaseIdentity(3);
  const first = failure({ causationEventId: "request" });
  const second = failure({ causationEventId: first.id });

  expect(classify(identity, [], "request")).toEqual(proposed);
  expect(classify(identity, [first], first.id)).toEqual(proposed);
  expect(classify(identity, [first, second], second.id)).toEqual({
    failureKind: "human-required",
    message:
      "Factory automatic retry ceiling reached after 3 executions (limit 3): provider unavailable",
  });
});

test("does not change an already non-retryable failure", () => {
  const identity = phaseIdentity(1);
  const failureResult: FactoryActionFailure = {
    failureKind: "terminal",
    message: "invalid output",
  };
  expect(
    classifyFactoryActionFailure({
      identity,
      events: [],
      handler: "triageWorkItem",
      attempt: 1,
      causationEventId: "request",
      proposed: failureResult,
    }),
  ).toEqual(failureResult);
});

describe.each([
  {
    name: "a different event",
    identity: phaseIdentity(3),
    prior: [failure({ causationEventId: "request" }), imported("new-boundary")],
    causationEventId: "new-boundary",
    handler: "triageWorkItem" as const,
    attempt: 1,
  },
  {
    name: "a different handler",
    identity: phaseIdentity(3),
    prior: [
      failure({
        causationEventId: "candidate",
        handler: "reviewPlanCandidate",
        phaseRunId: "phase",
        phase: "planning",
      }),
    ],
    causationEventId: "",
    handler: "producePlanCandidate" as const,
    attempt: 1,
  },
  {
    name: "a different attempt",
    identity: phaseIdentity(3),
    prior: [failure({ causationEventId: "request", attempt: 1 })],
    causationEventId: "",
    handler: "triageWorkItem" as const,
    attempt: 2,
  },
  {
    name: "a different phase run",
    identity: phaseIdentity(3, "new-phase"),
    prior: [failure({ causationEventId: "request", phaseRunId: "old-phase" })],
    causationEventId: "",
    handler: "triageWorkItem" as const,
    attempt: 1,
  },
])("resets after $name", ({ identity, prior, causationEventId, handler, attempt }) => {
  test("starts a new applicable chain", () => {
    const predecessor = causationEventId || prior.at(-1)!.id;
    expect(
      classifyFactoryActionFailure({
        identity,
        events: prior,
        handler,
        attempt,
        causationEventId: predecessor,
        proposed,
      }),
    ).toEqual(proposed);
  });
});

test("an explicit continuation breaks the prior failure chain", () => {
  const identity = phaseIdentity(3, "phase", "planning");
  const first = failure({
    causationEventId: "candidate",
    handler: "reviewPlanCandidate",
    phaseRunId: "phase",
    phase: "planning",
  });
  const continuation: FactoryLifecycleEvent = {
    version: 1,
    id: "continuation",
    type: "factory.continuation.recorded",
    workItemKey: "item",
    occurredAt: "2026-07-17T00:00:00.000Z",
    phaseRunId: "phase",
    data: {
      expectedPredecessor: first.id,
      phase: "planning",
      decision: "re-review",
      candidateEventId: "candidate",
      reviewEventId: "review",
      response: artifact("response.md"),
    },
  };
  expect(
    classifyFactoryActionFailure({
      identity,
      events: [first, continuation],
      handler: "reviewPlanCandidate",
      attempt: 1,
      causationEventId: continuation.id,
      proposed,
    }),
  ).toEqual(proposed);
});

function classify(
  identity: FactoryPhaseRunIdentity,
  events: FactoryLifecycleEvent[],
  causationEventId: string,
) {
  return classifyFactoryActionFailure({
    identity,
    events,
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId,
    proposed,
  });
}

function phaseIdentity(
  maxExecutions?: number,
  phaseRunId = "phase",
  phase: "triage" | "planning" = "triage",
): FactoryPhaseRunIdentity {
  const base = {
    version: 2 as const,
    phaseRunId,
    workItemKey: "item",
    workspace: "/workspace",
    projectId: "project",
    factoryStateRoot: "/store",
    ...(maxExecutions ? { automaticActionPolicy: { maxExecutions } } : {}),
  };
  return phase === "triage"
    ? {
        ...base,
        phase,
        actions: {
          triageWorkItem: {
            provider: "cursor",
            model: "model",
          },
        },
      }
    : {
        ...base,
        phase,
        outputPlan: "dev/plans/item.md",
        publicationMode: "local",
        actions: {
          producePlanCandidate: { provider: "cursor", model: "model" },
          reviewPlanCandidate: { provider: "cursor", model: "model" },
        },
      };
}

function failure(input: {
  causationEventId: string;
  handler?: FactoryHandler;
  attempt?: number;
  phaseRunId?: string;
  phase?: "triage" | "planning" | "implementation";
}): Extract<FactoryLifecycleEvent, { type: "factory.action.failed" }> {
  const handler = input.handler ?? "triageWorkItem";
  const attempt = input.attempt ?? 1;
  const phaseRunId = input.phaseRunId ?? "phase";
  const actionKey = factoryActionKey({
    phaseRunId,
    handler,
    attempt,
    causationEventId: input.causationEventId,
  });
  return {
    version: 1,
    id: `factory.action.failed:${actionKey}`,
    type: "factory.action.failed",
    workItemKey: "item",
    occurredAt: "2026-07-17T00:00:00.000Z",
    phaseRunId,
    data: {
      handler,
      handlerVersion: 1,
      attempt,
      causationEventId: input.causationEventId,
      execution,
      evidence: [execution.runRef],
      phase: input.phase ?? "triage",
      failureKind: "retryable",
      message: proposed.message,
    },
  };
}

function imported(id: string): FactoryLifecycleEvent {
  return {
    version: 1,
    id,
    type: "work_item.imported",
    workItemKey: "item",
    occurredAt: "2026-07-17T00:00:00.000Z",
    data: { source: "test" },
  };
}

function artifact(path: string): FactoryArtifactRef {
  return {
    base: "factory-store",
    path,
    sha256: "a".repeat(64),
  };
}
