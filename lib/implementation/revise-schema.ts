import { z } from "zod";
import { AGENT_PROVIDERS } from "../agent/contract.ts";
import { PortableRelativePathSchema } from "../work-item/schema.ts";
import { ImplementationProofSchema } from "./schema.ts";

export const IMPLEMENTATION_REVISION_RESULT_SCHEMA_VERSION = "1";
export const IMPLEMENTATION_REVISION_MAX_FINDINGS = 24;
export const IMPLEMENTATION_REVISION_MAX_EVIDENCE = 8;

const DetailSchema = z.string().trim().min(1).max(4_000);
const SummarySchema = z.string().trim().min(1).max(2_000);
const QuestionSchema = z.string().trim().min(1).max(1_000);
const LineNumberSchema = z.number().int().positive().nullable();

export const ImplementationRevisionGitRevisionSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a full lowercase Git revision");

export const ImplementationRevisionAuthorSessionSchema = z
  .object({
    version: z.literal(1),
    provider: z.enum(AGENT_PROVIDERS),
    id: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const ImplementationReviewerSchema = z.enum(["implementation", "quality"]);

export const ImplementationReviewFindingIdSchema = z
  .string()
  .regex(
    /^implementation-review-finding-[0-9a-f]{64}$/,
    "must be a trusted implementation review finding ID",
  );

export const ImplementationReviewFindingContentSchema = z
  .object({
    title: z.string().min(1).max(500).regex(/\S/, "must contain non-whitespace content"),
    severity: z.enum(["Critical", "High", "Medium", "Low"]),
    location: z.string().min(1).max(1_000).regex(/\S/, "must contain non-whitespace content"),
    issue: z.string().min(1).max(4_000).regex(/\S/, "must contain non-whitespace content"),
    recommendation: z.string().min(1).max(4_000).regex(/\S/, "must contain non-whitespace content"),
    rationale: z.string().min(1).max(4_000).regex(/\S/, "must contain non-whitespace content"),
  })
  .strict();

export const ImplementationReviewFindingSchema = ImplementationReviewFindingContentSchema.extend({
  id: ImplementationReviewFindingIdSchema,
  reviewer: ImplementationReviewerSchema,
}).strict();

export const ImplementationRevisionReviewSchema = z
  .object({
    reviewedRevision: ImplementationRevisionGitRevisionSchema,
    findings: z
      .array(ImplementationReviewFindingSchema)
      .min(1)
      .max(IMPLEMENTATION_REVISION_MAX_FINDINGS),
  })
  .strict()
  .superRefine((review, ctx) => {
    const findingIds = review.findings.map((finding) => finding.id);
    if (new Set(findingIds).size !== findingIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "review findings must have unique IDs",
      });
    }
  });

export const ImplementationRevisionEvidenceSchema = z
  .object({
    source: z.enum(["selected-source", "code", "docs", "test", "repo-state"]),
    path: PortableRelativePathSchema.nullable(),
    lineStart: LineNumberSchema,
    lineEnd: LineNumberSchema,
    summary: SummarySchema,
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (
      (evidence.source === "code" || evidence.source === "docs" || evidence.source === "test") &&
      evidence.path === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: `${evidence.source} evidence requires a repository-relative path`,
      });
    }
    if (evidence.source === "repo-state" && evidence.path !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "repo-state evidence must use path: null",
      });
    }
    validateLineRange(evidence, ctx);
  });

export const ImplementationRevisionFindingResponseSchema = z
  .object({
    findingId: ImplementationReviewFindingIdSchema,
    disposition: z.enum(["accepted", "adapted", "declined"]),
    rationale: DetailSchema,
    evidence: z
      .array(ImplementationRevisionEvidenceSchema)
      .max(IMPLEMENTATION_REVISION_MAX_EVIDENCE),
  })
  .strict()
  .superRefine((response, ctx) => {
    if (
      (response.disposition === "adapted" || response.disposition === "declined") &&
      response.evidence.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: `${response.disposition} findings require evidence`,
      });
    }
  });

