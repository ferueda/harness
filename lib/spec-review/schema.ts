import { z } from "zod";
import { SpecWorkItemContextSchema } from "../spec/schema.ts";
import { PortableRelativePathSchema } from "../work-item/schema.ts";

export const SPEC_REVIEW_RESULT_SCHEMA_VERSION = "1";
export const SPEC_REVIEW_MAX_FINDINGS = 12;
export const SPEC_REVIEW_MAX_CITATIONS = 8;

const SummarySchema = z.string().min(1).max(2_000);
const DetailSchema = z.string().min(1).max(4_000);
const LineNumberSchema = z.number().int().positive().nullable();
const GitRevisionSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a full lowercase Git revision");

export const SpecReviewArtifactSchema = z
  .object({
    path: PortableRelativePathSchema,
    revision: GitRevisionSchema,
  })
  .strict();

export const SpecReviewCitationSourceSchema = z.enum([
  "work-item",
  "artifact",
  "code",
  "docs",
  "test",
  "repo-state",
]);

export const SpecReviewCriterionSchema = z.enum([
  "project-intent",
  "requirements",
  "code-reality",
  "scope",
  "architecture",
  "delivery-shape",
  "verification",
  "risk",
  "simplicity",
]);

export const SpecReviewCitationSchema = z
  .object({
    source: SpecReviewCitationSourceSchema,
    path: PortableRelativePathSchema.nullable(),
    lineStart: LineNumberSchema,
    lineEnd: LineNumberSchema,
    summary: SummarySchema,
  })
  .strict()
  .superRefine((citation, ctx) => {
    if (citation.source === "work-item" && citation.path !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "work-item citations must use path: null",
      });
    }

    if (
      (citation.source === "artifact" ||
        citation.source === "code" ||
        citation.source === "docs" ||
        citation.source === "test") &&
      citation.path === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: `${citation.source} citations require a repository-relative path`,
      });
    }

    validateLineRange(citation, ctx);
  });

export const SpecReviewArtifactLocationSchema = z
  .object({
    section: z.string().min(1).max(200),
    lineStart: LineNumberSchema,
    lineEnd: LineNumberSchema,
  })
  .strict()
  .superRefine(validateLineRange);

export const SpecReviewFindingDraftSchema = z
  .object({
    criterion: SpecReviewCriterionSchema,
    artifactLocation: SpecReviewArtifactLocationSchema,
    evidence: z.array(SpecReviewCitationSchema).min(1).max(SPEC_REVIEW_MAX_CITATIONS),
    problem: DetailSchema,
    requiredOutcome: DetailSchema,
  })
  .strict();

export const SpecReviewDecisionDraftSchema = z
  .object({
    outcome: z.enum(["approved", "changes-requested"]),
    rationale: DetailSchema,
    evidence: z.array(SpecReviewCitationSchema).max(SPEC_REVIEW_MAX_CITATIONS),
    findings: z.array(SpecReviewFindingDraftSchema).max(SPEC_REVIEW_MAX_FINDINGS),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.outcome === "approved") {
      if (decision.evidence.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "approved requires at least one evidence citation",
        });
      }
      if (decision.findings.length !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["findings"],
          message: "approved requires zero findings",
        });
      }
      return;
    }

    if (decision.evidence.length !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "changes-requested keeps top-level evidence empty",
      });
    }
    if (decision.findings.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "changes-requested requires at least one finding",
      });
    }
  });

const SpecReviewFindingIdSchema = z
  .string()
  .regex(/^spec-review-finding-[0-9a-f]{64}$/, "must be a trusted Spec review finding ID");

export const SpecReviewFindingSchema = SpecReviewFindingDraftSchema.extend({
  id: SpecReviewFindingIdSchema,
}).strict();

const ApprovedSpecReviewDecisionSchema = z
  .object({
    outcome: z.literal("approved"),
    rationale: DetailSchema,
    evidence: z.array(SpecReviewCitationSchema).min(1).max(SPEC_REVIEW_MAX_CITATIONS),
    findings: z.array(SpecReviewFindingSchema).length(0),
  })
  .strict();

const ChangesRequestedSpecReviewDecisionSchema = z
  .object({
    outcome: z.literal("changes-requested"),
    rationale: DetailSchema,
    findings: z.array(SpecReviewFindingSchema).min(1).max(SPEC_REVIEW_MAX_FINDINGS),
  })
  .strict();

export const SpecReviewDecisionSchema = z.discriminatedUnion("outcome", [
  ApprovedSpecReviewDecisionSchema,
  ChangesRequestedSpecReviewDecisionSchema,
]);

export { SpecWorkItemContextSchema as SpecReviewWorkItemContextSchema };

export type SpecReviewArtifact = z.infer<typeof SpecReviewArtifactSchema>;
export type SpecReviewCitationSource = z.infer<typeof SpecReviewCitationSourceSchema>;
export type SpecReviewCriterion = z.infer<typeof SpecReviewCriterionSchema>;
export type SpecReviewCitation = z.infer<typeof SpecReviewCitationSchema>;
export type SpecReviewArtifactLocation = z.infer<typeof SpecReviewArtifactLocationSchema>;
export type SpecReviewFindingDraft = z.infer<typeof SpecReviewFindingDraftSchema>;
export type SpecReviewDecisionDraft = z.infer<typeof SpecReviewDecisionDraftSchema>;
export type SpecReviewFinding = z.infer<typeof SpecReviewFindingSchema>;
export type SpecReviewDecision = z.infer<typeof SpecReviewDecisionSchema>;
export type SpecReviewWorkItemContext = z.infer<typeof SpecWorkItemContextSchema>;

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
