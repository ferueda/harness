import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { z } from "zod";
import { createFactoryArtifactRef, verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";
import {
  FactoryContinuationDecisionSchema,
  type FactoryLifecycleEvent,
} from "./factory-lifecycle-events.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import { readFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";
import type { FactoryHandler } from "./factory-action-contract.ts";
import { decideNextFactoryAction, reduceFactoryLifecycleEvents } from "./factory-state-machine.ts";

export const MAX_FACTORY_CONTINUATION_RESPONSE_BYTES = 32 * 1024;
export type FactoryContinuationDecision = z.infer<typeof FactoryContinuationDecisionSchema>;
export type FactoryContinuationObservation = Readonly<{
  expectedPredecessor: string;
  phaseRunId: string;
  candidateEventId: string;
  reviewEventId?: string;
}>;

export function observeFactoryContinuation(
  events: readonly FactoryLifecycleEvent[],
  phase: "planning" | "implementation",
): FactoryContinuationObservation {
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  if (
    !state ||
    !latest ||
    state.phase !== phase ||
    !state.candidateEventId ||
    (state.status !== "awaiting-review" && state.status !== "awaiting-continuation")
  )
    throw new Error(`Factory ${phase} has no candidate awaiting continuation`);
  return {
    expectedPredecessor: latest.id,
    phaseRunId: state.phaseRunId,
    candidateEventId: state.candidateEventId,
    ...(state.reviewEventId ? { reviewEventId: state.reviewEventId } : {}),
  };
}

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
  workItemKey: string;
  observed: FactoryContinuationObservation;
}) {
  const decision = FactoryContinuationDecisionSchema.parse(input.decision);
  const response = validateFactoryContinuationResponse(input.response);
  const key = input.workItemKey;
  const events = readFactoryActionEvents(input.factoryStateRoot, key);
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  if (!latest || !state) throw new Error(`Factory ${input.phase} has no durable state`);
  const authenticated = authenticateContinuationPhaseRun(input);
  const existing = exactContinuationDuplicate(latest, input, authenticated.roots);
  if (existing) {
    return {
      phaseRunId: existing.phaseRunId,
      event: existing,
      state,
      next: decideNextFactoryAction(state, existing),
    };
  }
  if (latest.id !== input.observed.expectedPredecessor)
    throw new Error(
      `Stale Factory continuation: expected ${input.observed.expectedPredecessor}, found ${latest.id}`,
    );
  const mayReviseBeforeReview =
    state?.status === "awaiting-review" &&
    state.reviewEventId === undefined &&
    state.lastEventId === state.candidateEventId &&
    decision === "revise";
  const mayContinueAfterReview = state?.status === "awaiting-continuation";
  if (
    state.phase !== input.phase ||
    (!mayReviseBeforeReview && !mayContinueAfterReview) ||
    !state.candidateEventId ||
    state.phaseRunId !== input.observed.phaseRunId ||
    state.candidateEventId !== input.observed.candidateEventId ||
    state.reviewEventId !== input.observed.reviewEventId
  )
    throw new Error(`Factory ${input.phase} has no candidate awaiting continuation`);
  const { runDir, identity } = authenticated;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        phase: input.phase,
        phaseRunId: input.observed.phaseRunId,
        predecessor: input.observed.expectedPredecessor,
        decision,
        candidateEventId: input.observed.candidateEventId,
        reviewEventId: input.observed.reviewEventId,
        response,
      }),
    )
    .digest("hex");
  const responsePath = join(runDir, "continuations", digest, "response.md");
  validateContinuationEvidence(events, input, identity.workspace);
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
      expectedPredecessor: input.observed.expectedPredecessor,
      phase: input.phase,
      decision,
      candidateEventId: input.observed.candidateEventId,
      ...(input.observed.reviewEventId ? { reviewEventId: input.observed.reviewEventId } : {}),
      response: responseRef,
    },
  };
  const appended = appendFactoryActionEvent({
    factoryStateRoot: input.factoryStateRoot,
    event,
    expectedLastEventId: input.observed.expectedPredecessor,
  });
  return {
    phaseRunId: state.phaseRunId,
    event: appended.event,
    state: appended.state,
    next: decideNextFactoryAction(appended.state, appended.event),
  };
}

function exactContinuationDuplicate(
  latest: FactoryLifecycleEvent,
  input: Parameters<typeof recordFactoryContinuation>[0],
  roots: { "factory-store": string; repository: string },
): Extract<FactoryLifecycleEvent, { type: "factory.continuation.recorded" }> | undefined {
  if (
    latest.type !== "factory.continuation.recorded" ||
    latest.workItemKey !== input.workItemKey ||
    latest.phaseRunId !== input.observed.phaseRunId ||
    latest.data.phase !== input.phase ||
    latest.data.decision !== input.decision ||
    latest.data.expectedPredecessor !== input.observed.expectedPredecessor ||
    latest.data.candidateEventId !== input.observed.candidateEventId ||
    latest.data.reviewEventId !== input.observed.reviewEventId
  )
    return undefined;
  const path = verifyFactoryArtifactRef(latest.data.response, roots);
  if (readFileSync(path, "utf8") !== validateFactoryContinuationResponse(input.response))
    throw new Error("Factory continuation response conflicts with the durable decision");
  return latest;
}

