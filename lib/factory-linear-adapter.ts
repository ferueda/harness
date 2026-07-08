import { LinearClient } from "@linear/sdk";
import { type FactoryLinearSettings } from "./config.ts";
import {
  applyLinearPlanningMerged,
  applyLinearPlanningPublished,
  type LinearPlanningHandoffInput,
  type LinearPlanningHandoffUpdatePlan,
  type LinearPlanningMergedInput,
} from "./factory-linear-planning-handoff.ts";
import {
  applyLinearPlanningCompleted,
  applyLinearPlanningFailed,
  applyLinearPlanningStarted,
  linearPlanningAttentionStageFromComments,
  type LinearPlanningApplyInput,
  type LinearPlanningCompletedInput,
  type LinearPlanningFailedInput,
  type LinearPlanningUpdatePlan,
} from "./factory-linear-planning-apply.ts";
import type {
  LinearClientLike,
  LinearCommentLike,
  LinearConnectionLike,
  LinearIssueLabelLike,
  LinearIssueLike,
  LinearProjectLike,
  LinearTeamLike,
  LinearUserLike,
  LinearWorkflowStateLike,
} from "./factory-linear-types.ts";
import {
  FactoryWorkItemSchema,
  type FactoryRoute,
  type FactoryStage,
  type FactoryTriageOutput,
  type FactoryWorkItem,
  type JsonValue,
} from "./factory-schemas.ts";

export {
  renderLinearPlanningApprovedComment,
  renderLinearPlanningReadyComment,
} from "./factory-linear-planning-handoff.ts";

const LINEAR_ISSUE_IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const COMMENT_FETCH_LIMIT = 20;
const LABEL_FETCH_LIMIT = 50;
const STATUS_FETCH_LIMIT = 100;
const TRIAGE_COMMENT_EVIDENCE_LIMIT = 3;

export type LinearFactoryAdapter = {
  fetchWorkItem: (issueRef: string) => Promise<FactoryWorkItem>;
  validateStatusMap: () => Promise<LinearStatusMapValidation>;
  applyTriageStarted: (input: LinearTriageApplyInput) => Promise<LinearTriageUpdatePlan>;
  applyTriageCompleted: (input: LinearTriageCompletedInput) => Promise<LinearTriageUpdatePlan>;
  applyTriageFailed: (input: LinearTriageFailedInput) => Promise<LinearTriageUpdatePlan>;
  applyPlanningStarted: (input: LinearPlanningApplyInput) => Promise<LinearPlanningUpdatePlan>;
  applyPlanningCompleted: (
    input: LinearPlanningCompletedInput,
  ) => Promise<LinearPlanningUpdatePlan>;
  applyPlanningFailed: (input: LinearPlanningFailedInput) => Promise<LinearPlanningUpdatePlan>;
  applyPlanningPublished: (
    input: LinearPlanningHandoffInput,
  ) => Promise<LinearPlanningHandoffUpdatePlan>;
  applyPlanningMerged: (
    input: LinearPlanningMergedInput,
  ) => Promise<LinearPlanningHandoffUpdatePlan>;
};

export type LinearStatusMapValidation = {
  teamKey: string;
  statuses: LinearWorkflowStateLike[];
};

export type LinearTriageApplyStage = "start" | "complete" | "failed";

export type LinearTriageApplyInput = {
  issueRef: string;
  runId: string;
  runDir: string;
};

export type LinearTriageCompletedInput = LinearTriageApplyInput & {
  triage: FactoryTriageOutput;
};

export type LinearTriageFailedInput = LinearTriageApplyInput & {
  error: string;
};

