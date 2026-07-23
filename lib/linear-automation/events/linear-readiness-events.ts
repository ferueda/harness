import { createHash } from "node:crypto";
import { eventType } from "inngest";
import { z } from "zod";

export const LINEAR_ISSUE_READINESS_CHECK_EVENT_NAME = "linear/issue.readiness-check.requested";
export const LINEAR_ISSUE_READINESS_CHECK_EVENT_VERSION = "1";
export const LINEAR_ISSUE_READINESS_CHECK_EVENT_ID_PREFIX = "linear-issue-readiness-check-v1:";

const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "");

export const LinearIssueReadinessCheckDataSchema = z
  .object({
    issueId: nonEmptyStringSchema,
    issueIdentifier: nonEmptyStringSchema,
  })
  .strict();

export type LinearIssueReadinessCheckData = Readonly<
  z.infer<typeof LinearIssueReadinessCheckDataSchema>
>;

export const LinearIssueReadinessCheckRequestedEvent = eventType(
  LINEAR_ISSUE_READINESS_CHECK_EVENT_NAME,
  {
    schema: LinearIssueReadinessCheckDataSchema,
    version: LINEAR_ISSUE_READINESS_CHECK_EVENT_VERSION,
  },
);

export function linearIssueReadinessCheckEventId(
  data: LinearIssueReadinessCheckData,
  pollCycleId: string,
): string {
  const parsed = LinearIssueReadinessCheckDataSchema.parse(data);
  const parsedPollCycleId = nonEmptyStringSchema.parse(pollCycleId);
  const identity = [
    LINEAR_ISSUE_READINESS_CHECK_EVENT_NAME,
    LINEAR_ISSUE_READINESS_CHECK_EVENT_VERSION,
    parsed.issueId,
    parsedPollCycleId,
  ];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${LINEAR_ISSUE_READINESS_CHECK_EVENT_ID_PREFIX}${digest}`;
}

export function createLinearIssueReadinessCheckRequestedEvent(
  data: LinearIssueReadinessCheckData,
  pollCycleId: string,
) {
  const parsed = LinearIssueReadinessCheckDataSchema.parse(data);
  return LinearIssueReadinessCheckRequestedEvent.create(parsed, {
    id: linearIssueReadinessCheckEventId(parsed, pollCycleId),
  });
}
