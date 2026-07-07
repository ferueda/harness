import type { FactoryLinearSettings } from "./config.ts";
import type { FactoryPlanningRunStatus } from "./factory-planning-run-context.ts";
import type {
  LinearClientLike,
  LinearCommentLike,
  LinearIssueLike,
  LinearWorkflowStateLike,
} from "./factory-linear-types.ts";

export type LinearPlanningApplyStage = "start" | "complete" | "failed";

export type LinearPlanningApplyInput = {
  issueRef: string;
  runId: string;
  runDir: string;
};

export type LinearPlanningCompletedInput = LinearPlanningApplyInput & {
  status: FactoryPlanningRunStatus;
  approvedPlanPath?: string;
  draftPlanPath?: string;
  reviewFindingsPath?: string;
  humanQuestions?: string[];
  error?: string;
};

export type LinearPlanningFailedInput = LinearPlanningApplyInput & {
  error: string;
};

export type LinearPlanningUpdatePlan = {
  issueIdentifier: string;
  runId: string;
  runDir: string;
  stage: LinearPlanningApplyStage;
  fromStatus?: string;
  targetStatus: string;
  commentMarker?: string;
  commentBody?: string;
};

export type LinearPlanningApplyDeps = {
  validateStatusMap: (
    client: LinearClientLike,
    settings: FactoryLinearSettings,
  ) => Promise<unknown>;
  fetchIssue: (
    client: LinearClientLike,
    settings: FactoryLinearSettings,
    issueRef: string,
  ) => Promise<LinearIssueLike>;
  resolveOptional: <T>(value: Promise<T | undefined> | T | undefined) => Promise<T | undefined>;
  assertIssueInConfiguredScope: (
    issue: LinearIssueLike,
    settings: FactoryLinearSettings,
  ) => Promise<void>;
  fetchWorkflowState: (
    client: LinearClientLike,
    settings: FactoryLinearSettings,
    statusName: string,
  ) => Promise<LinearWorkflowStateLike>;
  updateIssueStatusIfNeeded: (
    client: LinearClientLike,
    issue: LinearIssueLike,
    current: LinearWorkflowStateLike | undefined,
    target: LinearWorkflowStateLike,
  ) => Promise<void>;
  issueHasCommentMarker: (issue: LinearIssueLike, marker: string) => Promise<boolean>;
};

export async function applyLinearPlanningStarted(
  deps: LinearPlanningApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearPlanningApplyInput,
): Promise<LinearPlanningUpdatePlan> {
  await deps.validateStatusMap(client, settings);
  const issue = await deps.fetchIssue(client, settings, input.issueRef);
  const state = await deps.resolveOptional(issue.state);
  await deps.assertIssueInConfiguredScope(issue, settings);
  assertLinearPlanningApplyAllowed(settings, state?.name);

  const target = await deps.fetchWorkflowState(client, settings, settings.statuses.planning);
  await deps.updateIssueStatusIfNeeded(client, issue, state, target);
  return {
    issueIdentifier: issue.identifier,
    runId: input.runId,
    runDir: input.runDir,
    stage: "start",
    fromStatus: state?.name,
    targetStatus: target.name,
  };
}

