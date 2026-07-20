import { createHash } from "node:crypto";
import { z } from "zod";
import type { LinearIssueContext } from "./linear/read.ts";

export const LinearReadinessConfigSchema = z
  .object({
    teamId: z.string().min(1),
    projectId: z.string().min(1),
    stateIds: z
      .object({
        backlog: z.string().min(1),
        open: z.string().min(1),
        inProgress: z.string().min(1),
        inReview: z.string().min(1),
        done: z.string().min(1),
        canceled: z.string().min(1),
        duplicate: z.string().min(1),
      })
      .strict(),
    nextActionLabelIds: z
      .object({
        plan: z.string().min(1),
        implement: z.string().min(1),
        needsInput: z.string().min(1),
      })
      .strict(),
    enabledRoutes: z
      .object({
        triage: z.boolean(),
        plan: z.boolean(),
        implement: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    requireUnique(Object.values(config.stateIds), ctx, ["stateIds"]);
    requireUnique(Object.values(config.nextActionLabelIds), ctx, ["nextActionLabelIds"]);
  });

export type LinearReadinessConfig = Readonly<z.infer<typeof LinearReadinessConfigSchema>>;
export type LinearReadinessRoute = "triage" | "plan" | "implement";

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
        reason: "projection-repair" | "needs-input" | "blocked";
      }>)
  | (ReadinessBase &
      Readonly<{
        kind: "ignore";
        reason: "out-of-scope" | "already-claimed" | "human-review" | "terminal";
      }>)
  | (ReadinessBase &
      Readonly<{
        kind: "invalid";
        reason:
          | "incomplete-context"
          | "missing-next-action"
          | "conflicting-next-action"
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

  const action = presentNextActions(context, config);
  const stateId = context.state.id;
  if (stateId === config.stateIds.backlog) {
    if (action.length > 0) return { ...base, kind: "wait", reason: "projection-repair" };
    return routeDecision("triage", config, snapshotGeneration);
  }
  if (stateId === config.stateIds.open) {
    if (action.length === 0) {
      return { ...base, kind: "invalid", reason: "missing-next-action" };
    }
    if (action.length > 1) {
      return { ...base, kind: "invalid", reason: "conflicting-next-action" };
    }
    if (action[0] === config.nextActionLabelIds.needsInput) {
      return { ...base, kind: "wait", reason: "needs-input" };
    }
    if (hasUnresolvedBlocker(context, config)) {
      return { ...base, kind: "wait", reason: "blocked" };
    }
    const route = action[0] === config.nextActionLabelIds.plan ? "plan" : "implement";
    return routeDecision(route, config, snapshotGeneration);
  }
  if (stateId === config.stateIds.inProgress) {
    return { ...base, kind: "ignore", reason: "already-claimed" };
  }
  if (stateId === config.stateIds.inReview) {
    return { ...base, kind: "ignore", reason: "human-review" };
  }
  if (terminalStateIds(config).has(stateId)) {
    return { ...base, kind: "ignore", reason: "terminal" };
  }
  return { ...base, kind: "invalid", reason: "unknown-state" };
}

export function linearReadinessSnapshotGeneration(
  context: LinearIssueContext,
  configInput: LinearReadinessConfig,
): string {
  const config = LinearReadinessConfigSchema.parse(configInput);
  const relevantLabelIds = presentNextActions(context, config).toSorted();
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
    nextActionLabelIds: relevantLabelIds,
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

function presentNextActions(context: LinearIssueContext, config: LinearReadinessConfig): string[] {
  const configured = new Set(Object.values(config.nextActionLabelIds));
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
