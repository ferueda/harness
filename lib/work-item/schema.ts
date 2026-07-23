import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const PortableRelativePathSchema = NonEmptyStringSchema.superRefine((value, ctx) => {
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

export const WorkItemCommentSchema = z
  .object({
    author: NonEmptyStringSchema.nullable(),
    body: NonEmptyStringSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const WorkItemLinkSchema = z
  .object({
    title: NonEmptyStringSchema,
    url: z.url(),
  })
  .strict();

export const WorkItemEvidenceSchema = z
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

export function createWorkItemContextSchemas(referenceSchema: z.ZodType<string>) {
  const reference = z
    .object({
      id: NonEmptyStringSchema,
      reference: referenceSchema,
      title: NonEmptyStringSchema,
      url: z.url().nullable(),
      state: NonEmptyStringSchema,
    })
    .strict();

  const context = z
    .object({
      id: NonEmptyStringSchema,
      reference: referenceSchema,
      title: NonEmptyStringSchema,
      description: NonEmptyStringSchema.nullable(),
      url: z.url().nullable(),
      state: NonEmptyStringSchema,
      labels: z.array(NonEmptyStringSchema),
      comments: z.array(WorkItemCommentSchema),
      parent: reference.nullable(),
      children: z.array(reference),
      duplicateOf: reference.nullable(),
      blockedBy: z.array(reference),
      related: z.array(reference),
      links: z.array(WorkItemLinkSchema),
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

  return { reference, context } as const;
}
