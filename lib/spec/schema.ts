import { z } from "zod";
import {
  createWorkItemContextSchemas,
  PortableRelativePathSchema,
  WorkItemCommentSchema,
  WorkItemEvidenceSchema,
  WorkItemLinkSchema,
} from "../work-item/schema.ts";

export const SPEC_RESULT_SCHEMA_VERSION = "1";

const NonEmptyStringSchema = z.string().min(1);

export const SpecIssueReferenceSchema = NonEmptyStringSchema.regex(
  /^[A-Z][A-Z0-9]*-\d+$/,
  "must be an uppercase issue reference such as FER-273",
);

const SpecWorkItemSchemas = createWorkItemContextSchemas(SpecIssueReferenceSchema);

export const SpecWorkItemReferenceSchema = SpecWorkItemSchemas.reference;
export const SpecCommentSchema = WorkItemCommentSchema;
export const SpecLinkSchema = WorkItemLinkSchema;
export const SpecWorkItemContextSchema = SpecWorkItemSchemas.context;
export const SpecEvidenceSchema = WorkItemEvidenceSchema;

export const SpecReviewerOptionSchema = z
  .object({
    option: NonEmptyStringSchema,
    tradeoffs: NonEmptyStringSchema,
  })
  .strict();

export const SpecReviewerDecisionSchema = z
  .object({
    question: NonEmptyStringSchema,
    options: z.array(SpecReviewerOptionSchema).min(2),
    recommendation: NonEmptyStringSchema,
    rationale: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((decision, ctx) => {
    const optionNames = decision.options.map((option) => option.option);
    if (new Set(optionNames).size !== optionNames.length) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "reviewer decision options must be unique",
      });
    }
    if (!optionNames.includes(decision.recommendation)) {
      ctx.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "recommendation must exactly match one option",
      });
    }
  });

const SpecDecisionSharedShape = {
  summary: NonEmptyStringSchema,
  evidence: z.array(SpecEvidenceSchema).min(1),
};

const ReadyForReviewDecisionSchema = z
  .object({
    outcome: z.literal("ready-for-review"),
    artifactPath: PortableRelativePathSchema,
    ...SpecDecisionSharedShape,
    reviewerDecisions: z.array(SpecReviewerDecisionSchema),
    questions: z.array(NonEmptyStringSchema).length(0),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.evidence.every((evidence) => evidence.kind === "tracker")) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "ready-for-review requires repository evidence",
      });
    }
  });

const NeedsInputDecisionSchema = z
  .object({
    outcome: z.literal("needs-input"),
    artifactPath: z.null(),
    ...SpecDecisionSharedShape,
    reviewerDecisions: z.array(SpecReviewerDecisionSchema).length(0),
    questions: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();

export const SpecDecisionSchema = z.discriminatedUnion("outcome", [
  ReadyForReviewDecisionSchema,
  NeedsInputDecisionSchema,
]);

export type SpecWorkItemReference = z.infer<typeof SpecWorkItemReferenceSchema>;
export type SpecComment = z.infer<typeof SpecCommentSchema>;
export type SpecLink = z.infer<typeof SpecLinkSchema>;
export type SpecWorkItemContext = z.infer<typeof SpecWorkItemContextSchema>;
export type SpecEvidence = z.infer<typeof SpecEvidenceSchema>;
export type SpecReviewerOption = z.infer<typeof SpecReviewerOptionSchema>;
export type SpecReviewerDecision = z.infer<typeof SpecReviewerDecisionSchema>;
export type SpecDecision = z.infer<typeof SpecDecisionSchema>;
