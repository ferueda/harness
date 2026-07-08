import type { FactoryLinearSettings } from "./config.ts";
import type {
  LinearClientLike,
  LinearIssueLike,
  LinearProjectLike,
  LinearTeamLike,
  LinearUserLike,
} from "./factory-linear-types.ts";
import type { FactoryStage } from "./factory-schemas.ts";

const DEFAULT_LIST_PAGE_SIZE = 50;
const MAX_LIST_PAGE_SIZE = 100;

export type LinearFactoryStatusKey = keyof FactoryLinearSettings["statuses"];

export type LinearListWorkItemsInput = {
  statusKeys: LinearFactoryStatusKey[];
  first?: number;
  after?: string;
  all?: boolean;
};

export type LinearIssueSummary = {
  id: string;
  source: "linear";
  identifier: string;
  title: string;
  url: string;
  status?: string;
  statusType?: string;
  factoryStage?: FactoryStage;
  projectId?: string;
  projectName?: string;
  projectUrl?: string;
  assignee?: string;
  priority?: number | null;
  priorityLabel?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type LinearIssueList = {
  teamKey: string;
  projectId?: string;
  statusKeys: LinearFactoryStatusKey[];
  statusNames: string[];
  issues: LinearIssueSummary[];
  pageInfo: {
    fetchedPages: number;
    hasNextPage: boolean;
    endCursor?: string;
  };
};

type LinearListDeps = {
  validateStatusMap: (
    client: LinearClientLike,
    settings: FactoryLinearSettings,
  ) => Promise<{ teamKey: string }>;
  resolveOptional: <T>(value: Promise<T | undefined> | T | undefined) => Promise<T | undefined>;
  assertTeamMatches: (
    issue: LinearIssueLike,
    settings: FactoryLinearSettings,
    team: LinearTeamLike | undefined,
  ) => asserts team is LinearTeamLike;
  assertProjectMatches: (
    issue: LinearIssueLike,
    settings: FactoryLinearSettings,
    project: LinearProjectLike | undefined,
  ) => string | undefined;
  factoryStageForStatus: (
    settings: FactoryLinearSettings,
    statusName: string,
  ) => FactoryStage | undefined;
  normalizeName: (value: string) => string;
  canonicalTeamKey: (value: string) => string;
  assigneeName: (user: LinearUserLike | undefined) => string | undefined;
  formatDate: (value: Date | string | undefined) => string | undefined;
};

export async function listLinearWorkItemsByStatus(
  deps: LinearListDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearListWorkItemsInput,
): Promise<LinearIssueList> {
  if (input.statusKeys.length === 0) {
    throw new Error("At least one factory status key is required.");
  }
  if (input.all && input.after) {
    throw new Error("Linear list all-pages mode cannot be combined with an after cursor.");
  }
  const first = input.first ?? DEFAULT_LIST_PAGE_SIZE;
  if (!Number.isInteger(first) || first < 1 || first > MAX_LIST_PAGE_SIZE) {
    throw new Error(`Linear list first must be an integer between 1 and ${MAX_LIST_PAGE_SIZE}.`);
  }

  const validation = await deps.validateStatusMap(client, settings);
  const statusNames = input.statusKeys.map((key) => settings.statuses[key]);
  const issues: LinearIssueSummary[] = [];
  let fetchedPages = 0;
  let after = input.after;
  let hasNextPage = false;
  let endCursor: string | undefined;

  do {
    const connection = await client.issues({
      filter: linearIssueListFilter(deps, settings, statusNames),
      first,
      ...(after ? { after } : {}),
    });
    fetchedPages += 1;
    const summaries = await Promise.all(
      connection.nodes.map((issue) => linearIssueSummary(deps, issue, settings)),
    );
    issues.push(...summaries);

    hasNextPage = connection.pageInfo?.hasNextPage ?? false;
    endCursor = connection.pageInfo?.endCursor;
    if (!input.all || !hasNextPage) break;
    if (!endCursor) {
      throw new Error(
        "Linear returned hasNextPage without endCursor; cannot continue all-pages list safely.",
      );
    }
    after = endCursor;
  } while (true);

  return {
    teamKey: validation.teamKey,
    projectId: settings.projectId,
    statusKeys: input.statusKeys,
    statusNames,
    issues,
    pageInfo: {
      fetchedPages,
      hasNextPage,
      ...(endCursor ? { endCursor } : {}),
    },
  };
}

function linearIssueListFilter(
  deps: LinearListDeps,
  settings: FactoryLinearSettings,
  statusNames: string[],
): Record<string, unknown> {
  return {
    team: { key: { eq: deps.canonicalTeamKey(settings.teamKey) } },
    state: { name: { in: statusNames } },
    ...(settings.projectId ? { project: { id: { eq: settings.projectId } } } : {}),
  };
}

async function linearIssueSummary(
  deps: LinearListDeps,
  issue: LinearIssueLike,
  settings: FactoryLinearSettings,
): Promise<LinearIssueSummary> {
  const [state, team, project, assignee] = await Promise.all([
    deps.resolveOptional(issue.state),
    deps.resolveOptional(issue.team),
    deps.resolveOptional(issue.project),
    deps.resolveOptional(issue.assignee),
  ]);
  deps.assertTeamMatches(issue, settings, team);
  const linearProjectId = deps.assertProjectMatches(issue, settings, project);
  const isCommentDerivedStage =
    state && deps.normalizeName(state.name) === deps.normalizeName(settings.statuses.needsInfo);

  const summary: LinearIssueSummary = {
    id: `linear:${issue.identifier}`,
    source: "linear",
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
  };
  if (state?.name) summary.status = state.name;
  if (state?.type) summary.statusType = state.type;
  if (state && !isCommentDerivedStage) {
    const factoryStage = deps.factoryStageForStatus(settings, state.name);
    if (factoryStage) summary.factoryStage = factoryStage;
  }
  if (linearProjectId) summary.projectId = linearProjectId;
  if (project?.name) summary.projectName = project.name;
  if (project?.url) summary.projectUrl = project.url;
  const assigneeName = deps.assigneeName(assignee);
  if (assigneeName) summary.assignee = assigneeName;
  if (issue.priority !== undefined) summary.priority = issue.priority;
  if (issue.priorityLabel !== undefined) summary.priorityLabel = issue.priorityLabel;
  const createdAt = deps.formatDate(issue.createdAt);
  if (createdAt) summary.createdAt = createdAt;
  const updatedAt = deps.formatDate(issue.updatedAt);
  if (updatedAt) summary.updatedAt = updatedAt;
  return summary;
}