const DecisionFields = {
  rationale: DetailSchema,
  responses: z
    .array(ImplementationRevisionFindingResponseSchema)
    .min(1)
    .max(IMPLEMENTATION_REVISION_MAX_FINDINGS),
  proof: z.array(ImplementationProofSchema),
  remainingUncertainty: z.array(DetailSchema),
  questions: z.array(QuestionSchema).max(IMPLEMENTATION_REVISION_MAX_FINDINGS),
} as const;

const UpdatedDecisionSchema = z
  .object({
    outcome: z.literal("updated"),
    ...DecisionFields,
    proof: DecisionFields.proof.min(1),
    questions: DecisionFields.questions.length(0),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (
      !decision.responses.some(
        (response) => response.disposition === "accepted" || response.disposition === "adapted",
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["responses"],
        message: "updated requires at least one accepted or adapted finding",
      });
    }
    validateProofUncertainty(decision, ctx);
  });

const UnchangedDecisionSchema = z
  .object({
    outcome: z.literal("unchanged"),
    ...DecisionFields,
    proof: DecisionFields.proof.min(1),
    questions: DecisionFields.questions.length(0),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.responses.some((response) => response.disposition !== "declined")) {
      ctx.addIssue({
        code: "custom",
        path: ["responses"],
        message: "unchanged requires every finding to be declined",
      });
    }
    validateProofUncertainty(decision, ctx);
  });

const NeedsInputDecisionSchema = z
  .object({
    outcome: z.literal("needs-input"),
    ...DecisionFields,
    proof: DecisionFields.proof.length(0),
    remainingUncertainty: DecisionFields.remainingUncertainty.length(0),
    questions: DecisionFields.questions.min(1),
  })
  .strict()
  .superRefine((decision, ctx) => {
    for (const [index, response] of decision.responses.entries()) {
      if (response.evidence.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["responses", index, "evidence"],
          message: "needs-input finding responses require evidence",
        });
      }
    }
  });

export const ImplementationRevisionDecisionSchema = z.discriminatedUnion("outcome", [
  UpdatedDecisionSchema,
  UnchangedDecisionSchema,
  NeedsInputDecisionSchema,
]);

export type ImplementationRevisionAuthorSession = z.infer<
  typeof ImplementationRevisionAuthorSessionSchema
>;
export type ImplementationReviewer = z.infer<typeof ImplementationReviewerSchema>;
export type ImplementationReviewFindingContent = z.infer<
  typeof ImplementationReviewFindingContentSchema
>;
export type ImplementationReviewFinding = z.infer<typeof ImplementationReviewFindingSchema>;
export type ImplementationRevisionReview = z.infer<typeof ImplementationRevisionReviewSchema>;
export type ImplementationRevisionEvidence = z.infer<typeof ImplementationRevisionEvidenceSchema>;
export type ImplementationRevisionFindingResponse = z.infer<
  typeof ImplementationRevisionFindingResponseSchema
>;
export type ImplementationRevisionDecision = z.infer<typeof ImplementationRevisionDecisionSchema>;

function validateLineRange(
  value: { lineStart: number | null; lineEnd: number | null },
  ctx: z.RefinementCtx,
): void {
  if (value.lineStart === null && value.lineEnd !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["lineEnd"],
      message: "lineEnd requires lineStart",
    });
  }
  if (value.lineStart !== null && value.lineEnd !== null && value.lineEnd < value.lineStart) {
    ctx.addIssue({
      code: "custom",
      path: ["lineEnd"],
      message: "lineEnd must be greater than or equal to lineStart",
    });
  }
}

function validateProofUncertainty(
  decision: {
    proof: readonly { status: "passed" | "failed" | "skipped" }[];
    remainingUncertainty: readonly string[];
  },
  ctx: z.RefinementCtx,
): void {
  if (
    decision.proof.some((proof) => proof.status !== "passed") &&
    decision.remainingUncertainty.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["remainingUncertainty"],
      message: "failed or skipped proof requires at least one remaining uncertainty",
    });
  }
}
