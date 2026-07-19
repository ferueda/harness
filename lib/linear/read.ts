import { LinearError } from "./error.ts";
import {
  assertPage,
  LINEAR_PAGE_SIZE,
  readLimited,
  type LinearPage,
  type PageVariables,
} from "./pagination.ts";

const ISSUE_IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

export type LinearReadLimits = Readonly<{
  comments: number;
  labels: number;
  relations: number;
  attachments: number;
  children: number;
}>;

export type LinearUser = Readonly<{
  id: string;
  name: string;
  displayName: string;
}>;

export type LinearCommentActor =
  | Readonly<{ kind: "user"; id: string; name: string; displayName: string }>
  | Readonly<{ kind: "bot"; id: string | null; name: string | null }>
  | Readonly<{ kind: "external"; id: string; name: null }>
  | null;

export type LinearWorkflowState = Readonly<{
  id: string;
  name: string;
  type: string;
}>;

export type LinearIssueReference = Readonly<{
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: LinearWorkflowState;
}>;

export type LinearIssueContext = Readonly<{
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: LinearWorkflowState;
  team: Readonly<{ id: string; key: string; name: string }>;
  project: Readonly<{ id: string; name: string; url: string | null }> | null;
  assignee: LinearUser | null;
  creator: LinearUser | null;
  labels: ReadonlyArray<Readonly<{ id: string; name: string }>>;
  comments: ReadonlyArray<
    Readonly<{
      id: string;
      body: string;
      author: LinearCommentActor;
      parentId: string | null;
      quotedText: string | null;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  parent: LinearIssueReference | null;
  children: ReadonlyArray<LinearIssueReference>;
  duplicateOf: LinearIssueReference | null;
  blockedBy: ReadonlyArray<LinearIssueReference>;
  related: ReadonlyArray<LinearIssueReference>;
  attachments: ReadonlyArray<
    Readonly<{
      id: string;
      title: string;
      subtitle: string | null;
      url: string;
      sourceType: string | null;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  createdAt: string;
  updatedAt: string;
  completeness: Readonly<{
    commentsTruncated: boolean;
    labelsTruncated: boolean;
    relationsTruncated: boolean;
    attachmentsTruncated: boolean;
    childrenTruncated: boolean;
  }>;
}>;

type MaybeFetch<T> = T | PromiseLike<T> | null | undefined;

export type RawWorkflowState = { id: string; name: string; type: string };
type RawTeam = { id: string; key: string; name: string };
type RawProject = { id: string; name: string; url?: string | null };
type RawUser = { id: string; name: string; displayName: string };
type RawLabel = { id: string; name: string };
type RawBotActor = { id?: string | null; name?: string | null };

export type RawComment = {
  id: string;
  body: string;
  userId?: string | null;
  externalUserId?: string | null;
  botActor?: RawBotActor | null;
  parentId?: string | null;
  quotedText?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type RawIssueRelation = {
  id: string;
  type: string;
  issueId?: string | null;
  relatedIssueId?: string | null;
};

type RawAttachment = {
  id: string;
  title: string;
  subtitle?: string | null;
  url: string;
  sourceType?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type RawIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  stateId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  assigneeId?: string | null;
  creatorId?: string | null;
  parentId?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  state?: MaybeFetch<RawWorkflowState>;
  team?: MaybeFetch<RawTeam>;
  project?: MaybeFetch<RawProject>;
  comments: (variables: PageVariables) => PromiseLike<LinearPage<RawComment>>;
  labels: (variables: PageVariables) => PromiseLike<LinearPage<RawLabel>>;
  relations: (variables: PageVariables) => PromiseLike<LinearPage<RawIssueRelation>>;
  inverseRelations: (variables: PageVariables) => PromiseLike<LinearPage<RawIssueRelation>>;
  attachments: (variables: PageVariables) => PromiseLike<LinearPage<RawAttachment>>;
  children: (variables: PageVariables) => PromiseLike<LinearPage<RawIssue>>;
};

export type LinearReadClient = {
  issues: (variables?: unknown) => PromiseLike<LinearPage<RawIssue>>;
  users: (variables?: unknown) => PromiseLike<LinearPage<RawUser>>;
  workflowStates: (variables?: unknown) => PromiseLike<LinearPage<RawWorkflowState>>;
};

export type FindCommentMarkerInput = Readonly<{
  issueId: string;
  marker: string;
}>;

export type FindWorkflowStateInput = Readonly<{
  teamId: string;
  name: string;
}>;

export async function getIssueContext(
  client: LinearReadClient,
  limits: LinearReadLimits,
  issueRef: string,
): Promise<LinearIssueContext> {
  if (typeof issueRef !== "string" || issueRef.trim() === "") {
    throw new LinearError(
      "invalid-reference",
      "Linear issue reference must be a non-empty string.",
    );
  }

  try {
    const issue = await findIssue(client, issueRef.trim());
    const [
      stateValue,
      teamValue,
      projectValue,
      comments,
      labels,
      outgoing,
      inverse,
      attachments,
      children,
    ] = await Promise.all([
      resolveRequired(issue.state, "issue state"),
      resolveRequired(issue.team, "issue team"),
      resolveOptional(issue.project),
      readLimited(limits.comments, (variables) => issue.comments(variables), "comments"),
      readLimited(limits.labels, (variables) => issue.labels(variables), "labels"),
      readLimited(limits.relations, (variables) => issue.relations(variables), "relations"),
      readLimited(
        limits.relations,
        (variables) => issue.inverseRelations(variables),
        "inverse relations",
      ),
      readLimited(limits.attachments, (variables) => issue.attachments(variables), "attachments"),
      readLimited(limits.children, (variables) => issue.children(variables), "children"),
    ]);

    if (issue.projectId && !projectValue) {
      throw invalidResponse(`Linear issue ${issue.identifier} is missing its project.`);
    }

    const state = normalizeState(stateValue);
    const team = normalizeTeam(teamValue);
    const project = projectValue ? normalizeProject(projectValue) : null;
    const outgoingDuplicate = outgoing.nodes.filter((relation) => relation.type === "duplicate");
    if (outgoingDuplicate.length > 1) {
      throw invalidResponse(
        `Linear issue ${issue.identifier} has more than one outgoing duplicate relation.`,
      );
    }

    const duplicateId = outgoingDuplicate[0]
      ? requiredRelationId(outgoingDuplicate[0].relatedIssueId, "duplicate target")
      : null;
    const blockedByIds = unique(
      inverse.nodes
        .filter((relation) => relation.type === "blocks")
        .map((relation) => requiredRelationId(relation.issueId, "blocking source")),
    );
    const relatedIds = unique([
      ...outgoing.nodes
        .filter((relation) => relation.type === "related")
        .map((relation) => requiredRelationId(relation.relatedIssueId, "related target")),
      ...inverse.nodes
        .filter((relation) => relation.type === "related")
        .map((relation) => requiredRelationId(relation.issueId, "related source")),
    ]);

    const childById = uniqueById(children.nodes, "child issue");
    const referenceIds = unique([
      ...(issue.parentId ? [issue.parentId] : []),
      ...(duplicateId ? [duplicateId] : []),
      ...blockedByIds,
      ...relatedIds,
    ]);
    const userIds = unique([
      ...(issue.assigneeId ? [issue.assigneeId] : []),
      ...(issue.creatorId ? [issue.creatorId] : []),
      ...comments.nodes.flatMap((comment) => (comment.userId ? [comment.userId] : [])),
    ]);

    const [referencedIssues, users] = await Promise.all([
      fetchByIds(referenceIds, (variables) => client.issues(variables), "issue"),
      fetchByIds(userIds, (variables) => client.users(variables), "user"),
    ]);
    const issueById = new Map(referencedIssues.map((value) => [value.id, value]));
    for (const child of childById) issueById.set(child.id, child);

    const stateIds = unique([
      ...referencedIssues.map((value) => requiredString(value.stateId, "referenced issue stateId")),
      ...childById.map((value) => requiredString(value.stateId, "child issue stateId")),
    ]).filter((id) => id !== state.id);
    const referencedStates = await fetchByIds(
      stateIds,
      (variables) => client.workflowStates(variables),
      "workflow state",
    );
    const stateById = new Map<string, LinearWorkflowState>([[state.id, state]]);
    for (const value of referencedStates) stateById.set(value.id, normalizeState(value));
    const userById = new Map(users.map((value) => [value.id, normalizeUser(value)]));

    const issueReference = (id: string): LinearIssueReference => {
      const value = issueById.get(id);
      if (!value) throw invalidResponse(`Linear response is missing referenced issue ${id}.`);
      const stateId = requiredString(value.stateId, `stateId for referenced issue ${id}`);
      const referencedState = stateById.get(stateId);
      if (!referencedState) {
        throw invalidResponse(`Linear response is missing workflow state ${stateId}.`);
      }
      return normalizeIssueReference(value, referencedState);
    };

    const normalizedComments = comments.nodes
      .map((comment) => normalizeComment(comment, userById))
      .sort(compareComments);
    const normalizedLabels = labels.nodes.map(normalizeLabel).sort(compareLabels);
    const normalizedChildren = childById
      .map((child) => issueReference(child.id))
      .sort(compareIssueReferences);
    const normalizedBlockedBy = blockedByIds.map(issueReference).sort(compareIssueReferences);
    const normalizedRelated = relatedIds.map(issueReference).sort(compareIssueReferences);
    const normalizedAttachments = attachments.nodes
      .map(normalizeAttachment)
      .sort(compareAttachments);

    return {
      id: requiredString(issue.id, "issue id"),
      identifier: requiredString(issue.identifier, "issue identifier"),
      title: requiredString(issue.title, "issue title"),
      description: nullableString(issue.description, "issue description"),
      url: requiredString(issue.url, "issue url"),
      state,
      team,
      project,
      assignee: issue.assigneeId ? requireMapValue(userById, issue.assigneeId, "assignee") : null,
      creator: issue.creatorId ? requireMapValue(userById, issue.creatorId, "creator") : null,
      labels: normalizedLabels,
      comments: normalizedComments,
      parent: issue.parentId ? issueReference(issue.parentId) : null,
      children: normalizedChildren,
      duplicateOf: duplicateId ? issueReference(duplicateId) : null,
      blockedBy: normalizedBlockedBy,
      related: normalizedRelated,
      attachments: normalizedAttachments,
      createdAt: isoDate(issue.createdAt, "issue createdAt"),
      updatedAt: isoDate(issue.updatedAt, "issue updatedAt"),
      completeness: {
        commentsTruncated: comments.truncated,
        labelsTruncated: labels.truncated,
        relationsTruncated: outgoing.truncated || inverse.truncated,
        attachmentsTruncated: attachments.truncated,
        childrenTruncated: children.truncated,
      },
    };
  } catch (error) {
    if (error instanceof LinearError) throw error;
    throw new LinearError("upstream", `Failed to read Linear issue ${issueRef.trim()}.`, {
      cause: error,
    });
  }
}

export function normalizeLimits(input: LinearReadLimits): LinearReadLimits {
  const entries = Object.entries(input ?? {}) as Array<[keyof LinearReadLimits, unknown]>;
  const requiredKeys: Array<keyof LinearReadLimits> = [
    "comments",
    "labels",
    "relations",
    "attachments",
    "children",
  ];
  const values = Object.fromEntries(entries) as Partial<Record<keyof LinearReadLimits, unknown>>;
  for (const key of requiredKeys) {
    const value = values[key];
    if (!Number.isInteger(value) || Number(value) < 1) {
      throw new LinearError("invalid-config", `Linear ${key} limit must be a positive integer.`);
    }
  }
  return Object.freeze({
    comments: Number(values.comments),
    labels: Number(values.labels),
    relations: Number(values.relations),
    attachments: Number(values.attachments),
    children: Number(values.children),
  });
}

export async function findCommentMarker(
  client: LinearReadClient,
  commentLimit: number,
  input: FindCommentMarkerInput,
): Promise<string | null> {
  const issueId = nonEmptyInput(input.issueId, "issueId");
  const marker = nonEmptyInput(input.marker, "marker");

  try {
    const issue = await findIssueById(client, issueId);
    const comments = await readLimited(
      commentLimit,
      (variables) => issue.comments(variables),
      "comments",
    );
    const match = comments.nodes.find((comment) =>
      requiredString(comment.body, "comment body").includes(marker),
    );
    if (match) return requiredString(match.id, "comment id");
    if (comments.truncated) {
      throw new LinearError(
        "incomplete",
        `Linear comment scan for issue ${issueId} reached its configured limit.`,
      );
    }
    return null;
  } catch (error) {
    if (error instanceof LinearError) throw error;
    throw new LinearError("upstream", `Failed to find a Linear comment marker on ${issueId}.`, {
      cause: error,
    });
  }
}

export async function findWorkflowState(
  client: LinearReadClient,
  input: FindWorkflowStateInput,
): Promise<LinearWorkflowState> {
  const teamId = nonEmptyInput(input.teamId, "teamId");
  const name = nonEmptyInput(input.name, "name");

  try {
    const connection = await client.workflowStates({
      filter: {
        team: { id: { eq: teamId } },
        name: { eq: name },
      },
      first: 2,
    });
    assertPage(connection, "workflow state lookup");
    const matches = connection.nodes.filter(
      (state) =>
        requiredString(state.name, "workflow state name") === name &&
        requiredString(state.id, "workflow state id") !== "",
    );
    if (matches.length === 0) {
      throw new LinearError(
        "not-found",
        `Linear workflow state not found for team ${teamId}: ${name}.`,
      );
    }
    if (matches.length > 1 || connection.pageInfo.hasNextPage) {
      throw new LinearError(
        "ambiguous-reference",
        `Linear workflow state is ambiguous for team ${teamId}: ${name}.`,
      );
    }
    return normalizeState(matches[0]);
  } catch (error) {
    if (error instanceof LinearError) throw error;
    throw new LinearError(
      "upstream",
      `Failed to find Linear workflow state ${name} for team ${teamId}.`,
      { cause: error },
    );
  }
}

export async function findIssueById(client: LinearReadClient, issueId: string): Promise<RawIssue> {
  const connection = await client.issues({
    filter: { id: { eq: issueId } },
    first: 2,
  });
  assertPage(connection, "issue lookup");
  const matches = connection.nodes.filter(
    (issue) => requiredString(issue.id, "lookup issue id") === issueId,
  );
  if (matches.length === 0) {
    throw new LinearError("not-found", `Linear issue not found: ${issueId}.`);
  }
  if (matches.length > 1 || connection.pageInfo.hasNextPage) {
    throw new LinearError(
      "ambiguous-reference",
      `Linear issue reference is ambiguous: ${issueId}.`,
    );
  }
  return matches[0];
}

async function findIssue(client: LinearReadClient, issueRef: string): Promise<RawIssue> {
  const parsed = ISSUE_IDENTIFIER_RE.exec(issueRef);
  const variables = parsed
    ? {
        filter: {
          team: { key: { eq: parsed[1].toUpperCase() } },
          number: { eq: Number(parsed[2]) },
        },
        first: 2,
      }
    : { filter: { id: { eq: issueRef } }, first: 2 };
  const connection = await client.issues(variables);
  assertPage(connection, "issue lookup");
  const matches = connection.nodes.filter((issue) => {
    const id = requiredString(issue.id, "lookup issue id");
    const identifier = requiredString(issue.identifier, "lookup issue identifier");
    return parsed ? sameIssueIdentifier(identifier, parsed[1], Number(parsed[2])) : id === issueRef;
  });
  if (matches.length === 0) {
    throw new LinearError("not-found", `Linear issue not found: ${issueRef}.`);
  }
  if (matches.length > 1) {
    throw new LinearError(
      "ambiguous-reference",
      `Linear issue reference is ambiguous: ${issueRef}.`,
    );
  }
  return matches[0];
}

async function fetchByIds<T extends { id: string }>(
  ids: string[],
  load: (variables: unknown) => PromiseLike<LinearPage<T>>,
  label: string,
): Promise<T[]> {
  const uniqueIds = unique(ids);
  if (uniqueIds.length === 0) return [];
  const found = new Map<string, T>();

  for (let offset = 0; offset < uniqueIds.length; offset += LINEAR_PAGE_SIZE) {
    const chunk = uniqueIds.slice(offset, offset + LINEAR_PAGE_SIZE);
    const wanted = new Set(chunk);
    const seenCursors = new Set<string>();
    let after: string | undefined;
    let complete = false;
    while (!complete) {
      const page = await load({
        filter: { id: { in: chunk } },
        first: LINEAR_PAGE_SIZE,
        ...(after ? { after } : {}),
      });
      assertPage(page, `${label} hydration`);
      for (const value of page.nodes) {
        if (!wanted.has(value.id) || found.has(value.id)) {
          throw invalidResponse(`Linear returned an unexpected or duplicate ${label} ${value.id}.`);
        }
        found.set(value.id, value);
      }
      if (!page.pageInfo.hasNextPage) {
        complete = true;
        continue;
      }
      const next = page.pageInfo.endCursor;
      if (!next || seenCursors.has(next)) {
        throw invalidResponse(`Linear ${label} hydration pagination did not advance.`);
      }
      seenCursors.add(next);
      after = next;
    }
  }

  for (const id of uniqueIds) {
    if (!found.has(id)) throw invalidResponse(`Linear response is missing ${label} ${id}.`);
  }
  return uniqueIds.map((id) => found.get(id)!);
}

function normalizeComment(
  value: RawComment,
  userById: ReadonlyMap<string, LinearUser>,
): LinearIssueContext["comments"][number] {
  let author: LinearCommentActor = null;
  if (value.userId) {
    const user = requireMapValue(userById, value.userId, "comment author");
    author = { kind: "user", ...user };
  } else if (value.botActor) {
    author = {
      kind: "bot",
      id: nullableString(value.botActor.id, "bot id"),
      name: nullableString(value.botActor.name, "bot name"),
    };
  } else if (value.externalUserId) {
    author = { kind: "external", id: value.externalUserId, name: null };
  }
  return {
    id: requiredString(value.id, "comment id"),
    body: requiredString(value.body, "comment body"),
    author,
    parentId: nullableString(value.parentId, "comment parentId"),
    quotedText: nullableString(value.quotedText, "comment quotedText"),
    createdAt: isoDate(value.createdAt, "comment createdAt"),
    updatedAt: isoDate(value.updatedAt, "comment updatedAt"),
  };
}

function normalizeIssueReference(
  value: RawIssue,
  state: LinearWorkflowState,
): LinearIssueReference {
  return {
    id: requiredString(value.id, "referenced issue id"),
    identifier: requiredString(value.identifier, "referenced issue identifier"),
    title: requiredString(value.title, "referenced issue title"),
    url: requiredString(value.url, "referenced issue url"),
    state,
  };
}

function normalizeState(value: RawWorkflowState): LinearWorkflowState {
  return {
    id: requiredString(value.id, "workflow state id"),
    name: requiredString(value.name, "workflow state name"),
    type: requiredString(value.type, "workflow state type"),
  };
}

function normalizeTeam(value: RawTeam): LinearIssueContext["team"] {
  return {
    id: requiredString(value.id, "team id"),
    key: requiredString(value.key, "team key"),
    name: requiredString(value.name, "team name"),
  };
}

function normalizeProject(value: RawProject): NonNullable<LinearIssueContext["project"]> {
  return {
    id: requiredString(value.id, "project id"),
    name: requiredString(value.name, "project name"),
    url: nullableString(value.url, "project url"),
  };
}

function normalizeUser(value: RawUser): LinearUser {
  return {
    id: requiredString(value.id, "user id"),
    name: requiredString(value.name, "user name"),
    displayName: requiredString(value.displayName, "user displayName"),
  };
}

function normalizeLabel(value: RawLabel): LinearIssueContext["labels"][number] {
  return {
    id: requiredString(value.id, "label id"),
    name: requiredString(value.name, "label name"),
  };
}

function normalizeAttachment(value: RawAttachment): LinearIssueContext["attachments"][number] {
  return {
    id: requiredString(value.id, "attachment id"),
    title: requiredString(value.title, "attachment title"),
    subtitle: nullableString(value.subtitle, "attachment subtitle"),
    url: requiredString(value.url, "attachment url"),
    sourceType: nullableString(value.sourceType, "attachment sourceType"),
    createdAt: isoDate(value.createdAt, "attachment createdAt"),
    updatedAt: isoDate(value.updatedAt, "attachment updatedAt"),
  };
}

function compareComments(
  left: LinearIssueContext["comments"][number],
  right: LinearIssueContext["comments"][number],
): number {
  return comparePair(left.createdAt, left.id, right.createdAt, right.id);
}

function compareLabels(
  left: LinearIssueContext["labels"][number],
  right: LinearIssueContext["labels"][number],
): number {
  return comparePair(left.name, left.id, right.name, right.id);
}

function compareIssueReferences(left: LinearIssueReference, right: LinearIssueReference): number {
  return comparePair(left.identifier, left.id, right.identifier, right.id);
}

function compareAttachments(
  left: LinearIssueContext["attachments"][number],
  right: LinearIssueContext["attachments"][number],
): number {
  return comparePair(left.createdAt, left.id, right.createdAt, right.id);
}

function comparePair(
  leftPrimary: string,
  leftTie: string,
  rightPrimary: string,
  rightTie: string,
): number {
  return compareText(leftPrimary, rightPrimary) || compareText(leftTie, rightTie);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function sameIssueIdentifier(identifier: string, teamKey: string, number: number): boolean {
  const parsed = ISSUE_IDENTIFIER_RE.exec(identifier);
  return Boolean(
    parsed && parsed[1].toUpperCase() === teamKey.toUpperCase() && Number(parsed[2]) === number,
  );
}

async function resolveRequired<T>(value: MaybeFetch<T>, label: string): Promise<T> {
  const resolved = await value;
  if (resolved == null) throw invalidResponse(`Linear response is missing ${label}.`);
  return resolved;
}

async function resolveOptional<T>(value: MaybeFetch<T>): Promise<T | null> {
  return (await value) ?? null;
}

function requireMapValue<T>(map: ReadonlyMap<string, T>, id: string, label: string): T {
  const value = map.get(id);
  if (!value) throw invalidResponse(`Linear response is missing ${label} ${id}.`);
  return value;
}

function requiredRelationId(value: string | null | undefined, label: string): string {
  return requiredString(value, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalidResponse(`Linear response has invalid ${label}.`);
  return value;
}

function nonEmptyInput(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LinearError("invalid-input", `Linear ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function nullableString(value: unknown, label: string): string | null {
  if (value == null) return null;
  return requiredString(value, label);
}

function isoDate(value: unknown, label: string): string {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw invalidResponse(`Linear response has invalid ${label}.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw invalidResponse(`Linear response has invalid ${label}.`);
  return date.toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueById<T extends { id: string }>(values: T[], label: string): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    const id = requiredString(value.id, `${label} id`);
    if (!byId.has(id)) byId.set(id, value);
  }
  return [...byId.values()];
}

function invalidResponse(message: string): LinearError {
  return new LinearError("invalid-response", message);
}
