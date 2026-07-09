import type { FactoryLinearSettings } from "./config.ts";
import type {
  LinearClientLike,
  LinearTeamLike,
  LinearWorkflowStateLike,
} from "./factory-linear-types.ts";

export type LinearCreateWorkItemInput = {
  title: string;
  body: string;
};

export type LinearCreateWorkItemResult = {
  id: string;
  identifier: string;
  url: string;
};

type LinearCreateDeps = {
  validateStatusMap: (
    client: LinearClientLike,
    settings: FactoryLinearSettings,
  ) => Promise<{ teamKey: string; statuses: LinearWorkflowStateLike[] }>;
  fetchTeam: (client: LinearClientLike, teamKey: string) => Promise<LinearTeamLike>;
  normalizeName: (value: string) => string;
};

export async function createLinearWorkItem(
  deps: LinearCreateDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearCreateWorkItemInput,
): Promise<LinearCreateWorkItemResult> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) {
    throw new Error("Linear create title must be non-empty.");
  }
  if (!body) {
    throw new Error("Linear create body must be non-empty.");
  }
  if (!settings.projectId) {
    throw new Error("factory.linear.projectId is required for Linear create.");
  }

  const validation = await deps.validateStatusMap(client, settings);
  const team = await deps.fetchTeam(client, settings.teamKey);
  const intakeName = deps.normalizeName(settings.statuses.intake);
  const intakeState = validation.statuses.find(
    (state) => deps.normalizeName(state.name) === intakeName,
  );
  if (!intakeState) {
    throw new Error(
      `Linear team ${settings.teamKey} is missing configured status: ${settings.statuses.intake}`,
    );
  }

  const result = await client.createIssue({
    teamId: team.id,
    projectId: settings.projectId,
    stateId: intakeState.id,
    title,
    description: body,
  });
  if (!result.success) {
    throw new Error("Linear issue create failed.");
  }

  const issue = await result.issue;
  if (!issue?.identifier || !issue.url) {
    throw new Error("Linear issue create did not return identifier and url.");
  }

  return {
    identifier: issue.identifier,
    url: issue.url,
    id: `linear:${issue.identifier}`,
  };
}
