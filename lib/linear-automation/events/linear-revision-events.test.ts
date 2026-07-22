import { describe, expect, it } from "vitest";
import {
  createLinearIssueRevisionObservedEvent,
  LINEAR_ISSUE_REVISION_EVENT_ID_PREFIX,
  LINEAR_ISSUE_REVISION_EVENT_NAME,
  LINEAR_ISSUE_REVISION_EVENT_VERSION,
  LINEAR_POLL_REQUESTED_EVENT_NAME,
  LINEAR_POLL_REQUESTED_EVENT_VERSION,
  LinearIssueRevisionDataSchema,
  LinearIssueRevisionObservedEvent,
  linearIssueRevisionEventId,
  LinearPollRequestedDataSchema,
  LinearPollRequestedEvent,
} from "./linear-revision-events.ts";

const revision = {
  issueId: "issue-1",
  issueIdentifier: "FER-248",
  updatedAt: "2026-07-20T20:00:00.000Z",
};

describe("Linear revision events", () => {
  it("locks strict versioned event contracts", () => {
    expect(LinearPollRequestedEvent).toMatchObject({
      name: LINEAR_POLL_REQUESTED_EVENT_NAME,
      version: LINEAR_POLL_REQUESTED_EVENT_VERSION,
    });
    expect(LinearIssueRevisionObservedEvent).toMatchObject({
      name: LINEAR_ISSUE_REVISION_EVENT_NAME,
      version: LINEAR_ISSUE_REVISION_EVENT_VERSION,
    });
    expect(LinearPollRequestedDataSchema.safeParse({}).success).toBe(true);
    expect(LinearPollRequestedDataSchema.safeParse({ projectId: "caller-selected" }).success).toBe(
      false,
    );
    expect(LinearIssueRevisionDataSchema.safeParse(revision).success).toBe(true);
    expect(
      LinearIssueRevisionDataSchema.safeParse({ ...revision, updatedAt: "not-a-date" }).success,
    ).toBe(false);
  });

  it("uses issue identity and revision rather than poll time or list order", () => {
    const first = linearIssueRevisionEventId(revision);
    const repeated = linearIssueRevisionEventId({ ...revision });
    const changed = linearIssueRevisionEventId({
      ...revision,
      updatedAt: "2026-07-20T20:01:00.000Z",
    });

    expect(first).toBe(repeated);
    expect(first).not.toBe(changed);
    expect(first).toMatch(new RegExp(`^${LINEAR_ISSUE_REVISION_EVENT_ID_PREFIX}`));
    expect(createLinearIssueRevisionObservedEvent(revision)).toMatchObject({
      id: first,
      name: LINEAR_ISSUE_REVISION_EVENT_NAME,
      v: LINEAR_ISSUE_REVISION_EVENT_VERSION,
      data: revision,
    });
  });
});
