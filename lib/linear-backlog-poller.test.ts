import { Inngest } from "inngest";
import { InngestTestEngine } from "@inngest/test";
import { describe, expect, it, vi } from "vitest";
import {
  LINEAR_ISSUE_REVISION_EVENT_NAME,
  LinearPollRequestedEvent,
} from "./inngest/linear-revision-events.ts";
import {
  createLinearBacklogPoller,
  LINEAR_BACKLOG_LIST_STEP_ID,
  LINEAR_BACKLOG_POLL_CRON,
  LINEAR_BACKLOG_POLL_FUNCTION_ID,
  LINEAR_BACKLOG_POLL_LIMIT,
  LINEAR_BACKLOG_POLL_RETRIES,
  LINEAR_BACKLOG_SEND_STEP_ID,
  type LinearBacklogPollerLinear,
} from "./linear-backlog-poller.ts";

const config = {
  teamId: "team-1",
  projectId: "project-1",
  stateId: "state-backlog",
};

function client() {
  return new Inngest({
    id: "linear-backlog-poller-test",
    eventKey: "test",
    fetch: async () => Response.json({ ids: ["sent-event"], status: 200 }),
  });
}

function poller(linear: LinearBacklogPollerLinear) {
  return createLinearBacklogPoller({ client: client(), linear, config });
}

function linear(result: Awaited<ReturnType<LinearBacklogPollerLinear["listIssueRevisions"]>>) {
  const listIssueRevisions = vi.fn<LinearBacklogPollerLinear["listIssueRevisions"]>(async () =>
    Promise.resolve(result),
  );
  return {
    service: { listIssueRevisions } satisfies LinearBacklogPollerLinear,
    listIssueRevisions,
  };
}

function pollEvent() {
  return LinearPollRequestedEvent.create({}, { id: "poll-test" });
}

describe("Linear Backlog poller", () => {
  it("registers the one-minute cron and explicit poll trigger", () => {
    const fake = linear({ revisions: [], truncated: false });

    expect(poller(fake.service).opts).toMatchObject({
      id: LINEAR_BACKLOG_POLL_FUNCTION_ID,
      concurrency: 1,
      retries: LINEAR_BACKLOG_POLL_RETRIES,
      triggers: [{ cron: LINEAR_BACKLOG_POLL_CRON }, LinearPollRequestedEvent],
    });
  });

  it("lists the exact configured Backlog and sends one event per revision", async () => {
    const fake = linear({
      revisions: [
        {
          id: "issue-1",
          identifier: "FER-1",
          updatedAt: "2026-07-20T20:00:00.000Z",
        },
        {
          id: "issue-2",
          identifier: "FER-2",
          updatedAt: "2026-07-20T20:01:00.000Z",
        },
      ],
      truncated: false,
    });
    const output = await new InngestTestEngine({
      function: poller(fake.service),
      events: [pollEvent()],
    }).execute();

    expect(output.error).toBeUndefined();
    expect(output.result).toMatchObject({ outcome: "observed", observed: 2 });
    expect(fake.listIssueRevisions).toHaveBeenCalledExactlyOnceWith({
      ...config,
      limit: LINEAR_BACKLOG_POLL_LIMIT,
    });
    expect(output.ctx.step.run).toHaveBeenCalledWith(
      LINEAR_BACKLOG_LIST_STEP_ID,
      expect.any(Function),
    );
    const sent = vi.mocked(output.ctx.step.sendEvent).mock.calls[0]?.[1];
    expect(sent).toEqual([
      expect.objectContaining({ name: LINEAR_ISSUE_REVISION_EVENT_NAME }),
      expect.objectContaining({ name: LINEAR_ISSUE_REVISION_EVENT_NAME }),
    ]);
    expect(output.ctx.step.sendEvent).toHaveBeenCalledWith(LINEAR_BACKLOG_SEND_STEP_ID, sent);
  });

  it("returns without a send step when the Backlog is empty", async () => {
    const fake = linear({ revisions: [], truncated: false });
    const output = await new InngestTestEngine({
      function: poller(fake.service),
      events: [pollEvent()],
    }).execute();

    expect(output.result).toEqual({ outcome: "empty", observed: 0 });
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("fails visibly instead of sending a truncated Backlog", async () => {
    const fake = linear({ revisions: [], truncated: true });
    const output = await new InngestTestEngine({
      function: poller(fake.service),
      events: [pollEvent()],
    }).execute();

    expect(output.error).toMatchObject({
      message: expect.stringContaining(`${LINEAR_BACKLOG_POLL_LIMIT}-issue limit`),
    });
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("rejects incomplete poller configuration before creating the function", () => {
    const fake = linear({ revisions: [], truncated: false });

    expect(() =>
      createLinearBacklogPoller({
        client: client(),
        linear: fake.service,
        config: { ...config, projectId: "" },
      }),
    ).toThrow(/projectId/);
  });
});
