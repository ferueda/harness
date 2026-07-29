import { createHash } from "node:crypto";
import type { SpecReviewProvenance } from "../spec-review/review.ts";
import type { SpecReviewArtifact, SpecReviewDecision } from "../spec-review/schema.ts";
import {
  SpecRevisionAuthorSessionSchema,
  SpecRevisionReviewSchema,
  type SpecRevisionAuthorSession,
  type SpecRevisionReview,
} from "../spec/revise-schema.ts";
import type { SpecSessionReference } from "../spec/spec.ts";
import { WORK_REQUEST_EVENT_ID_PREFIX } from "./events/work-events.ts";

export const SPEC_CYCLE_REVIEW_ROUNDS = [0, 1, 2] as const;
export const SPEC_CYCLE_MAX_REVISIONS = 2;

export type SpecCycleReviewRound = (typeof SPEC_CYCLE_REVIEW_ROUNDS)[number];

export type SpecCycleRoundIdentity = Readonly<{
  key: string;
  checkpointDigest: string;
  openBeforeReviewStepId: string;
  reviewStepId: string;
  openAfterReviewStepId: string;
  authorityAfterReviewStepId: string;
  authorityBeforeRevisionStepId: string;
  revisionStepId: string;
  authorityAfterRevisionStepId: string;
  inspectRevisionStepId: string;
  childCheckpointStepId: string;
  childCheckpointId: string;
  publishStepId: string;
  projectStepId: string;
  commentIdentity: string;
}>;

const FULL_GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const WORK_REQUEST_ID = new RegExp(`^${WORK_REQUEST_EVENT_ID_PREFIX}[0-9a-f]{64}$`);
const IDENTITY_VERSION = 1;

export function createInitialSpecCheckpointIdentity(input: {
  workRequestId: string;
  parentRevision: string;
}): Readonly<{
  stepId: string;
  checkpointId: string;
}> {
  assertWorkRequestId(input.workRequestId);
  if (!FULL_GIT_REVISION.test(input.parentRevision)) {
    throw new Error("Initial Spec checkpoint parent must be a full lowercase Git revision.");
  }
  const digest = identityDigest(["initial-checkpoint", input.workRequestId, input.parentRevision]);
  return Object.freeze({
    stepId: `checkpoint-linear-spec-initial-v1:${digest}`,
    checkpointId: `spec-cycle-v1:initial-checkpoint:${digest}`,
  });
}

export function createSpecCycleRoundIdentity(input: {
  workRequestId: string;
  reviewRound: SpecCycleReviewRound;
  checkpointRevision: string;
}): SpecCycleRoundIdentity {
  assertWorkRequestId(input.workRequestId);
  assertReviewRound(input.reviewRound);
  if (!FULL_GIT_REVISION.test(input.checkpointRevision)) {
    throw new Error("Spec cycle checkpoint revision must be a full lowercase Git revision.");
  }

  const checkpointDigest = sha256(input.checkpointRevision);
  const digest = identityDigest([
    "round",
    input.workRequestId,
    input.reviewRound,
    input.checkpointRevision,
  ]);
  const key = `spec-cycle-v1:r${input.reviewRound}:${digest}`;
  const stepId = (operation: string): string =>
    `${operation}-linear-spec-v1:r${input.reviewRound}:${digest}`;

  return Object.freeze({
    key,
    checkpointDigest,
    openBeforeReviewStepId: stepId("open-before-review"),
    reviewStepId: stepId("review"),
    openAfterReviewStepId: stepId("open-after-review"),
    authorityAfterReviewStepId: stepId("authority-after-review"),
    authorityBeforeRevisionStepId: stepId("authority-before-revision"),
    revisionStepId: stepId("revise"),
    authorityAfterRevisionStepId: stepId("authority-after-revision"),
    inspectRevisionStepId: stepId("inspect-revision"),
    childCheckpointStepId: stepId("checkpoint-revision"),
    childCheckpointId: `${key}:child-checkpoint`,
    publishStepId: stepId("publish"),
    projectStepId: stepId("project"),
    commentIdentity: `${key}:comment`,
  });
}

export function toSpecRevisionAuthorSession(
  session: SpecSessionReference | null,
): SpecRevisionAuthorSession | null {
  if (!session) return null;
  return SpecRevisionAuthorSessionSchema.parse({
    version: 1,
    provider: session.provider,
    id: session.id,
  });
}

export function toSpecRevisionReview(input: {
  artifact: SpecReviewArtifact;
  decision: Extract<SpecReviewDecision, { outcome: "changes-requested" }>;
  provenance: Pick<SpecReviewProvenance, "rubricVersion">;
}): SpecRevisionReview {
  return SpecRevisionReviewSchema.parse({
    reviewedRevision: input.artifact.revision,
    rubricVersion: input.provenance.rubricVersion,
    findings: input.decision.findings,
  });
}

function assertWorkRequestId(workRequestId: string): void {
  if (!WORK_REQUEST_ID.test(workRequestId)) {
    throw new Error("Spec cycle work request ID is invalid.");
  }
}

function assertReviewRound(reviewRound: number): asserts reviewRound is SpecCycleReviewRound {
  if (!SPEC_CYCLE_REVIEW_ROUNDS.includes(reviewRound as SpecCycleReviewRound)) {
    throw new Error("Spec cycle review round must be 0, 1, or 2.");
  }
}

function identityDigest(parts: readonly unknown[]): string {
  return sha256(JSON.stringify(["harness-spec-cycle", IDENTITY_VERSION, ...parts]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