export async function applyLinearPlanningCompleted(
  deps: LinearPlanningApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearPlanningCompletedInput,
): Promise<LinearPlanningUpdatePlan> {
  await deps.validateStatusMap(client, settings);
  const issue = await deps.fetchIssue(client, settings, input.issueRef);
  const state = await deps.resolveOptional(issue.state);
  await deps.assertIssueInConfiguredScope(issue, settings);
  const target = await deps.fetchWorkflowState(
    client,
    settings,
    linearPlanningTargetStatus(settings, input.status),
  );
  await deps.updateIssueStatusIfNeeded(client, issue, state, target);

  const commentMarker = linearPlanningApplyCommentMarker(input.runId);
  const commentBody = renderLinearPlanningApplyCompleteComment({
    ...input,
    targetStatus: target.name,
  });
  if (!(await deps.issueHasCommentMarker(issue, commentMarker))) {
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

export async function applyLinearPlanningFailed(
  deps: LinearPlanningApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearPlanningFailedInput,
): Promise<LinearPlanningUpdatePlan> {
  await deps.validateStatusMap(client, settings);
  const issue = await deps.fetchIssue(client, settings, input.issueRef);
  const state = await deps.resolveOptional(issue.state);
  await deps.assertIssueInConfiguredScope(issue, settings);
  const target = await deps.fetchWorkflowState(client, settings, settings.statuses.planningFailed);
  await deps.updateIssueStatusIfNeeded(client, issue, state, target);

  const commentMarker = linearPlanningApplyFailedCommentMarker(input.runId);
  const commentBody = renderLinearPlanningApplyFailedComment(input);
  if (!(await deps.issueHasCommentMarker(issue, commentMarker))) {
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

export function assertLinearPlanningApplyAllowed(
  settings: FactoryLinearSettings,
  statusName: string | undefined,
): void {
  if (!statusName) {
    throw new Error("Linear issue is missing a status; cannot apply factory planning.");
  }
  const allowed = [
    settings.statuses.needsPlan,
    settings.statuses.needsInfo,
    settings.statuses.needsPlanReview,
    settings.statuses.planningFailed,
  ].map(normalizeStatus);
  // The station input gate is the authoritative filter for needsInfo:
  // only planner-question markers may reach this adapter apply step.
  if (allowed.includes(normalizeStatus(statusName))) return;
  throw new Error(
    `Linear issue is in ${statusName}; planning --apply only accepts ${settings.statuses.needsPlan}, ${settings.statuses.needsInfo}, ${settings.statuses.needsPlanReview}, or ${settings.statuses.planningFailed}.`,
  );
}

export function linearPlanningTargetStatus(
  settings: FactoryLinearSettings,
  status: FactoryPlanningRunStatus,
): string {
  switch (status) {
    case "plan-approved":
      return settings.statuses.planning;
    case "plan-needs-human":
      return settings.statuses.needsInfo;
    case "plan-review-unresolved":
      return settings.statuses.needsPlanReview;
    case "planning-failed":
      return settings.statuses.planningFailed;
    case "dry_run":
      throw new Error("Planning --apply cannot be used with dry-run results.");
  }
}

export function linearPlanningApplyCommentMarker(runId: string): string {
  return `<!-- harness-factory:planning-apply:${runId} -->`;
}

export function linearPlanningApplyFailedCommentMarker(runId: string): string {
  return `<!-- harness-factory:planning-apply-failed:${runId} -->`;
}

export function linearPlanningAttentionStageFromComments(
  comments: LinearCommentLike[],
): "plan-needs-human" | "plan-review-unresolved" | undefined {
  const latestPlanningComment = [...comments]
    .filter((comment) => comment.body.includes("<!-- harness-factory:planning-apply:"))
    .sort(compareCommentsByCreatedAt)
    .at(-1);
  const statusMatch = /^Status:\s*(plan-needs-human|plan-review-unresolved)\s*$/m.exec(
    latestPlanningComment?.body ?? "",
  );
  return statusMatch?.[1] as "plan-needs-human" | "plan-review-unresolved" | undefined;
}

export function renderLinearPlanningApplyCompleteComment(
  input: LinearPlanningCompletedInput & { targetStatus: string },
): string {
  return [
    linearPlanningApplyCommentMarker(input.runId),
    "",
    planningCommentHeadline(input.status),
    "",
    `Status: ${input.status}`,
    `Run: \`${input.runDir}\``,
    `Next: ${planningNextAction(input)}`,
    ...(input.approvedPlanPath ? ["", `Plan: \`${input.approvedPlanPath}\``] : []),
    ...(input.draftPlanPath ? ["", `Draft: \`${input.draftPlanPath}\``] : []),
    ...(input.reviewFindingsPath ? [`Findings: \`${input.reviewFindingsPath}\``] : []),
    ...(input.humanQuestions && input.humanQuestions.length > 0
      ? ["", "Questions:", ...input.humanQuestions.map((question) => `- ${question}`)]
      : []),
    ...(input.error ? ["", `Error: ${input.error}`] : []),
    "",
  ].join("\n");
}

export function renderLinearPlanningApplyFailedComment(input: LinearPlanningFailedInput): string {
  return [
    linearPlanningApplyFailedCommentMarker(input.runId),
    "",
    "Factory planning command failed.",
    "",
    `Run: \`${input.runDir}\``,
    `Error: ${input.error}`,
    "",
  ].join("\n");
}

function planningNextAction(
  input: LinearPlanningCompletedInput & { targetStatus: string },
): string {
  switch (input.status) {
    case "plan-approved":
      return "Open/register a plan PR, merge it, then mark the plan merged.";
    case "plan-needs-human":
      return "Answer the questions, then move the issue back to Needs Plan or rerun planning.";
    case "plan-review-unresolved":
      return "Review the draft and findings. Do not implement until the plan is approved and merged.";
    case "planning-failed":
      return "Inspect run artifacts and reset the issue before rerunning planning.";
    case "dry_run":
      return "No Linear update.";
  }
}

function planningCommentHeadline(status: FactoryPlanningRunStatus): string {
  switch (status) {
    case "plan-approved":
      return "Factory plan ready.";
    case "plan-needs-human":
      return "Factory planning needs human input.";
    case "plan-review-unresolved":
      return "Factory plan needs human review.";
    case "planning-failed":
      return "Factory planning failed.";
    case "dry_run":
      return "Factory planning complete.";
  }
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase();
}

function compareCommentsByCreatedAt(a: LinearCommentLike, b: LinearCommentLike): number {
  const left = dateSortValue(a.createdAt);
  const right = dateSortValue(b.createdAt);
  if (left !== right) return left - right;
  return 0;
}

function dateSortValue(value: Date | string | undefined): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
