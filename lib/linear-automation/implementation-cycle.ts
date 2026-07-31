import { createHash } from "node:crypto";
import { SpecIssueReferenceSchema } from "../spec/schema.ts";
import {
  WORK_REQUEST_EVENT_ID_PREFIX,
  workRequestEventId,
  type ImplementationWorkRequestData,
} from "./events/work-events.ts";

const WORK_REQUEST_ID = new RegExp(`^${WORK_REQUEST_EVENT_ID_PREFIX}[0-9a-f]{64}$`);

export type ImplementationCycleIdentity = Readonly<{
  key: string;
  reviewStepId: string;
  checkpointStepId: string;
  checkpointId: string;
  publishStepId: string;
  commentIdentity: string;
}>;

type ImplementationReviewRound = 0 | 1;

export function implementationWorkIdentity(event: ImplementationWorkRequestData): Readonly<{
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
    checkpointStepId: stepId("checkpoint"),
    checkpointId: `${key}:checkpoint`,
    publishStepId: stepId("publish"),
    commentIdentity: `${key}:comment`,
  });
}

export function implementationCommentMarker(
  event: ImplementationWorkRequestData,
  outcome: "needs-input" | "zero-change" | "published" | "failure" | "cleanup-failure",
): string {
  return `<!-- harness:linear-implementation:${workRequestEventId("implement", event)}:${outcome} -->`;
}

export function implementationCycleCommentMarker(identity: string, outcome: string): string {
  return `<!-- harness:linear-implementation:${identity}:${outcome} -->`;
}
