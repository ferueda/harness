import type { LinearService } from "../linear/client.ts";
import type { WorkRequestData } from "./events/work-events.ts";
import type { LinearReadinessConfig } from "./readiness.ts";
import { isCurrentImplementationClaim } from "./implementation-authority.ts";
import { implementationCommentMarker } from "./implementation-cycle.ts";
import { renderImplementationFailureComment } from "./implementation-presentation.ts";

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
  issueId: string;
  marker: string;
  comment: string;
  readiness: LinearReadinessConfig;
  targetStateId: string;
}): Promise<void> {
  await input.linear.ensureComment({
    issueId: input.issueId,
    marker: input.marker,
    body: input.comment,
  });
  await input.linear.updateIssueState({
    issueId: input.issueId,
    expectedStateId: input.readiness.stateIds.inProgress,
    stateId: input.targetStateId,
  });
  await input.linear.updateIssueLabels({
    issueId: input.issueId,
    addLabelIds: [],
    removeLabelIds: [
      input.readiness.agentActionLabelIds.implement,
      input.readiness.agentReadyLabelId,
    ],
  });
}

export async function recoverImplementationFailure(input: {
  linear: LinearImplementationProjectionService;
  event: WorkRequestData;
  readiness: LinearReadinessConfig;
  error: string;
}): Promise<boolean> {
  const context = await input.linear.getIssueContext(input.event.issueId);
  if (!isCurrentImplementationClaim(context, input.readiness, { allowAgentReady: true }))
    return false;
  await input.linear.ensureComment({
    issueId: input.event.issueId,
    marker: implementationCommentMarker(input.event, "failure"),
    body: renderImplementationFailureComment({
      marker: implementationCommentMarker(input.event, "failure"),
      error: input.error,
    }),
  });
  await input.linear.updateIssueState({
    issueId: input.event.issueId,
    expectedStateId: input.readiness.stateIds.inProgress,
    stateId: input.readiness.stateIds.open,
  });
  await input.linear.updateIssueLabels({
    issueId: input.event.issueId,
    addLabelIds: [input.readiness.agentActionLabelIds.implement],
    removeLabelIds: [input.readiness.agentReadyLabelId],
  });
  return true;
}

export async function ensureImplementationFailureComment(input: {
  linear: Pick<LinearImplementationProjectionService, "ensureComment">;
  event: WorkRequestData;
  error: string;
}): Promise<void> {
  const marker = implementationCommentMarker(input.event, "failure");
  await input.linear.ensureComment({
    issueId: input.event.issueId,
    marker,
    body: renderImplementationFailureComment({ marker, error: input.error }),
  });
}