export type LinearTriageUpdatePlan = {
  issueIdentifier: string;
  runId: string;
  runDir: string;
  stage: LinearTriageApplyStage;
  fromStatus?: string;
  targetStatus: string;
  commentMarker?: string;
  commentBody?: string;
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
    applyTriageStarted: (applyInput) =>
      applyTriageStarted(input.client, input.settings, applyInput),
    applyTriageCompleted: (applyInput) =>
      applyTriageCompleted(input.client, input.settings, applyInput),
    applyTriageFailed: (applyInput) => applyTriageFailed(input.client, input.settings, applyInput),
    applyPlanningStarted: (applyInput) =>
      applyLinearPlanningStarted(
        LINEAR_PLANNING_APPLY_DEPS,
        input.client,
        input.settings,
        applyInput,
      ),
    applyPlanningCompleted: (applyInput) =>
      applyLinearPlanningCompleted(
        LINEAR_PLANNING_APPLY_DEPS,
        input.client,
        input.settings,
        applyInput,
      ),
    applyPlanningFailed: (applyInput) =>
      applyLinearPlanningFailed(
        LINEAR_PLANNING_APPLY_DEPS,
        input.client,
        input.settings,
        applyInput,
      ),
    applyPlanningPublished: (applyInput) =>
      applyLinearPlanningPublished(
        LINEAR_PLANNING_APPLY_DEPS,
        input.client,
        input.settings,
        applyInput,
      ),
    applyPlanningMerged: (applyInput) =>
      applyLinearPlanningMerged(
        LINEAR_PLANNING_APPLY_DEPS,
        input.client,
        input.settings,
        applyInput,
      ),
  };
}

const LINEAR_PLANNING_APPLY_DEPS = {
  validateStatusMap,
  fetchIssue,
  resolveOptional,
  assertIssueInConfiguredScope,
  fetchWorkflowState,
  updateIssueStatusIfNeeded,
  issueHasCommentMarker,
};

export function parseLinearIssueIdentifier(issueRef: string): LinearIssueIdentifier | null {
  const match = LINEAR_ISSUE_IDENTIFIER_RE.exec(issueRef.trim());
  if (!match) return null;
  return {
    teamKey: match[1].toUpperCase(),
    number: Number(match[2]),
  };
}

export function linearTriageTargetStatus(
  settings: FactoryLinearSettings,
  route: FactoryRoute,
): string {
  switch (route) {
    case "ready-to-implement":
      return settings.statuses.readyToImplement;
    case "ready-to-plan":
      return settings.statuses.needsPlan;
    case "needs-info":
      return settings.statuses.needsInfo;
    case "wait-to-implement":
      return settings.statuses.parked;
  }
}

export function assertLinearTriageApplyAllowed(
  settings: FactoryLinearSettings,
  statusName: string | undefined,
): void {
  if (!statusName) {
    throw new Error("Linear issue is missing a status; cannot apply factory triage.");
  }
  const allowed = [
    settings.statuses.intake,
    settings.statuses.needsInfo,
    settings.statuses.triageFailed,
  ].map(normalizeName);
  if (allowed.includes(normalizeName(statusName))) return;
  throw new Error(
    `Linear issue is in ${statusName}; --apply only accepts ${settings.statuses.intake}, ${settings.statuses.needsInfo}, or ${settings.statuses.triageFailed}.`,
  );
}

export function linearTriageCommentMarker(runId: string): string {
  return `<!-- harness-factory:triage:${runId} -->`;
}

export function linearTriageFailedCommentMarker(runId: string): string {
  return `<!-- harness-factory:triage-failed:${runId} -->`;
}

export function renderLinearTriageCompleteComment(input: {
  runId: string;
  runDir: string;
  route: FactoryRoute;
  targetStatus: string;
  rationale: string;
  evidence: FactoryTriageOutput["evidence"];
  questions?: string[];
  reconsiderWhen?: string;
}): string {
  return [
    linearTriageCommentMarker(input.runId),
    "",
    "Factory triage complete.",
    "",
    `Route: ${input.route}`,
    `Run: \`${input.runDir}\``,
    `Next: ${input.targetStatus}`,
    ...readyToPlanContext(input),
    ...(input.questions && input.questions.length > 0
      ? ["", "Questions:", ...input.questions.map((question) => `- ${question}`)]
      : []),
    ...(input.reconsiderWhen ? ["", `Reconsider when: ${input.reconsiderWhen}`] : []),
    "",
  ].join("\n");
}

export function renderLinearTriageFailedComment(input: {
  runId: string;
  runDir: string;
  error: string;
}): string {
  return [
    linearTriageFailedCommentMarker(input.runId),
    "",
    "Factory triage failed.",
    "",
    `Run: \`${input.runDir}\``,
    `Error: ${input.error}`,
    "",
  ].join("\n");
}

