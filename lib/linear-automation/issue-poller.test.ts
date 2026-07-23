import { Inngest } from "inngest";
import { InngestTestEngine } from "@inngest/test";
import { describe, expect, it, vi } from "vitest";
import { LINEAR_ISSUE_READINESS_CHECK_EVENT_NAME } from "./events/linear-readiness-events.ts";
import {
  LINEAR_ISSUE_REVISION_EVENT_NAME,
  LinearPollRequestedEvent,
} from "./events/linear-revision-events.ts";
import {
  createLinearIssuePoller,
  LINEAR_ISSUE_LIST_STEP_ID,
  LINEAR_ISSUE_POLL_CRON,
  LINEAR_ISSUE_POLL_FUNCTION_ID,
  LINEAR_ISSUE_POLL_LIMIT,
  LINEAR_ISSUE_POLL_RETRIES,
  LINEAR_ISSUE_SEND_STEP_ID,
  type LinearIssuePollerLinear,
} from "./issue-poller.ts";
import type { ListIssueRevisionsResult } from "../linear/types.ts";

const config = {
  teamId: "team-1",
  projectId: "project-1",
  stateIds: {
    backlog: "state-backlog",
    open: "state-open",
  },
};

function client() {
  return new Inngest({
    id: "linear-issue-poller-test",
    eventKey: "test",
    fetch: async () => Response.json({ ids: ["sent-event"], status: 200 }),
  });
}

function poller(
  linear: LinearIssuePollerLinear,
  configOverride: Parameters<typeof createLinearIssuePoller>[0]["config"] = config,
) {
  return createLinearIssuePoller({ client: client(), linear, config: configOverride });
}

function linear(results: Readonly<Record<string, ListIssueRevisionsResult>>) {
  const listIssueRevisions = vi.fn<LinearIssuePollerLinear["listIssueRevisions"]>(
    async ({ stateId }) => results[stateId] ?? { revisions: [], truncated: false },
  );
  return {
    service: { listIssueRevisions } satisfies LinearIssuePollerLinear,
    listIssueRevisions,
  };
}

function pollEvent(id = "poll-test") {
  return LinearPollRequestedEvent.create({}, { id });
}

function revision(id: string, identifier: string, updatedAt: string) {
  return { id, identifier, updatedAt };
}

