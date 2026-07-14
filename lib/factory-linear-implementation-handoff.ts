import type { FactoryLinearSettings } from "./config.ts";
import type { LinearImplementationApplyDeps } from "./factory-linear-implementation-apply.ts";
import type { LinearClientLike, LinearIssueLike } from "./factory-linear-types.ts";

export type LinearImplementationPublicationInput = {
  issueRef: string;
  runId: string;
  runDir: string;
  prUrl: string;
  reviewedHead: string;
};

export type LinearImplementationMergeInput = LinearImplementationPublicationInput & {
  mergeCommit: string;
};

export async function applyLinearImplementationPublished(
  deps: LinearImplementationApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearImplementationPublicationInput,
) {
  return applyHandoff(deps, client, settings, input, "published");
}

export async function applyLinearImplementationMerged(
  deps: LinearImplementationApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearImplementationMergeInput,
) {
  return applyHandoff(deps, client, settings, input, "merged");
}

async function applyHandoff(
  deps: LinearImplementationApplyDeps,
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearImplementationPublicationInput | LinearImplementationMergeInput,
  stage: "published" | "merged",
) {
  await deps.validateStatusMap(client, settings);
  const issue = await deps.fetchIssue(client, settings, input.issueRef);
  await deps.assertIssueInConfiguredScope(issue, settings);
  const state = await deps.resolveOptional(issue.state);
  const allowed =
    stage === "published"
      ? [settings.statuses.implementing, settings.statuses.readyForReview, settings.statuses.done]
      : [settings.statuses.readyForReview, settings.statuses.done];
  assertAllowed(state?.name, allowed, `implementation ${stage}`);
  const targetName =
    stage === "published" && sameState(state?.name, settings.statuses.done)
      ? settings.statuses.done
      : stage === "published"
        ? settings.statuses.readyForReview
        : settings.statuses.done;
  const target = await deps.fetchWorkflowState(client, settings, targetName);
  if (!sameState(state?.name, targetName)) {
    deps.assertMutationSuccess(
      await client.updateIssue(issue.id, { stateId: target.id }),
      `implementation ${stage}`,
    );
  }
  const fresh = await client.issue(issue.id);
  assertSameIssue(issue, fresh);
  await deps.assertIssueInConfiguredScope(fresh, settings);
  const freshState = await deps.resolveOptional(fresh.state);
  assertAllowed(freshState?.name, [targetName], `implementation ${stage} postcondition`);
  const marker =
    stage === "published"
      ? `<!-- harness-factory:implementation-pr:${input.runId} -->`
      : `<!-- harness-factory:implementation-merged:${input.runId} -->`;
  const body = renderComment(input, stage, marker);
  if (!(await deps.issueHasCommentMarker(fresh, marker)))
    await deps.createComment(
      client,
      { issueId: fresh.id, body },
      `implementation ${stage} comment`,
    );
  return {
    issueIdentifier: issue.identifier,
    runId: input.runId,
    runDir: input.runDir,
    stage,
    fromStatus: state?.name,
    targetStatus: targetName,
    commentMarker: marker,
    commentBody: body,
  };
}

function renderComment(
  input: LinearImplementationPublicationInput | LinearImplementationMergeInput,
  stage: "published" | "merged",
  marker: string,
): string {
  return [
    marker,
    "",
    stage === "published" ? "Factory implementation PR ready." : "Factory implementation merged.",
    "",
    `PR: ${input.prUrl}`,
    `Reviewed head: \`${input.reviewedHead}\``,
    ...(stage === "merged"
      ? [`Merge commit: \`${(input as LinearImplementationMergeInput).mergeCommit}\``]
      : ["Next: human merge decision required. Opening this PR does not authorize merge."]),
    `Run: \`${input.runDir}\``,
    "",
  ].join("\n");
}

function assertAllowed(actual: string | undefined, allowed: string[], operation: string): void {
  if (actual && allowed.some((value) => sameState(actual, value))) return;
  throw new Error(
    `Linear issue is in ${String(actual ?? "none")}; ${operation} requires ${allowed.join(", ")}.`,
  );
}

function sameState(actual: string | undefined, expected: string): boolean {
  return actual?.trim().toLowerCase() === expected.trim().toLowerCase();
}

function assertSameIssue(original: LinearIssueLike, fresh: LinearIssueLike): void {
  if (original.id !== fresh.id || original.identifier !== fresh.identifier)
    throw new Error("Linear issue identity changed during implementation handoff.");
}
