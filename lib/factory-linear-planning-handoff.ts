import type { FactoryLinearSettings } from "./config.ts";
import type { LinearPlanningApplyDeps } from "./factory-linear-planning-apply.ts";
import type { LinearClientLike } from "./factory-linear-types.ts";

export type LinearPlanningHandoffStage = "publish" | "merged";

export type LinearPlanningHandoffInput = {
  issueRef: string;
  runId: string;
  runDir: string;
  approvedPlanPath: string;
  approvedPlanPrUrl: string;
};

export type LinearPlanningMergedInput = LinearPlanningHandoffInput & {
  approvedPlanCommit: string;
};

export type LinearPlanningHandoffUpdatePlan = {
  issueIdentifier: string;
  runId: string;
  runDir: string;
  stage: LinearPlanningHandoffStage;
  fromStatus?: string;
  targetStatus: string;
  commentMarker: string;
  commentBody: string;
};

export type LinearPlanningReadyCommentInput = {
  runId: string;
  approvedPlanPath: string;
  approvedPlanPrUrl: string;
  runDir: string;
};

export type LinearPlanningApprovedCommentInput = LinearPlanningReadyCommentInput & {
  approvedPlanCommit: string;
};

export async function applyLinearPlanningPublished(
  deps: LinearPlanningApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearPlanningHandoffInput,
): Promise<LinearPlanningHandoffUpdatePlan> {
  await deps.validateStatusMap(client, settings);
  const issue = await deps.fetchIssue(client, settings, input.issueRef);
  const state = await deps.resolveOptional(issue.state);
  await deps.assertIssueInConfiguredScope(issue, settings);
  assertLinearPlanningPublishedApplyAllowed(settings, state?.name);

  const target = await deps.fetchWorkflowState(client, settings, settings.statuses.needsPlanReview);
  await deps.updateIssueStatusIfNeeded(client, issue, state, target);

  const commentMarker = linearPlanningReadyCommentMarker(input.runId);
  const commentBody = renderLinearPlanningReadyComment(input);
  if (!(await deps.issueHasCommentMarker(issue, commentMarker))) {
    await deps.createComment(
      client,
      { issueId: issue.id, body: commentBody },
      "planning publish comment",
    );
  }

  return {
    issueIdentifier: issue.identifier,
    runId: input.runId,
    runDir: input.runDir,
    stage: "publish",
    fromStatus: state?.name,
    targetStatus: target.name,
    commentMarker,
    commentBody,
  };
}

export async function applyLinearPlanningMerged(
  deps: LinearPlanningApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearPlanningMergedInput,
): Promise<LinearPlanningHandoffUpdatePlan> {
  await deps.validateStatusMap(client, settings);
  const issue = await deps.fetchIssue(client, settings, input.issueRef);
  const state = await deps.resolveOptional(issue.state);
  await deps.assertIssueInConfiguredScope(issue, settings);
  assertLinearPlanningMergedApplyAllowed(settings, state?.name);

  const target = await deps.fetchWorkflowState(
    client,
    settings,
    settings.statuses.readyToImplement,
  );
  await deps.updateIssueStatusIfNeeded(client, issue, state, target);

  const commentMarker = linearPlanningApprovedCommentMarker(input.runId);
  const commentBody = renderLinearPlanningApprovedComment(input);
  if (!(await deps.issueHasCommentMarker(issue, commentMarker))) {
    await deps.createComment(
      client,
      { issueId: issue.id, body: commentBody },
      "planning merged comment",
    );
  }

  return {
    issueIdentifier: issue.identifier,
    runId: input.runId,
    runDir: input.runDir,
    stage: "merged",
    fromStatus: state?.name,
    targetStatus: target.name,
    commentMarker,
    commentBody,
  };
}

export function assertLinearPlanningPublishedApplyAllowed(
  settings: FactoryLinearSettings,
  statusName: string | undefined,
): void {
  assertAllowedStatus(
    statusName,
    [settings.statuses.needsPlan, settings.statuses.planning, settings.statuses.needsPlanReview],
    "planning publish --apply",
  );
}

export function assertLinearPlanningMergedApplyAllowed(
  settings: FactoryLinearSettings,
  statusName: string | undefined,
): void {
  assertAllowedStatus(
    statusName,
    [settings.statuses.needsPlanReview, settings.statuses.readyToImplement],
    "planning mark-plan-merged --apply",
  );
}

export function linearPlanningReadyCommentMarker(runId: string): string {
  return `<!-- harness-factory:planning:${runId} -->`;
}

export function linearPlanningApprovedCommentMarker(runId: string): string {
  return `<!-- harness-factory:planning-approved:${runId} -->`;
}

export function renderLinearPlanningReadyComment(input: LinearPlanningReadyCommentInput): string {
  return [
    linearPlanningReadyCommentMarker(input.runId),
    "",
    "Factory plan ready.",
    "",
    `Plan: \`${input.approvedPlanPath}\``,
    `Plan PR: ${input.approvedPlanPrUrl}`,
    `Run: \`${input.runDir}\``,
    "Next: merge plan PR, then move to Ready to Implement.",
    "",
  ].join("\n");
}

export function renderLinearPlanningApprovedComment(
  input: LinearPlanningApprovedCommentInput,
): string {
  return [
    linearPlanningApprovedCommentMarker(input.runId),
    "",
    "Factory plan approved.",
    "",
    `Plan: \`${input.approvedPlanPath}\``,
    `Merged PR: ${input.approvedPlanPrUrl}`,
    `Commit: \`${input.approvedPlanCommit}\``,
    "Next: Ready to Implement.",
    "",
  ].join("\n");
}

function assertAllowedStatus(
  statusName: string | undefined,
  allowed: string[],
  command: string,
): void {
  if (!statusName) {
    throw new Error(`Linear issue is missing a status; cannot apply ${command}.`);
  }
  const normalizedAllowed = allowed.map(normalizeStatus);
  if (normalizedAllowed.includes(normalizeStatus(statusName))) return;
  throw new Error(
    `Linear issue is in ${statusName}; ${command} only accepts ${allowed.join(", ")}.`,
  );
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase();
}
