import { createHash } from "node:crypto";
import type { LinearService } from "../linear/client.ts";
import type { LinearIssueContext } from "../linear/types.ts";
import { SpecWorkItemContextSchema, type SpecWorkItemContext } from "../spec/schema.ts";
import type { WorkRequestData } from "./events/work-events.ts";
import { classifyLinearReadiness, type LinearReadinessConfig } from "./readiness.ts";
import { toLinearWorkItemContext } from "./work-item.ts";

type SpecAuthorityLinear = Pick<LinearService, "getIssueContext">;

export type SpecAuthority = Readonly<{
  issueId: string;
  issueIdentifier: string;
  sourceFingerprint: string;
}>;

export type LoadedSpec =
  | Readonly<{ kind: "eligible"; authority: SpecAuthority }>
  | Readonly<{
      kind: "ineligible";
      reason: "issue-mismatch" | "incomplete-context" | "not-spec-ready" | "stale-snapshot";
    }>;

export type ConfirmedSpec =
  | Readonly<{ kind: "confirmed" }>
  | Readonly<{ kind: "stale"; reason: string }>;

export type ConfirmedWorkItem =
  | Readonly<{ kind: "confirmed"; workItem: SpecWorkItemContext }>
  | Readonly<{ kind: "stale"; reason: string }>;

export async function loadEligibleSpec(
  linear: SpecAuthorityLinear,
  event: WorkRequestData,
  readiness: LinearReadinessConfig,
): Promise<LoadedSpec> {
  const context = await linear.getIssueContext(event.issueId);
  if (context.id !== event.issueId || context.identifier !== event.issueIdentifier) {
    return { kind: "ineligible", reason: "issue-mismatch" };
  }
  if (!isComplete(context)) return { kind: "ineligible", reason: "incomplete-context" };

  const decision = classifyLinearReadiness({ context, config: readiness });
  if (decision.kind !== "dispatch" || decision.route !== "spec") {
    return { kind: "ineligible", reason: "not-spec-ready" };
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

export async function loadClaimedWorkItem(
  linear: SpecAuthorityLinear,
  authority: SpecAuthority,
  readiness: LinearReadinessConfig,
): Promise<ConfirmedWorkItem> {
  const context = await linear.getIssueContext(authority.issueId);
  const confirmed = confirmContext(context, authority, readiness);
  if (confirmed.kind === "stale") return confirmed;
  return {
    kind: "confirmed",
    workItem: SpecWorkItemContextSchema.parse(
      toLinearWorkItemContext(context, readiness.agentReadyLabelId),
    ),
  };
}

export async function confirmClaimedSpec(
  linear: SpecAuthorityLinear,
  authority: SpecAuthority,
  readiness: LinearReadinessConfig,
): Promise<ConfirmedSpec> {
  return confirmContext(await linear.getIssueContext(authority.issueId), authority, readiness);
}

export function isCurrentSpecClaim(
  context: LinearIssueContext,
  authority: SpecAuthority,
  readiness: LinearReadinessConfig,
  options: Readonly<{ allowAgentReady?: boolean }> = {},
): boolean {
  if (
    !isComplete(context) ||
    context.id !== authority.issueId ||
    context.identifier !== authority.issueIdentifier ||
    context.team.id !== readiness.teamId ||
    context.project?.id !== readiness.projectId ||
    context.state.id !== readiness.stateIds.inProgress ||
    (!options.allowAgentReady &&
      context.labels.some((label) => label.id === readiness.agentReadyLabelId))
  ) {
    return false;
  }
  const actions = agentActions(context, readiness);
  return actions.length === 1 && actions[0]?.id === readiness.agentActionLabelIds.spec;
}

function confirmContext(
  context: LinearIssueContext,
  authority: SpecAuthority,
  readiness: LinearReadinessConfig,
): ConfirmedSpec {
  if (!isComplete(context)) return { kind: "stale", reason: "context is incomplete" };
  if (
    context.id !== authority.issueId ||
    context.identifier !== authority.issueIdentifier ||
    context.team.id !== readiness.teamId ||
    context.project?.id !== readiness.projectId
  ) {
    return { kind: "stale", reason: "issue scope or identity changed" };
  }
  if (context.state.id !== readiness.stateIds.inProgress) {
    return { kind: "stale", reason: "issue is no longer In Progress" };
  }
  if (context.labels.some((label) => label.id === readiness.agentReadyLabelId)) {
    return { kind: "stale", reason: "Agent Ready permission is present again" };
  }
  const actions = agentActions(context, readiness);
  if (
    actions.length !== 1 ||
    actions[0]?.id !== readiness.agentActionLabelIds.spec ||
    hasUnresolvedBlocker(context, readiness)
  ) {
    return { kind: "stale", reason: "Spec action or blockers changed" };
  }
  if (sourceFingerprint(context, readiness.agentReadyLabelId) !== authority.sourceFingerprint) {
    return { kind: "stale", reason: "Linear source context changed" };
  }
  return { kind: "confirmed" };
}

function agentActions(
  context: LinearIssueContext,
  readiness: LinearReadinessConfig,
): LinearIssueContext["labels"] {
  return context.labels.filter((label) =>
    Object.values(readiness.agentActionLabelIds).includes(label.id),
  );
}

function sourceFingerprint(context: LinearIssueContext, agentReadyLabelId: string): string {
  const workItem = toLinearWorkItemContext(context, agentReadyLabelId);
  const { state: _state, updatedAt: _updatedAt, ...source } = workItem;
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function hasUnresolvedBlocker(
  context: LinearIssueContext,
  readiness: LinearReadinessConfig,
): boolean {
  const terminal = new Set([
    readiness.stateIds.done,
    readiness.stateIds.canceled,
    readiness.stateIds.duplicate,
  ]);
  return context.blockedBy.some((blocker) => !terminal.has(blocker.state.id));
}

function isComplete(context: LinearIssueContext): boolean {
  return !Object.values(context.completeness).some(Boolean);
}
