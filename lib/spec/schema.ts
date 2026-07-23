import { z } from "zod";

export const SPEC_RESULT_SCHEMA_VERSION = "1";

const NonEmptyStringSchema = z.string().min(1);

const PortableRelativePathSchema = NonEmptyStringSchema.superRefine((value, ctx) => {
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith("//") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    ctx.addIssue({ code: "custom", message: "must be a portable repository-relative path" });
  }
});

export const SpecIssueReferenceSchema = NonEmptyStringSchema.regex(
  /^[A-Z][A-Z0-9]*-\d+$/,
  "must be an uppercase issue reference such as FER-273",
);

export const SpecWorkItemReferenceSchema = z
  .object({
    id: NonEmptyStringSchema,
    reference: SpecIssueReferenceSchema,
    title: NonEmptyStringSchema,
    url: z.url().nullable(),
    state: NonEmptyStringSchema,
  })
  .strict();

export const SpecCommentSchema = z
  .object({
    author: NonEmptyStringSchema.nullable(),
    body: NonEmptyStringSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const SpecLinkSchema = z
  .object({
    title: NonEmptyStringSchema,
    url: z.url(),
  })
  .strict();

export const SpecWorkItemContextSchema = z
  .object({
    id: NonEmptyStringSchema,
    reference: SpecIssueReferenceSchema,
    title: NonEmptyStringSchema,
    description: NonEmptyStringSchema.nullable(),
    url: z.url().nullable(),
    state: NonEmptyStringSchema,
    labels: z.array(NonEmptyStringSchema),
    comments: z.array(SpecCommentSchema),
    parent: SpecWorkItemReferenceSchema.nullable(),
    children: z.array(SpecWorkItemReferenceSchema),
    duplicateOf: SpecWorkItemReferenceSchema.nullable(),
    blockedBy: z.array(SpecWorkItemReferenceSchema),
    related: z.array(SpecWorkItemReferenceSchema),
    links: z.array(SpecLinkSchema),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completeness: z
      .object({
        commentsTruncated: z.boolean(),
        labelsTruncated: z.boolean(),
        relationsTruncated: z.boolean(),
        linksTruncated: z.boolean(),
        childrenTruncated: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const SpecEvidenceSchema = z
  .object({
    kind: z.enum(["tracker", "code", "docs", "test", "repo-state"]),
    path: PortableRelativePathSchema.nullable(),
    summary: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.kind === "tracker" && evidence.path !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "tracker evidence must use path: null",
      });
    }

    if (
      (evidence.kind === "code" || evidence.kind === "docs" || evidence.kind === "test") &&
      evidence.path === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: `${evidence.kind} evidence requires a repository-relative path`,
      });
    }
  });

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