async function applyTriageStarted(
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearTriageApplyInput,
): Promise<LinearTriageUpdatePlan> {
  await validateStatusMap(client, settings);
  const issue = await fetchIssue(client, settings, input.issueRef);
  const state = await resolveOptional(issue.state);
  await assertIssueInConfiguredScope(issue, settings);
  assertLinearTriageApplyAllowed(settings, state?.name);

  const target = await fetchWorkflowState(client, settings, settings.statuses.triaging);
  await client.updateIssue(issue.id, { stateId: target.id });
  return {
    issueIdentifier: issue.identifier,
    runId: input.runId,
    runDir: input.runDir,
    stage: "start",
    fromStatus: state?.name,
    targetStatus: target.name,
  };
}

async function applyTriageCompleted(
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearTriageCompletedInput,
): Promise<LinearTriageUpdatePlan> {
  await validateStatusMap(client, settings);
  const issue = await fetchIssue(client, settings, input.issueRef);
  const state = await resolveOptional(issue.state);
  await assertIssueInConfiguredScope(issue, settings);
  const target = await fetchWorkflowState(
    client,
    settings,
    linearTriageTargetStatus(settings, input.triage.route),
  );
  await updateIssueStatusIfNeeded(client, issue, state, target);

  const commentMarker = linearTriageCommentMarker(input.runId);
  const commentBody = renderLinearTriageCompleteComment({
    runId: input.runId,
    runDir: input.runDir,
    route: input.triage.route,
    targetStatus: target.name,
    rationale: input.triage.rationale,
    evidence: input.triage.evidence,
    questions: input.triage.questions,
    reconsiderWhen: input.triage.reconsiderWhen,
  });
  if (!(await issueHasCommentMarker(issue, commentMarker))) {
    await client.createComment({ issueId: issue.id, body: commentBody });
  }

  return {
    issueIdentifier: issue.identifier,
    runId: input.runId,
    runDir: input.runDir,
    stage: "complete",
    fromStatus: state?.name,
    targetStatus: target.name,
    commentMarker,
    commentBody,
  };
}

function readyToPlanContext(input: {
  route: FactoryRoute;
  rationale: string;
  evidence: FactoryTriageOutput["evidence"];
}): string[] {
  if (input.route !== "ready-to-plan") return [];
  const evidence = input.evidence.slice(0, TRIAGE_COMMENT_EVIDENCE_LIMIT).map((item) => {
    const prefix = item.path ? `${item.kind} (${item.path})` : item.kind;
    return `- ${prefix}: ${item.summary}`;
  });
  return [
    "",
    "Why Needs Plan:",
    `- ${input.rationale}`,
    ...(evidence.length ? ["", "Evidence:", ...evidence] : []),
  ];
}

async function applyTriageFailed(
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearTriageFailedInput,
): Promise<LinearTriageUpdatePlan> {
  await validateStatusMap(client, settings);
  const issue = await fetchIssue(client, settings, input.issueRef);
  const state = await resolveOptional(issue.state);
  await assertIssueInConfiguredScope(issue, settings);
  const target = await fetchWorkflowState(client, settings, settings.statuses.triageFailed);
  await updateIssueStatusIfNeeded(client, issue, state, target);

  const commentMarker = linearTriageFailedCommentMarker(input.runId);
  const commentBody = renderLinearTriageFailedComment({
    runId: input.runId,
    runDir: input.runDir,
    error: input.error,
  });
  if (!(await issueHasCommentMarker(issue, commentMarker))) {
    await client.createComment({ issueId: issue.id, body: commentBody });
  }

  return {
    issueIdentifier: issue.identifier,
    runId: input.runId,
    runDir: input.runDir,
    stage: "failed",
    fromStatus: state?.name,
    targetStatus: target.name,
    commentMarker,
    commentBody,
  };
}

