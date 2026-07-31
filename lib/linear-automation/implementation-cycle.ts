import { createHash } from "node:crypto";
import { SpecIssueReferenceSchema } from "../spec/schema.ts";
import {
  WORK_REQUEST_EVENT_ID_PREFIX,
  workRequestEventId,
  type WorkRequestData,
} from "./events/work-events.ts";

export const IMPLEMENTATION_REVIEW_ROUNDS = [0, 1] as const;
export type ImplementationReviewRound = (typeof IMPLEMENTATION_REVIEW_ROUNDS)[number];

const WORK_REQUEST_ID = new RegExp(`^${WORK_REQUEST_EVENT_ID_PREFIX}[0-9a-f]{64}$`);

export type ImplementationCycleIdentity = Readonly<{
  key: string;
  reviewStepId: string;
  revisionStepId: string;
  checkpointStepId: string;
  checkpointId: string;
  publishStepId: string;
  projectStepId: string;
  commentIdentity: string;
}>;

export function implementationWorkIdentity(event: WorkRequestData): Readonly<{
  workId: string;
  branch: string;
}> {
  const workId = workRequestEventId("implement", event);
  const digest = workId.slice(WORK_REQUEST_EVENT_ID_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Implementation work request ID has no stable digest.");
  }
  const reference = SpecIssueReferenceSchema.parse(event.issueIdentifier);
  return Object.freeze({
    workId,
    branch: `harness/implementation/${reference}-${digest.slice(0, 12)}`,
  });
}

export function implementationCycleIdentity(input: {
  workRequestId: string;
  reviewRound: ImplementationReviewRound;
  checkpointRevision: string;
}): ImplementationCycleIdentity {
  if (!WORK_REQUEST_ID.test(input.workRequestId)) {
    throw new Error("Implementation work request ID is invalid.");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.checkpointRevision)) {
    throw new Error("Implementation checkpoint revision is invalid.");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "harness-implementation-cycle",
        input.workRequestId,
        input.reviewRound,
        input.checkpointRevision,
      ]),
    )
    .digest("hex");
  const key = `implementation-cycle-v1:r${input.reviewRound}:${digest}`;
  const stepId = (operation: string) => `${operation}-linear-implementation-v1:${digest}`;
  return Object.freeze({
    key,
    reviewStepId: stepId("review"),
    revisionStepId: stepId("revise"),
    checkpointStepId: stepId("checkpoint"),
    checkpointId: `${key}:checkpoint`,
    publishStepId: stepId("publish"),
    projectStepId: stepId("project"),
    commentIdentity: `${key}:comment`,
  });
}

export function implementationCommentMarker(
  event: WorkRequestData,
  outcome: "needs-input" | "zero-change" | "published" | "failure" | "cleanup-failure",
): string {
  return `<!-- harness:linear-implementation:${workRequestEventId("implement", event)}:${outcome} -->`;
}

export function implementationCycleCommentMarker(identity: string, outcome: string): string {
  return `<!-- harness:linear-implementation:${identity}:${outcome} -->`;
}
