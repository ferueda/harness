import { cron, type Inngest, type InngestFunction } from "inngest";
import { z } from "zod";
import {
  createLinearIssueRevisionObservedEvent,
  LinearPollRequestedEvent,
} from "./events/linear-revision-events.ts";
import { LinearError } from "../linear/error.ts";
import type { LinearService } from "../linear/client.ts";
import type { ListIssueRevisionsResult } from "../linear/types.ts";

export const LINEAR_BACKLOG_POLL_FUNCTION_ID = "poll-linear-backlog-v1";
export const LINEAR_BACKLOG_POLL_RETRIES = 3;
export const LINEAR_BACKLOG_POLL_CRON = "* * * * *";
export const LINEAR_BACKLOG_POLL_LIMIT = 250;
export const LINEAR_BACKLOG_LIST_STEP_ID = "list-linear-backlog-revisions-v1";
export const LINEAR_BACKLOG_SEND_STEP_ID = "send-linear-revision-events-v1";

const LinearBacklogPollerConfigSchema = z
  .object({
    teamId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    stateId: z.string().trim().min(1),
  })
  .strict();

export type LinearBacklogPollerLinear = Pick<LinearService, "listIssueRevisions">;

export type LinearBacklogPollerConfig = Readonly<z.infer<typeof LinearBacklogPollerConfigSchema>>;

export function createLinearBacklogPoller(input: {
  client: Inngest.Any;
  linear: LinearBacklogPollerLinear;
  config: LinearBacklogPollerConfig;
}): InngestFunction.Any {
  const config = LinearBacklogPollerConfigSchema.parse(input.config);

  return input.client.createFunction(
    {
      id: LINEAR_BACKLOG_POLL_FUNCTION_ID,
      concurrency: 1,
      retries: LINEAR_BACKLOG_POLL_RETRIES,
      triggers: [cron(LINEAR_BACKLOG_POLL_CRON), LinearPollRequestedEvent],
    },
    async ({ step }) => {
      const result: ListIssueRevisionsResult = await step.run(LINEAR_BACKLOG_LIST_STEP_ID, () =>
        input.linear.listIssueRevisions({
          teamId: config.teamId,
          projectId: config.projectId,
          stateId: config.stateId,
          limit: LINEAR_BACKLOG_POLL_LIMIT,
        }),
      );
      if (result.truncated) {
        throw new LinearError(
          "incomplete",
          `Linear Backlog poll exceeded its ${LINEAR_BACKLOG_POLL_LIMIT}-issue limit.`,
        );
      }
      if (result.revisions.length === 0) {
        return { outcome: "empty" as const, observed: 0 };
      }

      const events = result.revisions.map((revision) =>
        createLinearIssueRevisionObservedEvent({
          issueId: revision.id,
          issueIdentifier: revision.identifier,
          updatedAt: revision.updatedAt,
        }),
      );
      await step.sendEvent(LINEAR_BACKLOG_SEND_STEP_ID, events);
      return {
        outcome: "observed" as const,
        observed: events.length,
        eventIds: events.map((event) => event.id),
      };
    },
  );
}
