import { z } from "zod";
import { AGENT_PROVIDERS } from "../agent/contract.ts";
import {
  SPEC_REVIEW_MAX_CITATIONS,
  SPEC_REVIEW_MAX_FINDINGS,
  SpecReviewArtifactSchema,
  SpecReviewCitationSchema,
  SpecReviewFindingSchema,
} from "../spec-review/schema.ts";

export const SPEC_REVISION_RESULT_SCHEMA_VERSION = "1";

const DetailSchema = z.string().trim().min(1).max(4_000);
const QuestionSchema = z.string().trim().min(1).max(1_000);

export const SpecRevisionAuthorSessionSchema = z
  .object({
    version: z.literal(1),
    provider: z.enum(AGENT_PROVIDERS),
    id: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const SpecRevisionReviewSchema = z
  .object({
    reviewedRevision: SpecReviewArtifactSchema.shape.revision,
    rubricVersion: z.string().trim().min(1).max(100),
    findings: z.array(SpecReviewFindingSchema).min(1).max(SPEC_REVIEW_MAX_FINDINGS),
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

export const SpecRevisionFindingResponseSchema = z
  .object({
    findingId: SpecReviewFindingSchema.shape.id,
    disposition: z.enum(["accepted", "adapted", "declined"]),
    rationale: DetailSchema,
    evidence: z.array(SpecReviewCitationSchema).max(SPEC_REVIEW_MAX_CITATIONS),
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

export const SpecRevisionDecisionDraftSchema = z
  .object({
    outcome: z.enum(["updated", "unchanged", "needs-input"]),
    rationale: DetailSchema,
    responses: z.array(SpecRevisionFindingResponseSchema).min(1).max(SPEC_REVIEW_MAX_FINDINGS),
    questions: z.array(QuestionSchema).max(SPEC_REVIEW_MAX_FINDINGS),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.outcome === "updated") {
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
      requireNoQuestions(decision.questions, ctx);
      return;
    }

    if (decision.outcome === "unchanged") {
      if (decision.responses.some((response) => response.disposition !== "declined")) {
        ctx.addIssue({
          code: "custom",
          path: ["responses"],
          message: "unchanged requires every finding to be declined",
        });
      }
      requireNoQuestions(decision.questions, ctx);
      return;
    }

    if (decision.questions.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "needs-input requires at least one focused question",
      });
    }
    for (const [index, response] of decision.responses.entries()) {
      if (response.disposition === "accepted" && response.evidence.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["responses", index, "evidence"],
          message: "needs-input accepted findings require evidence while the artifact is unchanged",
        });
      }
    }
  });

function requireNoQuestions(questions: readonly string[], ctx: z.RefinementCtx): void {
  if (questions.length === 0) return;
  ctx.addIssue({
    code: "custom",
    path: ["questions"],
    message: "updated and unchanged require no questions",
  });
}

export type SpecRevisionAuthorSession = z.infer<typeof SpecRevisionAuthorSessionSchema>;
export type SpecRevisionReview = z.infer<typeof SpecRevisionReviewSchema>;
export type SpecRevisionFindingResponse = z.infer<typeof SpecRevisionFindingResponseSchema>;
export type SpecRevisionDecision = z.infer<typeof SpecRevisionDecisionDraftSchema>;
