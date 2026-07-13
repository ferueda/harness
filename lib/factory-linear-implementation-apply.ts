import type { FactoryLinearSettings } from "./config.ts";
import type {
  LinearClientLike,
  LinearIssueLike,
  LinearWorkflowStateLike,
} from "./factory-linear-types.ts";

export type LinearImplementationUpdateStage = "started" | "completed" | "failed";

export type LinearImplementationApplyInput = {
  issueRef: string;
  runId: string;
  runDir: string;
};

export type LinearImplementationStartedInput = LinearImplementationApplyInput & {
  intent: "start" | "restart";
};

export type LinearImplementationCompletedInput = LinearImplementationApplyInput & {
  reviewBase: string;
  reviewHead: string;
  reviewCommitSha: string;
};

export type LinearImplementationFailedInput = LinearImplementationApplyInput & { error: string };
export type LinearImplementationAttentionInput = LinearImplementationApplyInput & {
  verdict: "needs_changes" | "blocked" | "human_required";
  candidateCommit: string;
};

export type LinearImplementationUpdatePlan = {
  issueIdentifier: string;
  runId: string;
  runDir: string;
  stage: LinearImplementationUpdateStage;
  fromStatus?: string;
  targetStatus: string;
  commentMarker?: string;
  commentBody?: string;
  statusMutationCompleted?: boolean;
  statusPostconditionVerified?: boolean;
  commentPresent?: boolean;
};

export class LinearImplementationTerminalApplyError extends Error {
  readonly update: LinearImplementationUpdatePlan;

  constructor(cause: unknown, update: LinearImplementationUpdatePlan) {
    super(errorMessage(cause), { cause });
    this.name = "LinearImplementationTerminalApplyError";
    this.update = update;
  }
}

export type LinearImplementationUpdateSummary = {
  started?: LinearImplementationUpdatePlan;
  terminal?: LinearImplementationUpdatePlan;
};

export type LinearImplementationApplyDeps = {
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
  assertMutationSuccess: (result: { success: boolean }, operation: string) => void;
  issueHasCommentMarker: (issue: LinearIssueLike, marker: string) => Promise<boolean>;
  createComment: (
    client: LinearClientLike,
    input: { issueId: string; body: string },
    operation: string,
  ) => Promise<void>;
};

export async function applyLinearImplementationStarted(
  deps: LinearImplementationApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearImplementationStartedInput,
): Promise<LinearImplementationUpdatePlan> {
  const statuses = requiredStatuses(settings);
  await deps.validateStatusMap(client, settings);
  const issue = await deps.fetchIssue(client, settings, input.issueRef);
  const state = await deps.resolveOptional(issue.state);
  await deps.assertIssueInConfiguredScope(issue, settings);
  const required =
    input.intent === "start" ? statuses.readyToImplement : statuses.implementationFailed;
  const alreadyImplementing =
    input.intent === "restart" && sameState(state?.name, statuses.implementing);
  if (!alreadyImplementing) assertState(state?.name, required, "implementation start");
  const target = await deps.fetchWorkflowState(client, settings, statuses.implementing);
  if (alreadyImplementing)
    return {
      ...update(input, issue, "started", state?.name, target.name),
      statusMutationCompleted: false,
      statusPostconditionVerified: true,
    };
  const current = await assertFreshState(deps, client, settings, issue, required);
  deps.assertMutationSuccess(
    await client.updateIssue(current.id, { stateId: target.id }),
    "implementation start",
  );
  await assertFreshState(deps, client, settings, issue, target.name);
  return {
    ...update(input, issue, "started", state?.name, target.name),
    statusMutationCompleted: true,
    statusPostconditionVerified: true,
  };
}

export async function applyLinearImplementationCompleted(
  deps: LinearImplementationApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearImplementationCompletedInput,
): Promise<LinearImplementationUpdatePlan> {
  const statuses = requiredStatuses(settings);
  await deps.validateStatusMap(client, settings);
  const issue = await deps.fetchIssue(client, settings, input.issueRef);
  const state = await deps.resolveOptional(issue.state);
  await deps.assertIssueInConfiguredScope(issue, settings);
  assertState(state?.name, statuses.implementing, "implementation completion");
  const fresh = await assertFreshState(deps, client, settings, issue, statuses.implementing);
  const commentMarker = linearImplementationCompletedMarker(input.runId);
  const commentBody = renderLinearImplementationCompletedComment(input);
  const progress: LinearImplementationUpdatePlan = {
    ...update(input, issue, "completed", state?.name, statuses.implementing),
    commentMarker,
    commentBody,
    statusMutationCompleted: false,
    statusPostconditionVerified: true,
    commentPresent: false,
  };
  try {
    if (!(await deps.issueHasCommentMarker(fresh, commentMarker))) {
      const commentIssue = await assertFreshState(
        deps,
        client,
        settings,
        issue,
        statuses.implementing,
      );
      await deps.createComment(
        client,
        { issueId: commentIssue.id, body: commentBody },
        "implementation completion comment",
      );
    }
    return { ...progress, commentPresent: true };
  } catch (error) {
    throw new LinearImplementationTerminalApplyError(error, progress);
  }
}

