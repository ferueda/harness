import type { LinearService } from "../linear/client.ts";
import type { ImplementationWorkRequestData } from "./events/work-events.ts";
import type { LinearReadinessConfig } from "./readiness.ts";
import {
  confirmImplementationSourceContext,
  isCurrentImplementationClaim,
  type ImplementationAuthority,
} from "./implementation-authority.ts";
import { implementationCommentMarker } from "./implementation-cycle.ts";
import {
  renderImplementationCleanupFailureComment,
  renderImplementationFailureComment,
} from "./implementation-presentation.ts";

export type LinearImplementationProjectionService = Pick<
  LinearService,
  "getIssueContext" | "ensureComment" | "updateIssueLabels" | "updateIssueState"
>;

export async function claimImplementationState(
  linear: Pick<LinearImplementationProjectionService, "updateIssueState">,
  issueId: string,
  readiness: LinearReadinessConfig,
): Promise<void> {
  await linear.updateIssueState({
    issueId,
    expectedStateId: readiness.stateIds.open,
    stateId: readiness.stateIds.inProgress,
  });
}

export async function consumeImplementationAgentReady(
  linear: Pick<LinearImplementationProjectionService, "updateIssueLabels">,
  issueId: string,
  readiness: LinearReadinessConfig,
): Promise<void> {
  await linear.updateIssueLabels({
    issueId,
    addLabelIds: [],
    removeLabelIds: [readiness.agentReadyLabelId],
  });
}

export async function projectImplementationOutcome(input: {
  linear: LinearImplementationProjectionService;
  authority: ImplementationAuthority;
  issueId: string;
  marker: string;
  comment: string;
  readiness: LinearReadinessConfig;
  targetStateId: string;
}): Promise<Readonly<{ kind: "projected" }> | Readonly<{ kind: "stale"; reason: string }>> {
  const context = await input.linear.getIssueContext(input.issueId);
  const source = confirmImplementationSourceContext(context, input.authority, input.readiness);
  if (source.kind === "stale") return source;
  if (
    context.state.id !== input.readiness.stateIds.inProgress &&
    context.state.id !== input.targetStateId
  ) {
    return { kind: "stale", reason: "issue is no longer in a projectable implementation state" };
  }
  await input.linear.ensureComment({
    issueId: input.issueId,
    marker: input.marker,
    body: input.comment,
  });
  if (context.state.id === input.readiness.stateIds.inProgress) {
    await input.linear.updateIssueState({
      issueId: input.issueId,
      expectedStateId: input.readiness.stateIds.inProgress,
      stateId: input.targetStateId,
    });
  }
  await input.linear.updateIssueLabels({
    issueId: input.issueId,
    addLabelIds: [],
    removeLabelIds: [
      input.readiness.agentActionLabelIds.implement,
      input.readiness.agentReadyLabelId,
    ],
  });
  return { kind: "projected" };
}

export async function beginImplementationFailureRecovery(input: {
  linear: LinearImplementationProjectionService;
  issueId: string;
  readiness: LinearReadinessConfig;
  authority: ImplementationAuthority;
}): Promise<Readonly<{ reopen: boolean; removeAgentReady: boolean }>> {
  const context = await input.linear.getIssueContext(input.issueId);
  const confirmed = confirmImplementationSourceContext(context, input.authority, input.readiness);
  if (confirmed.kind === "stale") return { reopen: false, removeAgentReady: false };
  if (isCurrentImplementationClaim(context, input.readiness, { allowAgentReady: true })) {
    return { reopen: true, removeAgentReady: true };
  }
  const actions = context.labels.filter((label) =>
    Object.values(input.readiness.agentActionLabelIds).includes(label.id),
  );
  const partialClaim =
    !Object.values(context.completeness).some(Boolean) &&
    context.team.id === input.readiness.teamId &&
    context.project?.id === input.readiness.projectId &&
    context.state.id === input.readiness.stateIds.open &&
    actions.length === 1 &&
    actions[0]?.id === input.readiness.agentActionLabelIds.implement &&
    context.labels.some((label) => label.id === input.readiness.agentReadyLabelId);
  return partialClaim
    ? { reopen: false, removeAgentReady: true }
    : { reopen: false, removeAgentReady: false };
}

export async function reopenImplementationClaim(input: {
  linear: Pick<LinearImplementationProjectionService, "updateIssueState">;
  issueId: string;
  readiness: LinearReadinessConfig;
}): Promise<void> {
  await input.linear.updateIssueState({
    issueId: input.issueId,
    expectedStateId: input.readiness.stateIds.inProgress,
    stateId: input.readiness.stateIds.open,
  });
}

export async function finishImplementationRecovery(input: {
  linear: Pick<LinearImplementationProjectionService, "updateIssueLabels">;
  issueId: string;
  readiness: LinearReadinessConfig;
}): Promise<void> {
  await input.linear.updateIssueLabels({
    issueId: input.issueId,
    addLabelIds: [input.readiness.agentActionLabelIds.implement],
    removeLabelIds: [input.readiness.agentReadyLabelId],
  });
}

export async function ensureImplementationFailureComment(input: {
  linear: Pick<LinearImplementationProjectionService, "ensureComment">;
  event: ImplementationWorkRequestData;
  error: string;
  bestEffort?: boolean;
}): Promise<void> {
  const marker = implementationCommentMarker(input.event, "failure");
  try {
    await input.linear.ensureComment({
      issueId: input.event.issueId,
      marker,
      body: renderImplementationFailureComment({ marker, error: input.error }),
    });
  } catch (error) {
    if (!input.bestEffort) throw error;
  }
}

export async function ensureImplementationCleanupFailureComment(input: {
  linear: Pick<LinearImplementationProjectionService, "ensureComment">;
  event: ImplementationWorkRequestData;
  error: string;
  bestEffort?: boolean;
}): Promise<void> {
  const marker = implementationCommentMarker(input.event, "cleanup-failure");
  try {
    await input.linear.ensureComment({
      issueId: input.event.issueId,
      marker,
      body: renderImplementationCleanupFailureComment({ marker, error: input.error }),
    });
  } catch (error) {
    if (!input.bestEffort) throw error;
  }
}
