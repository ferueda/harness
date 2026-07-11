import { z } from "zod";
import { formatZodError } from "./schemas.ts";

export const FACTORY_WORK_ITEM_SOURCES = ["file", "github", "linear", "jira", "manual"] as const;
export const FACTORY_ROUTES = [
  "ready-to-implement",
  "ready-to-plan",
  "needs-info",
  "wait-to-implement",
] as const;
export const FACTORY_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export const FACTORY_EVIDENCE_KINDS = ["tracker", "code", "docs", "test", "repo-state"] as const;
export const FACTORY_NEXT_ACTIONS = [
  "implement-directly",
  "create-plan",
  "ask-human",
  "park",
] as const;
export const FACTORY_STAGES = [
  "incoming",
  "triaging",
  "ready-to-implement",
  "ready-to-plan",
  "needs-info",
  "wait-to-implement",
  "planning",
  "plan-pr-open",
  "plan-reviewing",
  "plan-needs-revision",
  "plan-approved",
  "plan-needs-human",
  "plan-review-unresolved",
  "planning-failed",
  "implementation-started",
  "implementation-complete",
  "implementation-failed",
  "review-running",
  "review-failed",
  "review-complete",
  "ready-for-human",
] as const;

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export class FactoryTriageError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryTriageError";
  }
}

export const FactoryWorkItemSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(FACTORY_WORK_ITEM_SOURCES),
    title: z.string().min(1),
    body: z.string(),
    url: z.url().optional(),
    labels: z.array(z.string()).default([]),
    metadata: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

export const FactoryTrackerRefSchema = z
  .object({
    source: z.enum(FACTORY_WORK_ITEM_SOURCES),
    id: z.string().min(1),
    url: z.url().optional(),
  })
  .strict();

export const FactoryRouteSchema = z.enum(FACTORY_ROUTES);
export const FactoryNextActionSchema = z.enum(FACTORY_NEXT_ACTIONS);
export const FactoryStageSchema = z.enum(FACTORY_STAGES);

export const FactoryWorkItemMetadataSchema = z
  .object({
    tracker: FactoryTrackerRefSchema.optional(),
    factoryRoute: FactoryRouteSchema.optional(),
    factoryNextAction: FactoryNextActionSchema.optional(),
    factoryStage: FactoryStageSchema.optional(),
    factoryRunId: z.string().min(1).optional(),
    approvedPlanPath: z.string().min(1).optional(),
    approvedPlanPrUrl: z.url().optional(),
    approvedPlanCommit: z.string().min(1).optional(),
  })
  .catchall(JsonValueSchema);

export const FactoryTriageOutputSchema = z
  .object({
    route: FactoryRouteSchema,
    confidence: z.enum(FACTORY_CONFIDENCE_LEVELS),
    rationale: z.string().min(1),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(FACTORY_EVIDENCE_KINDS),
            path: z.string().min(1).nullable(),
            summary: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    questions: z.array(z.string().min(1)),
    reconsiderWhen: z.string().min(1).nullable(),
    suggestedNext: z
      .object({
        action: z.enum(FACTORY_NEXT_ACTIONS),
        command: z.string().min(1).nullable(),
        artifact: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((output, ctx) => {
    if (output.route === "ready-to-implement") {
      requireAction(output, ctx, "implement-directly");
      if (output.questions.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["questions"],
          message: "ready-to-implement must use questions: []",
        });
      }
    }

    if (output.route === "ready-to-plan") {
      requireAction(output, ctx, "create-plan");
    }

    if (output.route === "needs-info") {
      requireAction(output, ctx, "ask-human");
      if (output.questions.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["questions"],
          message: "needs-info requires at least one question",
        });
      }
    }

    if (output.route === "wait-to-implement") {
      requireAction(output, ctx, "park");
      if (output.reconsiderWhen === null) {
        ctx.addIssue({
          code: "custom",
          path: ["reconsiderWhen"],
          message: "wait-to-implement requires reconsiderWhen",
        });
      }
    }
  });

export const FactoryRoutePlanSchema = z
  .object({
    route: FactoryRouteSchema,
    nextAction: z.enum(FACTORY_NEXT_ACTIONS),
    statusLabel: z.string().min(1),
    artifactRelPath: z.string().min(1),
    humanSummary: z.string().min(1),
    command: z.string().optional(),
  })
  .strict();

export type FactoryWorkItem = z.infer<typeof FactoryWorkItemSchema>;
export type FactoryRoute = z.infer<typeof FactoryRouteSchema>;
export type FactoryNextAction = z.infer<typeof FactoryNextActionSchema>;
export type FactoryStage = z.infer<typeof FactoryStageSchema>;
export type FactoryTrackerRef = z.infer<typeof FactoryTrackerRefSchema>;
export type FactoryWorkItemMetadata = z.infer<typeof FactoryWorkItemMetadataSchema>;
export type FactoryTriageOutput = z.infer<typeof FactoryTriageOutputSchema>;
export type FactoryRoutePlan = z.infer<typeof FactoryRoutePlanSchema>;

export function parseFactoryWorkItem(value: unknown): FactoryWorkItem {
  const result = FactoryWorkItemSchema.safeParse(value);
  if (result.success) return result.data;
  throw new FactoryTriageError(`Invalid factory work item: ${formatZodError(result.error)}`, {
    cause: result.error,
  });
}

export function parseFactoryTriageOutput(value: unknown): FactoryTriageOutput {
  const result = FactoryTriageOutputSchema.safeParse(value);
  if (result.success) return result.data;
  throw new FactoryTriageError(`Invalid factory triage output: ${formatZodError(result.error)}`, {
    cause: result.error,
  });
}

export function parseFactoryWorkItemMetadata(value: unknown): FactoryWorkItemMetadata {
  const result = FactoryWorkItemMetadataSchema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new FactoryTriageError(
    `Invalid factory work item metadata: ${formatZodError(result.error)}`,
    {
      cause: result.error,
    },
  );
}

export function deriveFactoryWorkItemPlanSlug(workItem: FactoryWorkItem): string {
  return workItem.title || workItem.id;
}

function requireAction(
  output: FactoryTriageOutput,
  ctx: z.RefinementCtx,
  expected: FactoryTriageOutput["suggestedNext"]["action"],
): void {
  if (output.suggestedNext.action === expected) return;
  ctx.addIssue({
    code: "custom",
    path: ["suggestedNext", "action"],
    message: `${output.route} requires suggestedNext.action=${expected}`,
  });
}
