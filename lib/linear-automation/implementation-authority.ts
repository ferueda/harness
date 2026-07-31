import { createHash } from "node:crypto";
import type { LinearService } from "../linear/client.ts";
import type { LinearIssueContext } from "../linear/types.ts";
import {
  CompleteImplementationWorkItemSchema,
  type ImplementationLinearSource,
} from "../implementation/source.ts";
import type { WorkRequestData } from "./events/work-events.ts";
import { classifyLinearReadiness, type LinearReadinessConfig } from "./readiness.ts";
import { toLinearWorkItemContext } from "./work-item.ts";

type ImplementationAuthorityLinear = Pick<LinearService, "getIssueContext">;

export type ImplementationAuthority = Readonly<{
  issueId: string;
  issueIdentifier: string;
  sourceFingerprint: string;
}>;

export type LoadedImplementation =
  | Readonly<{ kind: "eligible"; authority: ImplementationAuthority }>
  | Readonly<{
      kind: "ineligible";
      reason:
        | "issue-mismatch"
        | "incomplete-context"
        | "not-implementation-ready"
        | "stale-snapshot";
    }>;

export type ConfirmedImplementation =
  | Readonly<{ kind: "confirmed"; workItem?: ImplementationLinearSource["workItem"] }>
  | Readonly<{ kind: "stale"; reason: string }>;

export async function loadEligibleImplementation(
  linear: ImplementationAuthorityLinear,
  event: WorkRequestData,
  readiness: LinearReadinessConfig,
): Promise<LoadedImplementation> {
  const context = await linear.getIssueContext(event.issueId);
  if (context.id !== event.issueId || context.identifier !== event.issueIdentifier) {
    return { kind: "ineligible", reason: "issue-mismatch" };
  }
  if (!isComplete(context)) return { kind: "ineligible", reason: "incomplete-context" };
  const decision = classifyLinearReadiness({ context, config: readiness });
  if (decision.kind !== "dispatch" || decision.route !== "implement") {
    return { kind: "ineligible", reason: "not-implementation-ready" };
  }
  if (decision.snapshotGeneration !== event.snapshotGeneration) {
    return { kind: "ineligible", reason: "stale-snapshot" };
  }
  return {
    kind: "eligible",
    authority: {
      issueId: context.id,
      issueIdentifier: context.identifier,
      sourceFingerprint: sourceFingerprint(context, readiness.agentReadyLabelId),
    },
  };
}

export async function loadClaimedImplementation(
  linear: ImplementationAuthorityLinear,
  authority: ImplementationAuthority,
  readiness: LinearReadinessConfig,
): Promise<ConfirmedImplementation> {
  const context = await linear.getIssueContext(authority.issueId);
  const confirmed = confirmContext(context, authority, readiness);
  if (confirmed.kind === "stale") return confirmed;
  const workItem = CompleteImplementationWorkItemSchema.safeParse(
    toLinearWorkItemContext(context, readiness.agentReadyLabelId),
  );
  if (!workItem.success) return { kind: "stale", reason: "implementation context is invalid" };
  return { kind: "confirmed", workItem: workItem.data };
}

export async function confirmClaimedImplementation(
  linear: ImplementationAuthorityLinear,
  authority: ImplementationAuthority,
  readiness: LinearReadinessConfig,
): Promise<ConfirmedImplementation> {
  return confirmContext(await linear.getIssueContext(authority.issueId), authority, readiness);
}

export function isCurrentImplementationClaim(
  context: LinearIssueContext,
  readiness: LinearReadinessConfig,
  options: Readonly<{ allowAgentReady?: boolean }> = {},
): boolean {
  if (
    !isComplete(context) ||
    context.team.id !== readiness.teamId ||
    context.project?.id !== readiness.projectId ||
    context.state.id !== readiness.stateIds.inProgress ||
    (!options.allowAgentReady &&
      context.labels.some((label) => label.id === readiness.agentReadyLabelId))
  ) {
    return false;
  }
  const actions = context.labels.filter((label) =>
    Object.values(readiness.agentActionLabelIds).includes(label.id),
  );
  return actions.length === 1 && actions[0]?.id === readiness.agentActionLabelIds.implement;
}

function confirmContext(
  context: LinearIssueContext,
  authority: ImplementationAuthority,
  readiness: LinearReadinessConfig,
): ConfirmedImplementation {
  if (!isComplete(context)) return { kind: "stale", reason: "context is incomplete" };
  if (
    context.id !== authority.issueId ||
    context.identifier !== authority.issueIdentifier ||
    context.team.id !== readiness.teamId ||
    context.project?.id !== readiness.projectId
  ) {
    return { kind: "stale", reason: "issue scope or identity changed" };
  }
  if (!isCurrentImplementationClaim(context, readiness)) {
    return { kind: "stale", reason: "issue is no longer claimed for implementation" };
  }
  if (sourceFingerprint(context, readiness.agentReadyLabelId) !== authority.sourceFingerprint) {
    return { kind: "stale", reason: "Linear implementation source changed" };
  }
  return { kind: "confirmed" };
}

function sourceFingerprint(context: LinearIssueContext, agentReadyLabelId: string): string {
  const workItem = toLinearWorkItemContext(context, agentReadyLabelId);
  const { state: _state, updatedAt: _updatedAt, ...source } = workItem;
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function isComplete(context: LinearIssueContext): boolean {
  return !Object.values(context.completeness).some(Boolean);
}