export async function applyLinearImplementationFailed(
  deps: LinearImplementationApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearImplementationFailedInput,
): Promise<LinearImplementationUpdatePlan> {
  const statuses = requiredStatuses(settings);
  await deps.validateStatusMap(client, settings);
  const issue = await deps.fetchIssue(client, settings, input.issueRef);
  const state = await deps.resolveOptional(issue.state);
  await deps.assertIssueInConfiguredScope(issue, settings);
  assertState(state?.name, statuses.implementing, "implementation failure");
  const target = await deps.fetchWorkflowState(client, settings, statuses.implementationFailed);
  const current = await assertFreshState(deps, client, settings, issue, statuses.implementing);
  deps.assertMutationSuccess(
    await client.updateIssue(current.id, { stateId: target.id }),
    "implementation failure",
  );
  const commentMarker = linearImplementationFailedMarker(input.runId);
  const commentBody = renderLinearImplementationFailedComment(input, issue.identifier);
  let progress: LinearImplementationUpdatePlan = {
    ...update(input, issue, "failed", state?.name, target.name),
    commentMarker,
    commentBody,
    statusMutationCompleted: true,
    statusPostconditionVerified: false,
    commentPresent: false,
  };
  try {
    const fresh = await assertFreshState(deps, client, settings, issue, target.name);
    progress = { ...progress, statusPostconditionVerified: true };
    if (!(await deps.issueHasCommentMarker(fresh, commentMarker))) {
      const commentIssue = await assertFreshState(deps, client, settings, issue, target.name);
      await deps.createComment(
        client,
        { issueId: commentIssue.id, body: commentBody },
        "implementation failure comment",
      );
    }
    return { ...progress, commentPresent: true };
  } catch (error) {
    throw new LinearImplementationTerminalApplyError(error, progress);
  }
}

export async function applyLinearImplementationAttention(
  deps: LinearImplementationApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearImplementationAttentionInput,
): Promise<LinearImplementationUpdatePlan> {
  const statuses = requiredStatuses(settings);
  await deps.validateStatusMap(client, settings);
  const issue = await deps.fetchIssue(client, settings, input.issueRef);
  const state = await deps.resolveOptional(issue.state);
  await deps.assertIssueInConfiguredScope(issue, settings);
  assertState(state?.name, statuses.implementing, "implementation attention");
  const fresh = await assertFreshState(deps, client, settings, issue, statuses.implementing);
  const commentMarker = `<!-- harness-factory:implementation-attention:${input.runId} -->`;
  const commentBody = [
    commentMarker,
    "",
    "Factory implementation needs human attention.",
    "",
    `Verdict: ${input.verdict}`,
    `Candidate: \`${input.candidateCommit}\``,
    `Run: \`${input.runDir}\``,
    "",
  ].join("\n");
  if (!(await deps.issueHasCommentMarker(fresh, commentMarker)))
    await deps.createComment(
      client,
      { issueId: fresh.id, body: commentBody },
      "implementation attention comment",
    );
  return {
    ...update(input, issue, "completed", state?.name, statuses.implementing),
    commentMarker,
    commentBody,
    statusMutationCompleted: false,
    statusPostconditionVerified: true,
    commentPresent: true,
  };
}

export function linearImplementationCompletedMarker(runId: string): string {
  return `<!-- harness-factory:implementation:${runId} -->`;
}

export function linearImplementationFailedMarker(runId: string): string {
  return `<!-- harness-factory:implementation-failed:${runId} -->`;
}

function requiredStatuses(settings: FactoryLinearSettings): {
  readyToImplement: string;
  implementing: string;
  implementationFailed: string;
} {
  return {
    readyToImplement: settings.statuses.readyToImplement,
    implementing: settings.statuses.implementing,
    implementationFailed: settings.statuses.implementationFailed,
  };
}

async function assertFreshState(
  deps: LinearImplementationApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  original: LinearIssueLike,
  expected: string,
): Promise<LinearIssueLike> {
  await deps.validateStatusMap(client, settings);
  const fresh = await client.issue(original.id);
  if (fresh.id !== original.id || fresh.identifier !== original.identifier)
    throw new Error("Linear issue identity changed during implementation apply.");
  await deps.assertIssueInConfiguredScope(fresh, settings);
  const state = await deps.resolveOptional(fresh.state);
  assertState(state?.name, expected, "implementation postcondition");
  return fresh;
}

function assertState(actual: string | undefined, expected: string, operation: string): void {
  if (sameState(actual, expected)) return;
  throw new Error(
    `Linear issue is in ${String(actual ?? "none")}; ${operation} requires ${expected}.`,
  );
}

function sameState(actual: string | undefined, expected: string): boolean {
  return actual?.trim().toLowerCase() === expected.trim().toLowerCase();
}

function update(
  input: LinearImplementationApplyInput,
  issue: LinearIssueLike,
  stage: LinearImplementationUpdateStage,
  fromStatus: string | undefined,
  targetStatus: string,
): LinearImplementationUpdatePlan {
  return {
    issueIdentifier: issue.identifier,
    runId: input.runId,
    runDir: input.runDir,
    stage,
    fromStatus,
    targetStatus,
  };
}

function renderLinearImplementationCompletedComment(
  input: LinearImplementationCompletedInput,
): string {
  return [
    linearImplementationCompletedMarker(input.runId),
    "",
    "Factory implementation review passed.",
    "",
    "Status: complete",
    `Run: \`${input.runDir}\``,
    `Review base: \`${input.reviewBase}\``,
    `Review head: \`${input.reviewHead}\``,
    `Review commit: \`${input.reviewCommitSha}\``,
    "The persisted branch now points at this exact reviewed candidate.",
    "",
  ].join("\n");
}

function renderLinearImplementationFailedComment(
  input: LinearImplementationFailedInput,
  issueIdentifier: string,
): string {
  return [
    linearImplementationFailedMarker(input.runId),
    "",
    "Factory implementation failed.",
    "",
    "Status: implementation-failed",
    `Run: \`${input.runDir}\``,
    `Error: ${input.error}`,
    `Retry: inspect the run, then run \`harness factory implementation run --linear-issue ${issueIdentifier} --rerun --apply\`.`,
    "",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
