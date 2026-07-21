import { createHash } from "node:crypto";
import { eventType } from "inngest";
import { z } from "zod";

export const LINEAR_POLL_REQUESTED_EVENT_NAME = "linear/poll.requested";
export const LINEAR_POLL_REQUESTED_EVENT_VERSION = "1";
export const LINEAR_ISSUE_REVISION_EVENT_NAME = "linear/issue.revision-observed";
export const LINEAR_ISSUE_REVISION_EVENT_VERSION = "1";
export const LINEAR_ISSUE_REVISION_EVENT_ID_PREFIX = "linear-issue-revision-v1:";

const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "");

export const LinearPollRequestedDataSchema = z.object({}).strict();

export const LinearIssueRevisionDataSchema = z
  .object({
    issueId: nonEmptyStringSchema,
    issueIdentifier: nonEmptyStringSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type LinearIssueRevisionData = Readonly<z.infer<typeof LinearIssueRevisionDataSchema>>;

export const LinearPollRequestedEvent = eventType(LINEAR_POLL_REQUESTED_EVENT_NAME, {
  schema: LinearPollRequestedDataSchema,
  version: LINEAR_POLL_REQUESTED_EVENT_VERSION,
});

export const LinearIssueRevisionObservedEvent = eventType(LINEAR_ISSUE_REVISION_EVENT_NAME, {
  schema: LinearIssueRevisionDataSchema,
  version: LINEAR_ISSUE_REVISION_EVENT_VERSION,
});

export function linearIssueRevisionEventId(data: LinearIssueRevisionData): string {
  const parsed = LinearIssueRevisionDataSchema.parse(data);
  const identity = [
    LINEAR_ISSUE_REVISION_EVENT_NAME,
    LINEAR_ISSUE_REVISION_EVENT_VERSION,
    parsed.issueId,
    parsed.updatedAt,
  ];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${LINEAR_ISSUE_REVISION_EVENT_ID_PREFIX}${digest}`;
}

export function createLinearIssueRevisionObservedEvent(data: LinearIssueRevisionData) {
  const parsed = LinearIssueRevisionDataSchema.parse(data);
  return LinearIssueRevisionObservedEvent.create(parsed, {
    id: linearIssueRevisionEventId(parsed),
  });
}