function authenticateContinuationPhaseRun(input: Parameters<typeof recordFactoryContinuation>[0]): {
  runDir: string;
  identity: ReturnType<typeof readFactoryPhaseRunIdentity>;
  roots: { "factory-store": string; repository: string };
} {
  const runDir = join(input.factoryStore.factoryRunsDir, input.observed.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(runDir);
  if (
    identity.phase !== input.phase ||
    identity.phaseRunId !== input.observed.phaseRunId ||
    identity.workItemKey !== input.workItemKey ||
    identity.projectId !== input.factoryStore.projectId ||
    resolve(identity.factoryStateRoot) !== resolve(input.factoryStateRoot) ||
    resolve(input.factoryStore.factoryStateRoot) !== resolve(input.factoryStateRoot)
  )
    throw new Error(`Factory ${input.phase} continuation conflicts with phase-run identity`);
  return {
    runDir,
    identity,
    roots: {
      "factory-store": input.factoryStore.projectRoot,
      repository: identity.workspace,
    },
  };
}

function validateContinuationEvidence(
  events: readonly FactoryLifecycleEvent[],
  input: Parameters<typeof recordFactoryContinuation>[0],
  repository: string,
): void {
  const candidate = events.find((event) => event.id === input.observed.candidateEventId);
  const candidateType =
    input.phase === "planning"
      ? "planning.candidate.produced"
      : "implementation.candidate.produced";
  if (
    !candidate ||
    candidate.type !== candidateType ||
    candidate.phaseRunId !== input.observed.phaseRunId ||
    candidate.workItemKey !== input.workItemKey
  )
    throw new Error(`Factory ${input.phase} continuation candidate identity mismatch`);
  verifyFactoryArtifactRef(candidate.data.candidate, {
    "factory-store": input.factoryStore.projectRoot,
    repository,
  });

  if (!input.observed.reviewEventId) return;
  const review = events.find((event) => event.id === input.observed.reviewEventId);
  const reviewType =
    input.phase === "planning" ? "planning.review.completed" : "implementation.review.completed";
  if (
    !review ||
    review.type !== reviewType ||
    review.phaseRunId !== input.observed.phaseRunId ||
    review.workItemKey !== input.workItemKey ||
    review.data.candidateEventId !== input.observed.candidateEventId
  )
    throw new Error(`Factory ${input.phase} continuation review identity mismatch`);
  verifyFactoryArtifactRef(review.data.review, {
    "factory-store": input.factoryStore.projectRoot,
    repository,
  });
  if (review.data.blockingFindings)
    verifyFactoryArtifactRef(review.data.blockingFindings, {
      "factory-store": input.factoryStore.projectRoot,
      repository,
    });
}

type FactoryContinuationReactionInput = {
  events: readonly FactoryLifecycleEvent[];
  causationEventId: string;
  phase: "planning" | "implementation";
  handler: FactoryHandler;
  attempt: number;
  phaseRunId: string;
  workItemKey: string;
  roots: { "factory-store": string; repository: string };
};

export function resolveFactoryContinuationForReaction(input: FactoryContinuationReactionInput) {
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

export function loadFactoryContinuationForReaction(input: FactoryContinuationReactionInput) {
  const continuation = resolveFactoryContinuationForReaction(input);
  return continuation
    ? {
        ...continuation,
        response: readFactoryContinuationResponse(continuation.event, input.roots),
      }
    : undefined;
}

export function loadFactoryContinuationForReview(input: {
  events: readonly FactoryLifecycleEvent[];
  phase: "planning" | "implementation";
  reaction: { causationEventId: string; attempt: number };
  candidate: Extract<
    FactoryLifecycleEvent,
    { type: "planning.candidate.produced" | "implementation.candidate.produced" }
  >;
  phaseRunId: string;
  workItemKey: string;
  roots: FactoryContinuationReactionInput["roots"];
}) {
  const reviewHandler =
    input.phase === "planning" ? "reviewPlanCandidate" : "reviewImplementationCandidate";
  const producerHandler =
    input.phase === "planning" ? "producePlanCandidate" : "produceImplementationCandidate";
  return (
    loadFactoryContinuationForReaction({
      events: input.events,
      causationEventId: input.reaction.causationEventId,
      phase: input.phase,
      handler: reviewHandler,
      attempt: input.reaction.attempt,
      phaseRunId: input.phaseRunId,
      workItemKey: input.workItemKey,
      roots: input.roots,
    }) ??
    loadFactoryContinuationForReaction({
      events: input.events,
      causationEventId: input.candidate.data.causationEventId,
      phase: input.phase,
      handler: producerHandler,
      attempt: input.candidate.data.attempt,
      phaseRunId: input.phaseRunId,
      workItemKey: input.workItemKey,
      roots: input.roots,
    })
  );
}

export function readFactoryContinuationResponse(
  event: Extract<FactoryLifecycleEvent, { type: "factory.continuation.recorded" }>,
  roots: FactoryContinuationReactionInput["roots"],
): string {
  return readFileSync(verifyFactoryArtifactRef(event.data.response, roots), "utf8");
}