describe("Linear issue poller", () => {
  it("registers the one-minute cron and explicit poll trigger", () => {
    const fake = linear({});

    expect(poller(fake.service).opts).toMatchObject({
      id: LINEAR_ISSUE_POLL_FUNCTION_ID,
      concurrency: 1,
      retries: LINEAR_ISSUE_POLL_RETRIES,
      triggers: [{ cron: LINEAR_ISSUE_POLL_CRON }, LinearPollRequestedEvent],
    });
  });

  it("keeps Backlog revision identity and adds per-cycle Open readiness checks", async () => {
    const fake = linear({
      [config.stateIds.backlog]: {
        revisions: [revision("issue-1", "FER-1", "2026-07-20T20:00:00.000Z")],
        truncated: false,
      },
      [config.stateIds.open]: {
        revisions: [revision("issue-2", "FER-2", "2026-07-20T20:01:00.000Z")],
        truncated: false,
      },
    });
    const first = await new InngestTestEngine({
      function: poller(fake.service),
      events: [pollEvent("poll-cycle-1")],
    }).execute();
    const repeatedCycle = await new InngestTestEngine({
      function: poller(fake.service),
      events: [pollEvent("poll-cycle-1")],
    }).execute();
    const nextCycle = await new InngestTestEngine({
      function: poller(fake.service),
      events: [pollEvent("poll-cycle-2")],
    }).execute();

    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({
      outcome: "observed",
      observed: 2,
      revisions: 1,
      readinessChecks: 1,
    });
    expect(fake.listIssueRevisions).toHaveBeenCalledWith({
      teamId: config.teamId,
      projectId: config.projectId,
      stateId: config.stateIds.backlog,
      limit: LINEAR_ISSUE_POLL_LIMIT,
    });
    expect(fake.listIssueRevisions).toHaveBeenCalledWith({
      teamId: config.teamId,
      projectId: config.projectId,
      stateId: config.stateIds.open,
      limit: LINEAR_ISSUE_POLL_LIMIT,
    });
    expect(first.ctx.step.run).toHaveBeenCalledWith(
      LINEAR_ISSUE_LIST_STEP_ID,
      expect.any(Function),
    );
    const firstSent = vi.mocked(first.ctx.step.sendEvent).mock.calls[0]?.[1];
    const repeatedSent = vi.mocked(repeatedCycle.ctx.step.sendEvent).mock.calls[0]?.[1];
    const nextSent = vi.mocked(nextCycle.ctx.step.sendEvent).mock.calls[0]?.[1];
    expect(firstSent).toEqual([
      expect.objectContaining({ name: LINEAR_ISSUE_REVISION_EVENT_NAME }),
      expect.objectContaining({ name: LINEAR_ISSUE_READINESS_CHECK_EVENT_NAME }),
    ]);
    expect(first.ctx.step.sendEvent).toHaveBeenCalledWith(LINEAR_ISSUE_SEND_STEP_ID, firstSent);
    expect(eventIds(firstSent)).toEqual(eventIds(repeatedSent));
    expect(eventIds(firstSent)[0]).toBe(eventIds(nextSent)[0]);
    expect(eventIds(firstSent)[1]).not.toBe(eventIds(nextSent)[1]);
  });

  it("observes Backlog only when Open routes are not composed", async () => {
    const fake = linear({
      [config.stateIds.backlog]: {
        revisions: [revision("issue-1", "FER-1", "2026-07-20T20:00:00.000Z")],
        truncated: false,
      },
    });
    const backlogOnly = { ...config, stateIds: { backlog: config.stateIds.backlog } };
    const output = await new InngestTestEngine({
      function: poller(fake.service, backlogOnly),
      events: [pollEvent()],
    }).execute();

    expect(fake.listIssueRevisions).toHaveBeenCalledExactlyOnceWith({
      teamId: config.teamId,
      projectId: config.projectId,
      stateId: config.stateIds.backlog,
      limit: LINEAR_ISSUE_POLL_LIMIT,
    });
    expect(output.result).toMatchObject({ revisions: 1, readinessChecks: 0 });
  });

  it("merges duplicate records within each event kind", async () => {
    const duplicate = revision("issue-1", "FER-1", "2026-07-20T20:00:00.000Z");
    const fake = linear({
      [config.stateIds.backlog]: {
        revisions: [duplicate, duplicate],
        truncated: false,
      },
      [config.stateIds.open]: {
        revisions: [duplicate, duplicate],
        truncated: false,
      },
    });
    const output = await new InngestTestEngine({
      function: poller(fake.service),
      events: [pollEvent()],
    }).execute();

    expect(output.result).toMatchObject({
      observed: 2,
      revisions: 1,
      readinessChecks: 1,
    });
  });

  it("returns without a send step when every observed state is empty", async () => {
    const output = await new InngestTestEngine({
      function: poller(linear({}).service),
      events: [pollEvent()],
    }).execute();

    expect(output.result).toEqual({ outcome: "empty", observed: 0 });
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["Backlog", config.stateIds.backlog],
    ["Open", config.stateIds.open],
  ])("fails the whole poll when the %s result is truncated", async (_name, stateId) => {
    const fake = linear({
      [stateId]: { revisions: [], truncated: true },
    });
    const output = await new InngestTestEngine({
      function: poller(fake.service),
      events: [pollEvent()],
    }).execute();

    expect(output.error).toMatchObject({
      message: expect.stringContaining(`${LINEAR_ISSUE_POLL_LIMIT}-issue limit`),
    });
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("rejects incomplete or ambiguous poller configuration", () => {
    const fake = linear({});

    expect(() =>
      createLinearIssuePoller({
        client: client(),
        linear: fake.service,
        config: { ...config, projectId: "" },
      }),
    ).toThrow(/projectId/);
    expect(() =>
      createLinearIssuePoller({
        client: client(),
        linear: fake.service,
        config: {
          ...config,
          stateIds: {
            backlog: config.stateIds.backlog,
            open: config.stateIds.backlog,
          },
        },
      }),
    ).toThrow(/State IDs must be unique/);
  });
});

function eventIds(events: unknown): unknown[] {
  if (!Array.isArray(events)) throw new Error("Expected sent events");
  return events.map((event) => {
    if (!event || typeof event !== "object" || !("id" in event)) {
      throw new Error("Expected event ID");
    }
    return event.id;
  });
}
