import { LinearClient } from "@linear/sdk";
import { type FactoryLinearSettings } from "./config.ts";
import {
  FactoryWorkItemSchema,
  type FactoryStage,
  type FactoryWorkItem,
  type JsonValue,
} from "./factory-schemas.ts";

const LINEAR_ISSUE_IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const COMMENT_FETCH_LIMIT = 20;
const LABEL_FETCH_LIMIT = 50;
const STATUS_FETCH_LIMIT = 100;

export type LinearFactoryAdapter = {
  fetchWorkItem: (issueRef: string) => Promise<FactoryWorkItem>;
  validateStatusMap: () => Promise<LinearStatusMapValidation>;
};

export type LinearStatusMapValidation = {
  teamKey: string;
  statuses: LinearWorkflowStateLike[];
};

export type LinearClientLike = {
  issue: (id: string) => Promise<LinearIssueLike>;
  issues: (variables?: unknown) => Promise<LinearConnectionLike<LinearIssueLike>>;
  teams: (variables?: unknown) => Promise<LinearConnectionLike<LinearTeamLike>>;
};

type LinearConnectionLike<T> = {
  nodes: T[];
  pageInfo?: {
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
};

type LinearIssueLike = {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description?: string | null;
  url: string;
  priority?: number | null;
  priorityLabel?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  assignee?: Promise<LinearUserLike | undefined> | LinearUserLike | undefined;
  state?: Promise<LinearWorkflowStateLike | undefined> | LinearWorkflowStateLike | undefined;
  team?: Promise<LinearTeamLike | undefined> | LinearTeamLike | undefined;
  labels?: (variables?: unknown) => Promise<LinearConnectionLike<LinearIssueLabelLike>>;
  comments?: (variables?: unknown) => Promise<LinearConnectionLike<LinearCommentLike>>;
};

type LinearTeamLike = {
  id: string;
  key: string;
  name: string;
  states: (variables?: unknown) => Promise<LinearConnectionLike<LinearWorkflowStateLike>>;
};

type LinearWorkflowStateLike = {
  id: string;
  name: string;
  type?: string;
};

type LinearIssueLabelLike = {
  name: string;
};

type LinearCommentLike = {
  id?: string;
  body: string;
  createdAt?: Date | string;
};

type LinearUserLike = {
  id?: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
};

type LinearIssueIdentifier = {
  teamKey: string;
  number: number;
};

export function createLinearFactoryAdapter(input: {
  apiKey: string;
  settings: FactoryLinearSettings;
}): LinearFactoryAdapter {
  const client = new LinearClient({ apiKey: input.apiKey }) as unknown as LinearClientLike;
  return createLinearFactoryAdapterForClient({
    client,
    settings: input.settings,
  });
}

export function createLinearFactoryAdapterForClient(input: {
  client: LinearClientLike;
  settings: FactoryLinearSettings;
}): LinearFactoryAdapter {
  return {
    fetchWorkItem: (issueRef) => fetchWorkItem(input.client, input.settings, issueRef),
    validateStatusMap: () => validateStatusMap(input.client, input.settings),
  };
}

export function parseLinearIssueIdentifier(issueRef: string): LinearIssueIdentifier | null {
  const match = LINEAR_ISSUE_IDENTIFIER_RE.exec(issueRef.trim());
  if (!match) return null;
  return {
    teamKey: match[1].toUpperCase(),
    number: Number(match[2]),
  };
}

async function fetchWorkItem(
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  issueRef: string,
): Promise<FactoryWorkItem> {
  await validateStatusMap(client, settings);
  const issue = await fetchIssue(client, settings, issueRef);
  const [state, team, labels, commentResult, assignee] = await Promise.all([
    resolveOptional(issue.state),
    resolveOptional(issue.team),
    fetchLabels(issue),
    fetchComments(issue),
    resolveOptional(issue.assignee),
  ]);
  if (!team) {
    throw new Error(
      `Linear issue ${issue.identifier} did not include team data; cannot verify factory.linear.teamKey ${settings.teamKey}.`,
    );
  }
  if (canonicalTeamKey(team.key) !== canonicalTeamKey(settings.teamKey)) {
    throw new Error(
      `Linear issue ${issue.identifier} belongs to ${team.key}, but factory.linear.teamKey is ${settings.teamKey}.`,
    );
  }

  const metadata = compactJsonRecord({
    tracker: {
      source: "linear",
      id: issue.identifier,
      url: issue.url,
    },
    factoryStage: state ? factoryStageForStatus(settings, state.name) : undefined,
    linearIssueId: issue.id,
    linearIssueIdentifier: issue.identifier,
    linearTeamKey: team.key,
    linearTeamName: team.name,
    linearStatus: state?.name,
    linearStatusType: state?.type,
    linearPriority: issue.priority,
    linearPriorityLabel: issue.priorityLabel,
    linearAssignee: assigneeName(assignee),
    linearCommentsIncluded: commentResult.comments.length,
    linearCommentsTruncated: commentResult.truncated,
    linearCreatedAt: formatDate(issue.createdAt),
    linearUpdatedAt: formatDate(issue.updatedAt),
  });

  return FactoryWorkItemSchema.parse({
    id: `linear:${issue.identifier}`,
    source: "linear",
    title: issue.title,
    body: renderLinearIssueBody(issue, commentResult.comments),
    url: issue.url,
    labels,
    metadata,
  });
}

async function fetchIssue(
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  issueRef: string,
): Promise<LinearIssueLike> {
  const parsed = parseLinearIssueIdentifier(issueRef);
  if (!parsed) return client.issue(issueRef);

  if (canonicalTeamKey(parsed.teamKey) !== canonicalTeamKey(settings.teamKey)) {
    throw new Error(
      `Linear issue ${issueRef} belongs to ${parsed.teamKey}, but factory.linear.teamKey is ${settings.teamKey}.`,
    );
  }

  const connection = await client.issues({
    filter: {
      team: { key: { eq: canonicalTeamKey(parsed.teamKey) } },
      number: { eq: parsed.number },
    },
    first: 2,
  });
  if (connection.nodes.length === 0) {
    throw new Error(`Linear issue not found: ${issueRef}`);
  }
  if (connection.nodes.length > 1) {
    throw new Error(`Linear issue lookup was ambiguous: ${issueRef}`);
  }
  return connection.nodes[0];
}

async function validateStatusMap(
  client: LinearClientLike,
  settings: FactoryLinearSettings,
): Promise<LinearStatusMapValidation> {
  const team = await fetchTeam(client, settings.teamKey);
  const states = await team.states({ first: STATUS_FETCH_LIMIT });
  const existingNames = new Set(states.nodes.map((state) => normalizeName(state.name)));
  const missing = unique(Object.values(settings.statuses)).filter(
    (statusName) => !existingNames.has(normalizeName(statusName)),
  );

  if (missing.length > 0) {
    throw new Error(
      `Linear team ${settings.teamKey} is missing configured statuses: ${missing.join(", ")}`,
    );
  }

  return {
    teamKey: team.key,
    statuses: states.nodes,
  };
}

async function fetchTeam(client: LinearClientLike, teamKey: string): Promise<LinearTeamLike> {
  const connection = await client.teams({
    filter: { key: { eq: canonicalTeamKey(teamKey) } },
    first: 2,
  });
  if (connection.nodes.length === 0) {
    throw new Error(`Linear team not found: ${teamKey}`);
  }
  if (connection.nodes.length > 1) {
    throw new Error(`Linear team lookup was ambiguous: ${teamKey}`);
  }
  return connection.nodes[0];
}

async function fetchLabels(issue: LinearIssueLike): Promise<string[]> {
  const labels = await issue.labels?.({ first: LABEL_FETCH_LIMIT });
  return labels?.nodes.map((label) => label.name) ?? [];
}

async function fetchComments(
  issue: LinearIssueLike,
): Promise<{ comments: LinearCommentLike[]; truncated: boolean }> {
  const comments = await issue.comments?.({ last: COMMENT_FETCH_LIMIT });
  return {
    comments: comments?.nodes ?? [],
    truncated: comments?.pageInfo?.hasPreviousPage ?? false,
  };
}

function renderLinearIssueBody(issue: LinearIssueLike, comments: LinearCommentLike[]): string {
  const sections = [issue.description?.trim()].filter(Boolean);
  const nonEmptyComments = comments
    .filter((comment) => comment.body.trim().length > 0)
    .sort(compareCommentsByCreatedAt);
  if (nonEmptyComments.length > 0) {
    sections.push(
      [
        "## Linear Comments",
        ...nonEmptyComments.map((comment) => {
          const createdAt = formatDate(comment.createdAt);
          const prefix = createdAt ? `- ${createdAt}: ` : "- ";
          return `${prefix}${comment.body.trim()}`;
        }),
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}

function factoryStageForStatus(
  settings: FactoryLinearSettings,
  statusName: string,
): FactoryStage | undefined {
  const normalized = normalizeName(statusName);
  const statuses = settings.statuses;
  if (normalized === normalizeName(statuses.intake)) return "incoming";
  if (normalized === normalizeName(statuses.triaging)) return "triaging";
  if (normalized === normalizeName(statuses.needsInfo)) return "needs-info";
  if (normalized === normalizeName(statuses.needsPlan)) return "ready-to-plan";
  if (normalized === normalizeName(statuses.readyToImplement)) return "ready-to-implement";
  if (normalized === normalizeName(statuses.parked)) return "wait-to-implement";
  if (normalized === normalizeName(statuses.planning)) return "planning";
  if (normalized === normalizeName(statuses.planningFailed)) return "planning-failed";
  return undefined;
}

async function resolveOptional<T>(
  value: Promise<T | undefined> | T | undefined,
): Promise<T | undefined> {
  return value instanceof Promise ? value : Promise.resolve(value);
}

function assigneeName(user: LinearUserLike | undefined): string | undefined {
  return user?.displayName ?? user?.name ?? user?.email ?? undefined;
}

function compactJsonRecord(
  input: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
  );
}

function formatDate(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalTeamKey(value: string): string {
  return value.trim().toUpperCase();
}

function compareCommentsByCreatedAt(a: LinearCommentLike, b: LinearCommentLike): number {
  const left = dateSortValue(a.createdAt);
  const right = dateSortValue(b.createdAt);
  return left - right;
}

function dateSortValue(value: Date | string | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
