import type { LinearService } from "../linear/client.ts";
import { renderSpecFailureComment } from "../spec/presentation.ts";
import type { SpecDecision } from "../spec/schema.ts";
import type { WorkRequestData } from "./events/work-events.ts";
import { workRequestEventId } from "./events/work-events.ts";
import type { LinearReadinessConfig } from "./readiness.ts";
import { isCurrentSpecClaim, type SpecAuthority } from "./spec-authority.ts";

export type LinearSpecProjectionService = Pick<
  LinearService,
  "getIssueContext" | "ensureComment" | "updateIssueLabels" | "updateIssueState"
>;

export async function claimSpecState(
  linear: Pick<LinearSpecProjectionService, "updateIssueState">,
  issueId: string,
  readiness: LinearReadinessConfig,
): Promise<void> {
  await linear.updateIssueState({
    issueId,
    expectedStateId: readiness.stateIds.open,
    stateId: readiness.stateIds.inProgress,
  });
}

export async function consumeSpecAgentReady(
  linear: Pick<LinearSpecProjectionService, "updateIssueLabels">,
  issueId: string,
  readiness: LinearReadinessConfig,
): Promise<void> {
  await linear.updateIssueLabels({
    issueId,
    addLabelIds: [],
    removeLabelIds: [readiness.agentReadyLabelId],
  });
}

export async function projectSpecOutcome(input: {
  linear: LinearSpecProjectionService;
  issueId: string;
  marker: string;
  comment: string;
  specLabelId: string;
  inProgressStateId: string;
  targetStateId: string;
}): Promise<void> {
  await input.linear.ensureComment({
    issueId: input.issueId,
    marker: input.marker,
    body: input.comment,
  });
  await input.linear.updateIssueState({
    issueId: input.issueId,
    expectedStateId: input.inProgressStateId,
    stateId: input.targetStateId,
  });
  await input.linear.updateIssueLabels({
    issueId: input.issueId,
    addLabelIds: [],
    removeLabelIds: [input.specLabelId],
  });
}

export async function beginSpecRecovery(input: {
  linear: LinearSpecProjectionService;
  event: WorkRequestData;
  authority: SpecAuthority;
  readiness: LinearReadinessConfig;
  error: string;
  allowAgentReadyClaim?: boolean;
}): Promise<Readonly<{ currentClaim: boolean }>> {
  const context = await input.linear.getIssueContext(input.event.issueId);
  const currentClaim = isCurrentSpecClaim(context, input.authority, input.readiness, {
    allowAgentReady: input.allowAgentReadyClaim,
  });
  const marker = specCommentMarker(input.event, "failure");
  await input.linear.ensureComment({
    issueId: input.event.issueId,
    marker,
    body: renderSpecFailureComment({ marker, error: input.error }),
  });
  return { currentClaim };
}

export async function reopenSpecClaim(input: {
  linear: Pick<LinearSpecProjectionService, "updateIssueState">;
  issueId: string;
  readiness: LinearReadinessConfig;
}): Promise<void> {
  await input.linear.updateIssueState({
    issueId: input.issueId,
    expectedStateId: input.readiness.stateIds.inProgress,
    stateId: input.readiness.stateIds.open,
  });
}

export async function finishSpecRecovery(input: {
  linear: Pick<LinearSpecProjectionService, "updateIssueLabels">;
  issueId: string;
  readiness: LinearReadinessConfig;
}): Promise<void> {
  await input.linear.updateIssueLabels({
    issueId: input.issueId,
    addLabelIds: [],
    removeLabelIds: [input.readiness.agentReadyLabelId],
  });
}

export function specCommentMarker(
  event: WorkRequestData,
  outcome: SpecDecision["outcome"] | "failure" | "cleanup-failure",
): string {
  return `<!-- harness:linear-spec:${workRequestEventId("spec", event)}:${outcome} -->`;
}

export function specCycleCommentMarker(identity: string, outcome: string): string {
  return `<!-- harness:linear-spec:${identity}:${outcome} -->`;
}

export async function ensureSpecFailureComment(input: {
  linear: Pick<LinearSpecProjectionService, "ensureComment">;
  event: WorkRequestData;
  error: string;
  markerKind?: "failure" | "cleanup-failure";
  bestEffort?: boolean;
}): Promise<Readonly<{ projected: boolean }>> {
  const marker = specCommentMarker(input.event, input.markerKind ?? "failure");
  try {
    await input.linear.ensureComment({
      issueId: input.event.issueId,
      marker,
      body: renderSpecFailureComment({ marker, error: input.error }),
    });
    return { projected: true };
  } catch (error) {
    if (!input.bestEffort) throw error;
    return { projected: false };
  }
}
