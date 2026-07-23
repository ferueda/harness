import { z } from "zod";
import {
  createWorkItemContextSchemas,
  WorkItemCommentSchema,
  WorkItemEvidenceSchema,
  WorkItemLinkSchema,
} from "../work-item/schema.ts";

export const TRIAGE_DECISION_SCHEMA_VERSION = "3";

const NonEmptyStringSchema = z.string().min(1);

const TriageWorkItemSchemas = createWorkItemContextSchemas(NonEmptyStringSchema);

export const TriageWorkItemReferenceSchema = TriageWorkItemSchemas.reference;
export const TriageCommentSchema = WorkItemCommentSchema;
export const TriageLinkSchema = WorkItemLinkSchema;
export const TriageWorkItemContextSchema = TriageWorkItemSchemas.context;
export const TriageEvidenceSchema = WorkItemEvidenceSchema;

export const TriageDecisionSchema = z
  .object({
    decision: z.enum(["ready-for-agent", "needs-input", "duplicate"]),
    scope: z.enum(["bounded", "too-broad"]),
    agentAction: z.enum(["implement", "spec"]).nullable(),
    rationale: NonEmptyStringSchema,
    evidence: z.array(TriageEvidenceSchema).min(1),
    questions: z.array(NonEmptyStringSchema),
    inputReason: z
      .enum(["rescope", "clarification", "product-decision", "access", "external-fact"])
      .nullable(),
    duplicateOf: NonEmptyStringSchema.nullable(),
    blockedBy: z.array(NonEmptyStringSchema),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.decision === "ready-for-agent") {
      requireValue(result.scope === "bounded", ctx, ["scope"], "ready-for-agent requires bounded");
      requireValue(
        result.agentAction !== null,
        ctx,
        ["agentAction"],
        "ready-for-agent requires implement or spec",
      );
      requireEmpty(result.questions, ctx, ["questions"], "ready-for-agent must use questions: []");
      requireValue(
        result.inputReason === null,
        ctx,
        ["inputReason"],
        "ready-for-agent must use inputReason: null",
      );
      requireValue(
        result.duplicateOf === null,
        ctx,
        ["duplicateOf"],
        "ready-for-agent must use duplicateOf: null",
      );
      return;
    }

    if (result.decision === "duplicate") {
      requireValue(result.scope === "bounded", ctx, ["scope"], "duplicate requires bounded");
      requireValue(
        result.agentAction === null,
        ctx,
        ["agentAction"],
        "duplicate must use agentAction: null",
      );
      requireEmpty(result.questions, ctx, ["questions"], "duplicate must use questions: []");
      requireValue(
        result.inputReason === null,
        ctx,
        ["inputReason"],
        "duplicate must use inputReason: null",
      );
      requireValue(
        result.duplicateOf !== null,
        ctx,
        ["duplicateOf"],
        "duplicate requires duplicateOf",
      );
      return;
    }

    requireValue(
      result.agentAction === null,
      ctx,
      ["agentAction"],
      "needs-input must use agentAction: null",
    );
    requireValue(
      result.questions.length > 0,
      ctx,
      ["questions"],
      "needs-input requires at least one question",
    );
    requireValue(
      result.inputReason !== null,
      ctx,
      ["inputReason"],
      "needs-input requires inputReason",
    );
    requireValue(
      result.duplicateOf === null,
      ctx,
      ["duplicateOf"],
      "needs-input must use duplicateOf: null",
    );

    if (result.scope === "too-broad") {
      requireValue(
        result.inputReason === "rescope",
        ctx,
        ["inputReason"],
        "too-broad requires inputReason: rescope",
      );
      requireValue(
        result.questions.length === 1,
        ctx,
        ["questions"],
        "too-broad requires exactly one scope question",
      );
    } else {
      requireValue(
        result.inputReason !== "rescope",
        ctx,
        ["inputReason"],
        "bounded needs-input cannot use inputReason: rescope",
      );
    }
  });

export type TriageWorkItemReference = z.infer<typeof TriageWorkItemReferenceSchema>;
export type TriageComment = z.infer<typeof TriageCommentSchema>;
export type TriageLink = z.infer<typeof TriageLinkSchema>;
export type TriageWorkItemContext = z.infer<typeof TriageWorkItemContextSchema>;
export type TriageEvidence = z.infer<typeof TriageEvidenceSchema>;
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;

function requireValue(
  condition: boolean,
  ctx: z.RefinementCtx<z.output<typeof TriageDecisionSchema>>,
  path: PropertyKey[],
  message: string,
): void {
  if (!condition) ctx.addIssue({ code: "custom", path, message });
}

function requireEmpty(
  values: readonly unknown[],
  ctx: z.RefinementCtx<z.output<typeof TriageDecisionSchema>>,
  path: PropertyKey[],
  message: string,
): void {
  requireValue(values.length === 0, ctx, path, message);
}
