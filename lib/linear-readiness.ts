import { createHash } from "node:crypto";
import { z } from "zod";
import type { LinearIssueContext } from "./linear/read.ts";

const LinearReadinessMappingShape = {
  teamId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  stateIds: z
    .object({
      backlog: z.string().trim().min(1),
      open: z.string().trim().min(1),
      inProgress: z.string().trim().min(1),
      needsInput: z.string().trim().min(1),
      needsReview: z.string().trim().min(1),
      done: z.string().trim().min(1),
      canceled: z.string().trim().min(1),
      duplicate: z.string().trim().min(1),
    })
    .strict(),
  agentActionLabelIds: z
    .object({
      spec: z.string().trim().min(1),
      implement: z.string().trim().min(1),
    })
    .strict(),
} as const;

export const LinearReadinessMappingSchema = z
  .object(LinearReadinessMappingShape)
  .strict()
  .superRefine(validateUniqueReadinessIds);

export const LinearReadinessConfigSchema = z
  .object({
    ...LinearReadinessMappingShape,
    enabledRoutes: z
      .object({
        triage: z.boolean(),
        spec: z.boolean(),
        implement: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine(validateUniqueReadinessIds);

export type LinearReadinessMapping = Readonly<z.infer<typeof LinearReadinessMappingSchema>>;
export type LinearReadinessConfig = Readonly<z.infer<typeof LinearReadinessConfigSchema>>;
export type LinearReadinessRoute = "triage" | "spec" | "implement";

type ReadinessBase = Readonly<{
  snapshotGeneration: string;
}>;

export type LinearReadinessDecision =
  | (ReadinessBase &
      Readonly<{
        kind: "dispatch";
        reason: "ready";
        route: LinearReadinessRoute;
      }>)
  | (ReadinessBase &
      Readonly<{
        kind: "wait";
        reason: "route-disabled";
        route: LinearReadinessRoute;
      }>)
  | (ReadinessBase &
      Readonly<{
        kind: "wait";
        reason: "projection-repair" | "blocked";
      }>)
  | (ReadinessBase &
      Readonly<{
        kind: "ignore";
        reason: "out-of-scope" | "already-claimed" | "needs-input" | "needs-review" | "terminal";
      }>)
  | (ReadinessBase &
      Readonly<{
        kind: "invalid";
        reason:
          | "incomplete-context"
          | "missing-agent-action"
          | "conflicting-agent-action"
          | "unknown-state";
      }>);

export function classifyLinearReadiness(input: {
  context: LinearIssueContext;
  config: LinearReadinessConfig;
}): LinearReadinessDecision {
  const config = LinearReadinessConfigSchema.parse(input.config);
  const { context } = input;
  const snapshotGeneration = linearReadinessSnapshotGeneration(context, config);
  const base = { snapshotGeneration };

  if (context.team.id !== config.teamId || context.project?.id !== config.projectId) {
    return { ...base, kind: "ignore", reason: "out-of-scope" };
  }
  if (context.completeness.labelsTruncated || context.completeness.relationsTruncated) {
    return { ...base, kind: "invalid", reason: "incomplete-context" };
  }

  const actions = presentAgentActions(context, config);
  const stateId = context.state.id;
  if (stateId === config.stateIds.backlog) {
    if (actions.length > 0) return { ...base, kind: "wait", reason: "projection-repair" };
    return routeDecision("triage", config, snapshotGeneration);
  }
  if (stateId === config.stateIds.open) {
    if (actions.length === 0) {
      return { ...base, kind: "invalid", reason: "missing-agent-action" };
    }
    if (actions.length > 1) {
      return { ...base, kind: "invalid", reason: "conflicting-agent-action" };
    }
    if (hasUnresolvedBlocker(context, config)) {
      return { ...base, kind: "wait", reason: "blocked" };
    }
    const route = actions[0] === config.agentActionLabelIds.spec ? "spec" : "implement";
    return routeDecision(route, config, snapshotGeneration);
  }
  if (stateId === config.stateIds.inProgress) {
    if (actions.length > 1) return { ...base, kind: "wait", reason: "projection-repair" };
    return { ...base, kind: "ignore", reason: "already-claimed" };
  }
  if (stateId === config.stateIds.needsInput) {
    if (actions.length > 0) return { ...base, kind: "wait", reason: "projection-repair" };
    return { ...base, kind: "ignore", reason: "needs-input" };
  }
  if (stateId === config.stateIds.needsReview) {
    if (actions.length > 0) return { ...base, kind: "wait", reason: "projection-repair" };
    return { ...base, kind: "ignore", reason: "needs-review" };
  }
  if (terminalStateIds(config).has(stateId)) {
    if (actions.length > 0) return { ...base, kind: "wait", reason: "projection-repair" };
    return { ...base, kind: "ignore", reason: "terminal" };
  }
  return { ...base, kind: "invalid", reason: "unknown-state" };
}

export function linearReadinessSnapshotGeneration(
  context: LinearIssueContext,
  configInput: LinearReadinessConfig,
): string {
  const config = LinearReadinessConfigSchema.parse(configInput);
  const relevantLabelIds = presentAgentActions(context, config).toSorted();
  const blockers = context.blockedBy
    .map((issue) => ({ issueId: issue.id, stateId: issue.state.id }))
    .toSorted((left, right) =>
      left.issueId === right.issueId
        ? left.stateId.localeCompare(right.stateId)
        : left.issueId.localeCompare(right.issueId),
    );
  const generation = {
    issueId: context.id,
    teamId: context.team.id,
    projectId: context.project?.id ?? null,
    stateId: context.state.id,
    updatedAt: context.updatedAt,
    agentActionLabelIds: relevantLabelIds,
    blockers,
    completeness: {
      labelsTruncated: context.completeness.labelsTruncated,
      relationsTruncated: context.completeness.relationsTruncated,
    },
  };
  return createHash("sha256").update(JSON.stringify(generation)).digest("hex");
}

function routeDecision(
  route: LinearReadinessRoute,
  config: LinearReadinessConfig,
  snapshotGeneration: string,
): LinearReadinessDecision {
  if (!config.enabledRoutes[route]) {
    return { kind: "wait", reason: "route-disabled", route, snapshotGeneration };
  }
  return { kind: "dispatch", reason: "ready", route, snapshotGeneration };
}

function presentAgentActions(context: LinearIssueContext, config: LinearReadinessConfig): string[] {
  const configured = new Set(Object.values(config.agentActionLabelIds));
  return [...new Set(context.labels.map((label) => label.id).filter((id) => configured.has(id)))];
}

function hasUnresolvedBlocker(context: LinearIssueContext, config: LinearReadinessConfig): boolean {
  const terminal = terminalStateIds(config);
  return context.blockedBy.some((issue) => !terminal.has(issue.state.id));
}

function terminalStateIds(config: LinearReadinessConfig): ReadonlySet<string> {
  return new Set([config.stateIds.done, config.stateIds.canceled, config.stateIds.duplicate]);
}

function requireUnique(values: string[], ctx: z.RefinementCtx, path: PropertyKey[]): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", path, message: "IDs must be unique" });
  }
}

function validateUniqueReadinessIds(
  config: z.infer<typeof LinearReadinessMappingSchema>,
  ctx: z.RefinementCtx,
): void {
  requireUnique(Object.values(config.stateIds), ctx, ["stateIds"]);
  requireUnique(Object.values(config.agentActionLabelIds), ctx, ["agentActionLabelIds"]);
}
