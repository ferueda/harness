import { describe, expect, it } from "vitest";
import {
  createLinearIssueReadinessCheckRequestedEvent,
  LINEAR_ISSUE_READINESS_CHECK_EVENT_ID_PREFIX,
  LINEAR_ISSUE_READINESS_CHECK_EVENT_NAME,
  LINEAR_ISSUE_READINESS_CHECK_EVENT_VERSION,
  LinearIssueReadinessCheckDataSchema,
  LinearIssueReadinessCheckRequestedEvent,
  linearIssueReadinessCheckEventId,
} from "./linear-readiness-events.ts";

const issue = {
  issueId: "issue-1",
  issueIdentifier: "FER-270",
};

describe("Linear readiness-check events", () => {
  it("locks a strict versioned identity-only contract", () => {
    expect(LinearIssueReadinessCheckRequestedEvent).toMatchObject({
      name: LINEAR_ISSUE_READINESS_CHECK_EVENT_NAME,
      version: LINEAR_ISSUE_READINESS_CHECK_EVENT_VERSION,
    });
    expect(LinearIssueReadinessCheckDataSchema.safeParse(issue).success).toBe(true);
    expect(
      LinearIssueReadinessCheckDataSchema.safeParse({
        ...issue,
        updatedAt: "2026-07-22T01:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("uses the poll cycle for delivery identity without adding it to event data", () => {
    const first = linearIssueReadinessCheckEventId(issue, "poll-cycle-1");
    const retried = linearIssueReadinessCheckEventId({ ...issue }, "poll-cycle-1");
    const nextCycle = linearIssueReadinessCheckEventId(issue, "poll-cycle-2");

    expect(first).toBe(retried);
    expect(first).not.toBe(nextCycle);
    expect(first).toMatch(new RegExp(`^${LINEAR_ISSUE_READINESS_CHECK_EVENT_ID_PREFIX}`));
    expect(createLinearIssueReadinessCheckRequestedEvent(issue, "poll-cycle-1")).toMatchObject({
      id: first,
      name: LINEAR_ISSUE_READINESS_CHECK_EVENT_NAME,
      v: LINEAR_ISSUE_READINESS_CHECK_EVENT_VERSION,
      data: issue,
    });
  });
});
