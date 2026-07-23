import { cron, type Inngest, type InngestFunction } from "inngest";
import { z } from "zod";
import { createLinearIssueReadinessCheckRequestedEvent } from "./events/linear-readiness-events.ts";
import {
  createLinearIssueRevisionObservedEvent,
  LinearPollRequestedEvent,
} from "./events/linear-revision-events.ts";
import { LinearError } from "../linear/error.ts";
import type { LinearService } from "../linear/client.ts";
import type { LinearIssueRevision, ListIssueRevisionsResult } from "../linear/types.ts";

export const LINEAR_ISSUE_POLL_FUNCTION_ID = "poll-linear-issues-v2";
export const LINEAR_ISSUE_POLL_RETRIES = 3;
export const LINEAR_ISSUE_POLL_CRON = "* * * * *";
export const LINEAR_ISSUE_POLL_LIMIT = 250;
export const LINEAR_ISSUE_LIST_STEP_ID = "list-linear-issue-observations-v2";
export const LINEAR_ISSUE_SEND_STEP_ID = "send-linear-issue-observations-v2";

const LinearIssuePollerConfigSchema = z
  .object({
    teamId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    stateIds: z
      .object({
        backlog: z.string().trim().min(1),
        open: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .strict()
  .refine((config) => !config.stateIds.open || config.stateIds.open !== config.stateIds.backlog, {
    path: ["stateIds"],
    message: "State IDs must be unique",
  });

export type LinearIssuePollerLinear = Pick<LinearService, "listIssueRevisions">;

export type LinearIssuePollerConfig = Readonly<z.infer<typeof LinearIssuePollerConfigSchema>>;

type ListedState = Readonly<{
  kind: "revision" | "readiness-check";
  stateId: string;
  result: ListIssueRevisionsResult;
}>;

export function createLinearIssuePoller(input: {
  client: Inngest.Any;
  linear: LinearIssuePollerLinear;
  config: LinearIssuePollerConfig;
}): InngestFunction.Any {
  const config = LinearIssuePollerConfigSchema.parse(input.config);

  return input.client.createFunction(
    {
      id: LINEAR_ISSUE_POLL_FUNCTION_ID,
      concurrency: 1,
      retries: LINEAR_ISSUE_POLL_RETRIES,
      triggers: [cron(LINEAR_ISSUE_POLL_CRON), LinearPollRequestedEvent],
    },
    async ({ event, step }) => {
      const states = observedStates(config);
      const listed: ListedState[] = await step.run(LINEAR_ISSUE_LIST_STEP_ID, () =>
        Promise.all(
          states.map(async (state) => ({
            ...state,
            result: await input.linear.listIssueRevisions({
              teamId: config.teamId,
              projectId: config.projectId,
              stateId: state.stateId,
              limit: LINEAR_ISSUE_POLL_LIMIT,
            }),
          })),
        ),
      );
      const truncated = listed.find((state) => state.result.truncated);
      if (truncated) {
        throw new LinearError(
          "incomplete",
          [
            `Linear ${truncated.kind} poll for state ${truncated.stateId}`,
            `exceeded its ${LINEAR_ISSUE_POLL_LIMIT}-issue limit.`,
          ].join(" "),
        );
      }

      const revisions = uniqueRevisions(
        listed
          .filter((state) => state.kind === "revision")
          .flatMap((state) => state.result.revisions),
      );
      const readinessChecks = uniqueRevisions(
        listed
          .filter((state) => state.kind === "readiness-check")
          .flatMap((state) => state.result.revisions),
      );
      if (revisions.length === 0 && readinessChecks.length === 0) {
        return { outcome: "empty" as const, observed: 0 };
      }

      const events = [
        ...revisions.map((revision) =>
          createLinearIssueRevisionObservedEvent({
            issueId: revision.id,
            issueIdentifier: revision.identifier,
            updatedAt: revision.updatedAt,
          }),
        ),
        ...readinessChecks.map((revision) =>
          createLinearIssueReadinessCheckRequestedEvent(
            {
              issueId: revision.id,
              issueIdentifier: revision.identifier,
            },
            event.id,
          ),
        ),
      ];
      await step.sendEvent(LINEAR_ISSUE_SEND_STEP_ID, events);
      return {
        outcome: "observed" as const,
        observed: events.length,
        revisions: revisions.length,
        readinessChecks: readinessChecks.length,
        eventIds: events.map((event) => event.id),
      };
    },
  );
}

function observedStates(
  config: LinearIssuePollerConfig,
): ReadonlyArray<Readonly<{ kind: ListedState["kind"]; stateId: string }>> {
  return [
    { kind: "revision", stateId: config.stateIds.backlog },
    ...(config.stateIds.open
      ? [{ kind: "readiness-check" as const, stateId: config.stateIds.open }]
      : []),
  ];
}

function uniqueRevisions(revisions: readonly LinearIssueRevision[]): LinearIssueRevision[] {
  return [...new Map(revisions.map((revision) => [revision.id, revision])).values()];
}
