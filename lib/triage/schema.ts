import { z } from "zod";

export const TRIAGE_DECISION_SCHEMA_VERSION = "1";

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

export const TriageWorkItemReferenceSchema = z
  .object({
    id: NonEmptyStringSchema,
    reference: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    url: z.url().nullable(),
    state: NonEmptyStringSchema,
  })
  .strict();

export const TriageCommentSchema = z
  .object({
    author: NonEmptyStringSchema.nullable(),
    body: NonEmptyStringSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const TriageLinkSchema = z
  .object({
    title: NonEmptyStringSchema,
    url: z.url(),
  })
  .strict();

export const TriageWorkItemContextSchema = z
  .object({
    id: NonEmptyStringSchema,
    reference: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    description: NonEmptyStringSchema.nullable(),
    url: z.url().nullable(),
    state: NonEmptyStringSchema,
    labels: z.array(NonEmptyStringSchema),
    comments: z.array(TriageCommentSchema),
    parent: TriageWorkItemReferenceSchema.nullable(),
    children: z.array(TriageWorkItemReferenceSchema),
    duplicateOf: TriageWorkItemReferenceSchema.nullable(),
    blockedBy: z.array(TriageWorkItemReferenceSchema),
    related: z.array(TriageWorkItemReferenceSchema),
    links: z.array(TriageLinkSchema),
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

export const TriageEvidenceSchema = z
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

export const TriageDecisionSchema = z
  .object({
    decision: z.enum(["ready-for-agent", "needs-input", "duplicate"]),
    scope: z.enum(["bounded", "too-broad"]),
    agentAction: z.enum(["implement", "plan"]).nullable(),
    summary: NonEmptyStringSchema,
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
        "ready-for-agent requires implement or plan",
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