async function fetchWorkItem(
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  issueRef: string,
): Promise<FactoryWorkItem> {
  await validateStatusMap(client, settings);
  const issue = await fetchIssue(client, settings, issueRef);
  const [state, team, project, labels, commentResult, assignee] = await Promise.all([
    resolveOptional(issue.state),
    resolveOptional(issue.team),
    resolveOptional(issue.project),
    fetchLabels(issue),
    fetchComments(issue),
    resolveOptional(issue.assignee),
  ]);
  assertTeamMatches(issue, settings, team);
  const linearProjectId = assertProjectMatches(issue, settings, project);

  const metadata = compactJsonRecord({
    tracker: {
      source: "linear",
      id: issue.identifier,
      url: issue.url,
    },
    factoryStage: state
      ? factoryStageForStatus(settings, state.name, commentResult.comments)
      : undefined,
    linearIssueId: issue.id,
    linearIssueIdentifier: issue.identifier,
    linearTeamKey: team.key,
    linearTeamName: team.name,
    linearProjectId,
    linearProjectName: project?.name,
    linearProjectUrl: project?.url,
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

async function fetchWorkflowState(
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  statusName: string,
): Promise<LinearWorkflowStateLike> {
  const team = await fetchTeam(client, settings.teamKey);
  const states = await team.states({ first: STATUS_FETCH_LIMIT });
  const state = states.nodes.find(
    (candidate) => normalizeName(candidate.name) === normalizeName(statusName),
  );
  if (!state) {
    throw new Error(`Linear team ${settings.teamKey} is missing configured status: ${statusName}`);
  }
  return state;
}

async function updateIssueStatusIfNeeded(
  client: LinearClientLike,
  issue: LinearIssueLike,
  current: LinearWorkflowStateLike | undefined,
  target: LinearWorkflowStateLike,
): Promise<void> {
  if (normalizeName(current?.name ?? "") !== normalizeName(target.name)) {
    await client.updateIssue(issue.id, { stateId: target.id });
  }
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

async function assertIssueInConfiguredScope(
  issue: LinearIssueLike,
  settings: FactoryLinearSettings,
): Promise<void> {
  const [team, project] = await Promise.all([
    resolveOptional(issue.team),
    resolveOptional(issue.project),
  ]);
  assertTeamMatches(issue, settings, team);
  assertProjectMatches(issue, settings, project);
}

function assertTeamMatches(
  issue: LinearIssueLike,
  settings: FactoryLinearSettings,
  team: LinearTeamLike | undefined,
): asserts team is LinearTeamLike {
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
}

function assertProjectMatches(
  issue: LinearIssueLike,
  settings: FactoryLinearSettings,
  project: LinearProjectLike | undefined,
): string | undefined {
  const projectId = projectIdForIssue(issue, project);
  if (!settings.projectId) return projectId;
  if (!projectId) {
    throw new Error(
      `Linear issue ${issue.identifier} has no project, but factory.linear.projectId is ${settings.projectId}.`,
    );
  }
  if (normalizeName(projectId) !== normalizeName(settings.projectId)) {
    const projectLabel = project?.name ? `${project.name} (${projectId})` : projectId;
    throw new Error(
      `Linear issue ${issue.identifier} belongs to project ${projectLabel}, but factory.linear.projectId is ${settings.projectId}.`,
    );
  }
  return projectId;
}

function projectIdForIssue(
  issue: LinearIssueLike,
  project: LinearProjectLike | undefined,
): string | undefined {
  if (
    issue.projectId &&
    project?.id &&
    normalizeName(issue.projectId) !== normalizeName(project.id)
  ) {
    throw new Error(
      `Linear issue ${issue.identifier} returned inconsistent project data: projectId ${issue.projectId}, project relation ${project.name} (${project.id}).`,
    );
  }
  return issue.projectId ?? project?.id ?? undefined;
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

async function issueHasCommentMarker(issue: LinearIssueLike, marker: string): Promise<boolean> {
  const comments = await fetchComments(issue);
  return comments.comments.some((comment) => comment.body.includes(marker));
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
  comments: LinearCommentLike[] = [],
): FactoryStage | undefined {
  const normalized = normalizeName(statusName);
  const statuses = settings.statuses;
  if (normalized === normalizeName(statuses.intake)) return "incoming";
  if (normalized === normalizeName(statuses.triaging)) return "triaging";
  if (normalized === normalizeName(statuses.needsInfo)) {
    const stage = linearPlanningAttentionStageFromComments(comments);
    return stage === "plan-needs-human" ? stage : "needs-info";
  }
  if (normalized === normalizeName(statuses.needsPlan)) return "ready-to-plan";
  if (normalized === normalizeName(statuses.needsPlanReview)) return "plan-review-unresolved";
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
