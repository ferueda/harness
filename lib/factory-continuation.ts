import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { readFileSync } from "node:fs";
import type { z } from "zod";
import { createFactoryArtifactRef, verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";
import {
  FactoryContinuationDecisionSchema,
  type FactoryLifecycleEvent,
} from "./factory-lifecycle-events.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { readFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";
import type { FactoryHandler } from "./factory-action-contract.ts";
import { decideNextFactoryAction, reduceFactoryLifecycleEvents } from "./factory-state-machine.ts";

export const MAX_FACTORY_CONTINUATION_RESPONSE_BYTES = 32 * 1024;
export type FactoryContinuationDecision = z.infer<typeof FactoryContinuationDecisionSchema>;

export function readFactoryContinuationResponseFile(path: string): string {
  if (!isAbsolute(path)) throw new Error("Factory continuation response path must be absolute");
  let response: string;
  try {
    response = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      readFileSync(path),
    );
  } catch {
    throw new Error("Factory continuation response must be valid UTF-8");
  }
  return validateFactoryContinuationResponse(response);
}

export function validateFactoryContinuationResponse(response: string): string {
  if (!response.trim()) throw new Error("Factory continuation response is blank");
  if (Buffer.byteLength(response, "utf8") > MAX_FACTORY_CONTINUATION_RESPONSE_BYTES)
    throw new Error(
      `Factory continuation response exceeds ${MAX_FACTORY_CONTINUATION_RESPONSE_BYTES} bytes`,
    );
  return response;
}

export function recordFactoryContinuation(input: {
  phase: "planning" | "implementation";
  decision: FactoryContinuationDecision;
  response: string;
  factoryStateRoot: string;
  factoryStore: FactoryStoreMeta;
  workItem: FactoryWorkItem;
}) {
  const decision = FactoryContinuationDecisionSchema.parse(input.decision);
  const response = validateFactoryContinuationResponse(input.response);
  const key = deriveFactoryWorkItemKey(input.workItem);
  const events = readFactoryActionEvents(input.factoryStateRoot, key);
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  const mayReviseBeforeReview =
    state?.status === "awaiting-review" &&
    state.reviewEventId === undefined &&
    decision === "revise";
  const mayContinueAfterReview = state?.status === "awaiting-continuation";
  if (
    !state ||
    !latest ||
    state.phase !== input.phase ||
    (!mayReviseBeforeReview && !mayContinueAfterReview) ||
    !state.candidateEventId
  )
    throw new Error(`Factory ${input.phase} has no candidate awaiting continuation`);
  const runDir = join(input.factoryStore.projectRoot, "runs/factory", state.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(runDir);
  if (
    identity.phase !== input.phase ||
    identity.phaseRunId !== state.phaseRunId ||
    identity.workItemKey !== key ||
    identity.projectId !== input.factoryStore.projectId
  )
    throw new Error(`Factory ${input.phase} continuation conflicts with phase-run identity`);
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        phase: input.phase,
        phaseRunId: state.phaseRunId,
        predecessor: latest.id,
        decision,
        candidateEventId: state.candidateEventId,
        reviewEventId: state.reviewEventId,
        response,
      }),
    )
    .digest("hex");
  const responsePath = join(runDir, "continuations", digest, "response.md");
  writeDurableFactoryFile(responsePath, response, true);
  const responseRef = createFactoryArtifactRef({
    base: "factory-store",
    root: input.factoryStore.projectRoot,
    path: relative(input.factoryStore.projectRoot, responsePath),
  });
  const event: FactoryLifecycleEvent = {
    version: 1,
    id: `factory.continuation.recorded:${digest}`,
    type: "factory.continuation.recorded",
    workItemKey: key,
    occurredAt: new Date().toISOString(),
    phaseRunId: state.phaseRunId,
    data: {
      expectedPredecessor: latest.id,
      phase: input.phase,
      decision,
      candidateEventId: state.candidateEventId,
      ...(state.reviewEventId ? { reviewEventId: state.reviewEventId } : {}),
      response: responseRef,
    },
  };
  const appended = appendFactoryActionEvent({
    factoryStateRoot: input.factoryStateRoot,
    event,
    expectedLastEventId: latest.id,
  });
  return {
    phaseRunId: state.phaseRunId,
    event: appended.event,
    state: appended.state,
    next: decideNextFactoryAction(appended.state, appended.event),
  };
}

export function loadFactoryContinuationForReaction(input: {
  events: readonly FactoryLifecycleEvent[];
  causationEventId: string;
  phase: "planning" | "implementation";
  handler: FactoryHandler;
  attempt: number;
  phaseRunId: string;
  workItemKey: string;
  roots: { "factory-store": string; repository: string };
}) {
  const byId = new Map(input.events.map((event) => [event.id, event]));
  const seen = new Set<string>();
  let id = input.causationEventId;
  while (true) {
    if (seen.has(id)) throw new Error("Factory continuation retry causation is cyclic");
    seen.add(id);
    const event = byId.get(id);
    if (!event) throw new Error("Factory continuation causation event is missing");
    if (event.type === "factory.continuation.recorded") {
      if (
        event.phaseRunId !== input.phaseRunId ||
        event.workItemKey !== input.workItemKey ||
        event.data.phase !== input.phase ||
        (event.data.decision === "revise") !== input.handler.startsWith("produce")
      )
        throw new Error("Factory continuation conflicts with action identity");
      const candidate = byId.get(event.data.candidateEventId);
      const expectedCandidateType =
        input.phase === "planning"
          ? "planning.candidate.produced"
          : "implementation.candidate.produced";
      if (
        !candidate ||
        candidate.type !== expectedCandidateType ||
        candidate.phaseRunId !== input.phaseRunId ||
        candidate.workItemKey !== input.workItemKey
      )
        throw new Error("Factory continuation candidate is unavailable");
      const review = event.data.reviewEventId ? byId.get(event.data.reviewEventId) : undefined;
      if (
        review &&
        (review.phaseRunId !== input.phaseRunId ||
          review.workItemKey !== input.workItemKey ||
          review.type !==
            (input.phase === "planning"
              ? "planning.review.completed"
              : "implementation.review.completed"))
      )
        throw new Error("Factory continuation review is unavailable");
      return {
        event,
        candidate,
        review,
        response: readFileSync(verifyFactoryArtifactRef(event.data.response, input.roots), "utf8"),
      };
    }
    if (
      event.type !== "factory.action.failed" ||
      event.phaseRunId !== input.phaseRunId ||
      event.workItemKey !== input.workItemKey ||
      event.data.phase !== input.phase ||
      event.data.handler !== input.handler ||
      event.data.failureKind !== "retryable" ||
      event.data.attempt !== input.attempt
    )
      return undefined;
    id = event.data.causationEventId;
  }
}
