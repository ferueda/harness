import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { aggregateVerdict } from "./aggregate.ts";
import { verifyFactoryArtifactRef, type FactoryArtifactRef } from "./factory-artifact-ref.ts";
import type { FactoryHandler, FactoryPhase } from "./factory-action-contract.ts";
import { readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryActionEvent, FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import {
  FactoryImplementationCandidateEvidenceSchema,
  FactoryImplementationReviewEvidenceSchema,
} from "./factory-implementation-review-evidence.ts";
import {
  assertTerminalReviewVerdict,
  factoryImplementationReviewContractFingerprint,
  FactoryImplementationReviewCheckpointSchema,
} from "./factory-implementation-review-checkpoint.ts";
import { factoryPhaseBaseSha } from "./factory-phase-git.ts";
import { readFactoryPhaseRunIdentity, type FactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import type { FactoryRunMeta } from "./factory-run-context.ts";
import { FactoryTriageOutputSchema, parseFactoryWorkItem } from "./factory-schemas.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";
import { assertFactoryTriageRunMetaIdentity } from "./factory-triage-result-auth.ts";
import { ReviewOutputSchema } from "./schemas.ts";

type AuthenticationInput = {
  projectRoot: string;
  factoryStateRoot: string;
  workItemKey: string;
  actionDir: string;
  workspaceRef: string;
  factoryStore: FactoryStoreMeta;
  handler: FactoryHandler;
  event: FactoryActionEvent;
};

/** Authenticate a staged terminal result using only immutable Factory-store evidence. */
export function authenticateFactoryActionResult(input: AuthenticationInput): void {
  const { event } = input;
  if (event.data.execution.workspaceRef !== input.workspaceRef)
    throw new Error("Factory action result workspace identity mismatch");
  const runDir = resolve(input.projectRoot, "runs", "factory", event.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(runDir);
  const expectedPhase = handlerPhase(input.handler);
  if (identity.phase !== expectedPhase)
    throw new Error("Factory action result phase identity mismatch");

  const authenticate = createArtifactAuthenticator(input);
  authenticate(event.data.execution.runRef);
  for (const evidence of event.data.evidence) authenticate(evidence);

  const events = readFactoryActionEvents(input.factoryStateRoot, input.workItemKey, {
    mode: "inspection",
  });
  if (event.type === "factory.action.failed") {
    authenticateFailure(event, input.handler, events, identity, runDir, input, authenticate);
    return;
  }
  switch (input.handler) {
    case "triageWorkItem":
      authenticateTriage(event, authenticate);
      return;
    case "producePlanCandidate":
      authenticatePlanCandidate(event, authenticate);
      return;
    case "reviewPlanCandidate":
      authenticatePlanReview(event, events, authenticate);
      return;
    case "produceImplementationCandidate":
      authenticateImplementationCandidate(event, factoryPhaseBaseSha(identity), authenticate);
      return;
    case "reviewImplementationCandidate":
      if (identity.phase !== "implementation")
        throw new Error("Factory implementation review phase identity mismatch");
      authenticateImplementationReview(event, events, identity, authenticate);
      return;
  }
}

type AuthenticateArtifact = (ref: FactoryArtifactRef) => string;

function createArtifactAuthenticator(input: AuthenticationInput): AuthenticateArtifact {
  const projectRoot = resolve(input.projectRoot);
  const actionPath = relative(projectRoot, resolve(input.actionDir)).replaceAll("\\", "/");
  const prefix = `${actionPath}/`;
  return (ref) => {
    if (ref.base !== "factory-store" || !ref.path.startsWith(prefix))
      throw new Error("Factory action result evidence is outside its immutable action directory");
    return verifyFactoryArtifactRef(ref, {
      "factory-store": projectRoot,
      // Pre-Grove recovery never authenticates evidence through a repository checkout.
      repository: projectRoot,
    });
  };
}

function authenticateFailure(
  event: Extract<FactoryActionEvent, { type: "factory.action.failed" }>,
  handler: FactoryHandler,
  events: FactoryLifecycleEvent[],
  identity: FactoryPhaseRunIdentity,
  runDir: string,
  input: AuthenticationInput,
  authenticate: AuthenticateArtifact,
): void {
  if (
    event.data.phase !== handlerPhase(handler) ||
    !sameRef(event.data.execution.runRef, event.data.evidence[0]) ||
    !event.data.execution.runRef.path.endsWith(
      handler === "triageWorkItem" ? "/evidence/failure.json" : "/failure.json",
    )
  )
    throw new Error("Factory action failure evidence identity mismatch");
  const failure = JsonRecordSchema.parse(
    JSON.parse(readFileSync(authenticate(event.data.execution.runRef), "utf8")),
  );
  if (handler === "triageWorkItem") {
    const workItem = parseFactoryWorkItem(
      JSON.parse(readFileSync(join(runDir, "context/work-item.json"), "utf8")),
    );
    assertFactoryTriageRunMetaIdentity(failure as FactoryRunMeta, {
      runDir,
      workItem,
      factoryStore: input.factoryStore,
    });
  }
  if (
    failure.failureKind !== event.data.failureKind ||
    (failure.message !== event.data.message && failure.error !== event.data.message)
  )
    throw new Error("Factory action failure conflicts with immutable evidence");
  if (event.data.retainedCandidateEventId)
    requireCandidate(events, event.data.retainedCandidateEventId, event.phaseRunId);

  if (handler !== "reviewImplementationCandidate" && event.data.evidence.length !== 1)
    throw new Error("Factory action failure has unexpected evidence");
  if (handler === "reviewImplementationCandidate" && event.data.evidence.length > 2)
    throw new Error("Factory implementation review failure has unexpected evidence");
  const checkpointRef = event.data.evidence[1];
  if (checkpointRef) {
    if (identity.phase !== "implementation" || !event.data.retainedCandidateEventId)
      throw new Error("Factory implementation review failure checkpoint has no candidate");
    const candidate = requireCandidate(
      events,
      event.data.retainedCandidateEventId,
      event.phaseRunId,
    );
    if (candidate.type !== "implementation.candidate.produced")
      throw new Error("Factory implementation review failure checkpoint has wrong candidate");
    const checkpoint = authenticateCheckpoint(checkpointRef, authenticate);
    assertCheckpointIdentity(checkpoint, {
      phaseRunId: event.phaseRunId,
      reviewRound: event.data.attempt,
      candidateAttempt: candidate.data.attempt,
      base: factoryPhaseBaseSha(identity),
      commit: candidate.data.commit,
      tree: candidate.data.tree,
      executionProfile: identity.actions.reviewImplementationCandidate,
    });
  }
}

function authenticateTriage(
  event: Exclude<FactoryActionEvent, { type: "factory.action.failed" }>,
  authenticate: AuthenticateArtifact,
): void {
  if (event.type !== "triage.work_item.completed" || event.data.evidence.length !== 2)
    throw new Error("Factory triage result evidence is incomplete");
  if (!sameRef(event.data.execution.runRef, event.data.evidence[0]))
    throw new Error("Factory triage result omits its execution evidence");
  if (
    !event.data.execution.runRef.path.endsWith("/evidence/summary.md") ||
    !event.data.evidence[1]!.path.endsWith("/evidence/factory-triage.json")
  )
    throw new Error("Factory triage result uses unexpected evidence paths");
  const triage = FactoryTriageOutputSchema.parse(
    JSON.parse(readFileSync(authenticate(event.data.evidence[1]!), "utf8")),
  );
  if (triage.route !== event.data.route || triage.rationale !== event.data.rationale)
    throw new Error("Factory triage result conflicts with immutable evidence");
}

function authenticatePlanCandidate(
  event: Exclude<FactoryActionEvent, { type: "factory.action.failed" }>,
  authenticate: AuthenticateArtifact,
): void {
  if (event.type === "planning.candidate.produced") {
    if (
      event.data.evidence.length !== 1 ||
      !sameRef(event.data.candidate, event.data.evidence[0]) ||
      !event.data.execution.runRef.path.endsWith("/planner.raw.json")
    )
      throw new Error("Factory planning candidate evidence is incomplete");
    authenticate(event.data.candidate);
    return;
  }
  if (event.type === "planning.input.required") {
    if (event.data.evidence.length !== 1 || !sameRef(event.data.questions, event.data.evidence[0]))
      throw new Error("Factory planning question evidence is incomplete");
    z.array(z.string().min(1))
      .min(1)
      .parse(JSON.parse(readFileSync(authenticate(event.data.questions), "utf8")));
    return;
  }
  throw new Error("Factory planning candidate result type mismatch");
}

function authenticatePlanReview(
  event: Exclude<FactoryActionEvent, { type: "factory.action.failed" }>,
  events: FactoryLifecycleEvent[],
  authenticate: AuthenticateArtifact,
): void {
  if (event.type !== "planning.review.completed")
    throw new Error("Factory planning review result type mismatch");
  const candidate = requireCandidate(events, event.data.candidateEventId, event.phaseRunId);
  if (
    candidate.type !== "planning.candidate.produced" ||
    candidate.data.attempt !== event.data.candidateAttempt ||
    !sameRef(event.data.review, event.data.evidence[0])
  )
    throw new Error("Factory planning review conflicts with its candidate");
  const review = ReviewOutputSchema.parse(
    JSON.parse(readFileSync(authenticate(event.data.review), "utf8")),
  );
  if (review.verdict !== event.data.verdict)
    throw new Error("Factory planning review verdict conflicts with immutable evidence");
  if (
    event.data.evidence.length !== (event.data.blockingFindings ? 2 : 1) ||
    Boolean(event.data.blockingFindings) !== (review.verdict === "needs_changes")
  )
    throw new Error("Factory planning review evidence set is incomplete");
  authenticateOptionalBlocking(event.data, authenticate);
}

function authenticateImplementationCandidate(
  event: Exclude<FactoryActionEvent, { type: "factory.action.failed" }>,
  baseSha: string,
  authenticate: AuthenticateArtifact,
): void {
  if (event.type !== "implementation.candidate.produced")
    throw new Error("Factory implementation candidate result type mismatch");
  if (!sameRef(event.data.candidate, event.data.evidence[0]))
    throw new Error("Factory implementation candidate evidence is incomplete");
  const manifest = FactoryImplementationCandidateEvidenceSchema.parse(
    JSON.parse(readFileSync(authenticate(event.data.candidate), "utf8")),
  );
  if (
    manifest.phaseRunId !== event.phaseRunId ||
    manifest.attempt !== event.data.attempt ||
    manifest.base !== baseSha ||
    manifest.ref !== `refs/harness/factory/${event.phaseRunId}/${event.data.attempt}` ||
    manifest.commit !== event.data.commit ||
    manifest.tree !== event.data.tree ||
    manifest.effectiveSession.provider !== event.data.effectiveSession.provider ||
    manifest.effectiveSession.id !== event.data.effectiveSession.id
  )
    throw new Error("Factory implementation candidate conflicts with immutable evidence");
  if (
    event.data.evidence.length !== 3 ||
    !sameRef(manifest.artifacts.raw, event.data.execution.runRef) ||
    !sameRef(manifest.artifacts.raw, event.data.evidence[1]) ||
    !sameRef(manifest.artifacts.stream, event.data.evidence[2])
  )
    throw new Error("Factory implementation candidate artifact set is incomplete");
  for (const ref of Object.values(manifest.artifacts)) authenticate(ref);
}

function authenticateImplementationReview(
  event: Exclude<FactoryActionEvent, { type: "factory.action.failed" }>,
  events: FactoryLifecycleEvent[],
  identity: Extract<FactoryPhaseRunIdentity, { phase: "implementation" }>,
  authenticate: AuthenticateArtifact,
): void {
  if (event.type !== "implementation.review.completed")
    throw new Error("Factory implementation review result type mismatch");
  const candidate = requireCandidate(events, event.data.candidateEventId, event.phaseRunId);
  if (
    candidate.type !== "implementation.candidate.produced" ||
    candidate.data.attempt !== event.data.candidateAttempt ||
    !sameRef(event.data.review, event.data.evidence[0])
  )
    throw new Error("Factory implementation review conflicts with its candidate");
  const manifest = FactoryImplementationReviewEvidenceSchema.parse(
    JSON.parse(readFileSync(authenticate(event.data.review), "utf8")),
  );
  const baseSha = factoryPhaseBaseSha(identity);
  if (
    manifest.phaseRunId !== event.phaseRunId ||
    manifest.reviewRound !== event.data.attempt ||
    manifest.candidateAttempt !== candidate.data.attempt ||
    manifest.base !== baseSha ||
    manifest.commit !== candidate.data.commit ||
    manifest.tree !== candidate.data.tree ||
    manifest.verdict !== event.data.verdict ||
    !sameRef(manifest.reviewers.implementation, event.data.evidence[1]) ||
    !sameRef(manifest.reviewers.quality, event.data.evidence[2])
  )
    throw new Error("Factory implementation review conflicts with immutable evidence");
  const implementation = ReviewOutputSchema.parse(
    JSON.parse(readFileSync(authenticate(manifest.reviewers.implementation), "utf8")),
  );
  const quality = ReviewOutputSchema.parse(
    JSON.parse(readFileSync(authenticate(manifest.reviewers.quality), "utf8")),
  );
  assertTerminalReviewVerdict("implementation", implementation);
  assertTerminalReviewVerdict("quality", quality);
  if (aggregateVerdict(implementation, quality) !== event.data.verdict)
    throw new Error("Factory implementation aggregate verdict mismatch");
  if (Boolean(event.data.blockingFindings) !== Boolean(manifest.blockingFindings))
    throw new Error("Factory review blocking evidence mismatch");
  if (event.data.evidence.length !== (event.data.blockingFindings ? 5 : 4))
    throw new Error("Factory implementation review evidence set is incomplete");
  authenticateOptionalBlocking(event.data, authenticate, manifest.blockingFindings);
  const checkpoint = event.data.evidence.at(-1);
  if (!checkpoint || sameRef(checkpoint, event.data.evidence[2]))
    throw new Error("Factory implementation review checkpoint is missing");
  const authenticatedCheckpoint = authenticateCheckpoint(checkpoint, authenticate);
  assertCheckpointIdentity(authenticatedCheckpoint, {
    phaseRunId: event.phaseRunId,
    reviewRound: event.data.attempt,
    candidateAttempt: candidate.data.attempt,
    base: baseSha,
    commit: candidate.data.commit,
    tree: candidate.data.tree,
    executionProfile: identity.actions.reviewImplementationCandidate,
  });
  if (
    !sameRef(
      authenticatedCheckpoint.roles.implementation?.output,
      manifest.reviewers.implementation,
    ) ||
    !sameRef(authenticatedCheckpoint.roles.quality?.output, manifest.reviewers.quality)
  )
    throw new Error("Factory implementation review checkpoint conflicts with review evidence");
}

function authenticateOptionalBlocking(
  data: {
    evidence: FactoryArtifactRef[];
    blockingFindings?: FactoryArtifactRef;
  },
  authenticate: AuthenticateArtifact,
  manifestRef?: FactoryArtifactRef,
): void {
  if (!data.blockingFindings) return;
  if (manifestRef && !sameRef(data.blockingFindings, manifestRef))
    throw new Error("Factory review blocking evidence mismatch");
  if (!data.evidence.some((ref) => sameRef(ref, data.blockingFindings!)))
    throw new Error("Factory review omits blocking evidence");
  z.array(z.record(z.string(), z.unknown()))
    .min(1)
    .parse(JSON.parse(readFileSync(authenticate(data.blockingFindings), "utf8")));
}

function authenticateCheckpoint(ref: FactoryArtifactRef, authenticate: AuthenticateArtifact) {
  const checkpoint = FactoryImplementationReviewCheckpointSchema.parse(
    JSON.parse(readFileSync(authenticate(ref), "utf8")),
  );
  for (const role of Object.values(checkpoint.roles)) {
    if (!role) continue;
    authenticate(role.prompt);
    const output = ReviewOutputSchema.parse(
      JSON.parse(readFileSync(authenticate(role.output), "utf8")),
    );
    const name = role === checkpoint.roles.implementation ? "implementation" : "quality";
    assertTerminalReviewVerdict(name, output);
    if (role.contractSha256 !== factoryImplementationReviewContractFingerprint(name))
      throw new Error("Factory implementation review checkpoint contract mismatch");
  }
  return checkpoint;
}

function assertCheckpointIdentity(
  actual: ReturnType<typeof FactoryImplementationReviewCheckpointSchema.parse>,
  expected: Omit<
    ReturnType<typeof FactoryImplementationReviewCheckpointSchema.parse>,
    "version" | "roles"
  >,
): void {
  const { version: _version, roles: _roles, ...identity } = actual;
  if (JSON.stringify(identity) !== JSON.stringify(expected))
    throw new Error("Factory implementation review checkpoint identity mismatch");
}

function requireCandidate(
  events: FactoryLifecycleEvent[],
  eventId: string,
  phaseRunId: string,
): Extract<
  FactoryLifecycleEvent,
  { type: "planning.candidate.produced" | "implementation.candidate.produced" }
> {
  const candidate = events.find((event) => event.id === eventId);
  if (
    !candidate ||
    (candidate.type !== "planning.candidate.produced" &&
      candidate.type !== "implementation.candidate.produced") ||
    candidate.phaseRunId !== phaseRunId
  )
    throw new Error("Factory action result has no authenticated causative candidate");
  return candidate;
}

const JsonRecordSchema = z.record(z.string(), z.unknown());

function sameRef(left: FactoryArtifactRef | undefined, right: FactoryArtifactRef | undefined) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

function handlerPhase(handler: FactoryHandler): FactoryPhase {
  if (handler === "triageWorkItem") return "triage";
  if (handler === "producePlanCandidate" || handler === "reviewPlanCandidate") return "planning";
  return "implementation";
}
