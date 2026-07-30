import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { errorMessage } from "../agent/invocation.ts";
import {
  PortableRelativePathSchema,
  WorkItemContextSchema,
  type WorkItemContext,
} from "../work-item/schema.ts";

const NonEmptyStringSchema = z.string().min(1);

export const ImplementationIssueReferenceSchema = NonEmptyStringSchema.regex(
  /^[A-Z][A-Z0-9]*-\d+$/,
  "must be an uppercase issue reference such as FER-323",
);

export const CompleteImplementationWorkItemSchema = WorkItemContextSchema.superRefine(
  (workItem, ctx) => {
    if (!ImplementationIssueReferenceSchema.safeParse(workItem.reference).success) {
      ctx.addIssue({
        code: "custom",
        path: ["reference"],
        message: "must be an uppercase issue reference such as FER-323",
      });
    }
    for (const [key, truncated] of Object.entries(workItem.completeness)) {
      if (!truncated) continue;
      ctx.addIssue({
        code: "custom",
        path: ["completeness", key],
        message: "implementation requires complete normalized work-item context",
      });
    }
  },
);

export const ImplementationPlanSourceSchema = z
  .object({
    kind: z.literal("plan"),
    issueReference: ImplementationIssueReferenceSchema,
    path: PortableRelativePathSchema,
  })
  .strict()
  .superRefine((source, ctx) => {
    if (!ImplementationIssueReferenceSchema.safeParse(source.issueReference).success) return;
    if (source.path === implementationPlanPath(source.issueReference)) return;
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message: `must be the canonical plan path for ${source.issueReference}`,
    });
  });

export const ImplementationLinearSourceSchema = z
  .object({
    kind: z.literal("linear"),
    workItem: CompleteImplementationWorkItemSchema,
  })
  .strict();

export const ImplementationSourceSchema = z.discriminatedUnion("kind", [
  ImplementationPlanSourceSchema,
  ImplementationLinearSourceSchema,
]);

export type ImplementationPlanSource = z.infer<typeof ImplementationPlanSourceSchema>;
export type ImplementationLinearSource = z.infer<typeof ImplementationLinearSourceSchema>;
export type ImplementationSource = z.infer<typeof ImplementationSourceSchema>;

export type ImplementationPlanSourceAuthority = Readonly<{
  source: ImplementationPlanSource;
  issueReference: string;
  sourceSha256: string;
  planContent: string;
}>;

export type ImplementationLinearSourceAuthority = Readonly<{
  source: ImplementationLinearSource;
  issueReference: string;
  sourceSha256: string;
}>;

export type ImplementationSourceAuthority =
  | ImplementationPlanSourceAuthority
  | ImplementationLinearSourceAuthority;

export type ImplementationSourceResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: string }>;

export function implementationPlanPath(reference: string): `dev/plans/${string}.md` {
  return `dev/plans/${ImplementationIssueReferenceSchema.parse(reference)}.md`;
}

export function resolveImplementationSource(input: {
  workspace: string;
  workItem: WorkItemContext;
}): ImplementationSourceResult<ImplementationSource> {
  const workItem = CompleteImplementationWorkItemSchema.safeParse(input.workItem);
  if (!workItem.success) {
    return {
      ok: false,
      error: `Invalid implementation work-item context: ${formatZodError(workItem.error.issues)}`,
    };
  }

  const path = implementationPlanPath(workItem.data.reference);
  const root = inspectWorkspace(input.workspace);
  if (!root.ok) return root;

  try {
    lstatSync(resolve(root.value, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false,
        error: `Invalid implementation source ${path}: ${errorMessage(error)}`,
      };
    }
    return {
      ok: true,
      value: {
        kind: "linear",
        workItem: workItem.data,
      },
    };
  }

  const source = {
    kind: "plan",
    issueReference: workItem.data.reference,
    path,
  } as const;
  const inspected = inspectImplementationSource({
    workspace: input.workspace,
    source,
  });
  if (!inspected.ok) return inspected;
  return { ok: true, value: inspected.value.source };
}

export function inspectImplementationSource(input: {
  workspace: string;
  source: ImplementationSource;
}): ImplementationSourceResult<ImplementationSourceAuthority> {
  const source = ImplementationSourceSchema.safeParse(input.source);
  if (!source.success) {
    return {
      ok: false,
      error: `Invalid implementation source: ${formatZodError(source.error.issues)}`,
    };
  }

  if (source.data.kind === "linear") {
    return {
      ok: true,
      value: Object.freeze({
        source: source.data,
        issueReference: source.data.workItem.reference,
        sourceSha256: sha256(JSON.stringify(source.data.workItem)),
      }),
    };
  }

  const root = inspectWorkspace(input.workspace);
  if (!root.ok) return root;
  return inspectPlanSource(root.value, source.data);
}

export function verifyImplementationSource(
  workspace: string,
  authority: ImplementationSourceAuthority,
): ImplementationSourceResult<ImplementationSourceAuthority> {
  if (authority.source.kind === "linear") return { ok: true, value: authority };

  const current = inspectImplementationSource({
    workspace,
    source: authority.source,
  });
  if (!current.ok) {
    return {
      ok: false,
      error: `Selected implementation plan changed: ${current.error}`,
    };
  }
  if (current.value.sourceSha256 !== authority.sourceSha256) {
    return {
      ok: false,
      error: `Selected implementation plan changed: ${authority.source.path} content no longer matches its initial snapshot.`,
    };
  }
  return current;
}

function inspectPlanSource(
  workspaceRoot: string,
  source: ImplementationPlanSource,
): ImplementationSourceResult<ImplementationSourceAuthority> {
  try {
    const candidate = resolve(workspaceRoot, source.path);
    if (escapesWorkspace(workspaceRoot, candidate)) {
      return {
        ok: false,
        error: `Invalid implementation source: ${source.path} resolves outside the supplied workspace.`,
      };
    }

    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        ok: false,
        error: `Invalid implementation source: ${source.path} must be a regular file.`,
      };
    }

    const realCandidate = realpathSync(candidate);
    if (escapesWorkspace(workspaceRoot, realCandidate)) {
      return {
        ok: false,
        error: `Invalid implementation source: ${source.path} resolves outside the supplied workspace.`,
      };
    }

    const planContent = readFileSync(realCandidate, "utf8");
    if (planContent.trim() === "") {
      return {
        ok: false,
        error: `Invalid implementation source: ${source.path} is empty.`,
      };
    }

    return {
      ok: true,
      value: Object.freeze({
        source,
        issueReference: source.issueReference,
        sourceSha256: sha256(planContent),
        planContent,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid implementation source ${source.path}: ${errorMessage(error)}`,
    };
  }
}

function inspectWorkspace(workspace: string): ImplementationSourceResult<string> {
  try {
    return { ok: true, value: realpathSync(workspace) };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid implementation workspace ${workspace}: ${errorMessage(error)}`,
    };
  }
}

function escapesWorkspace(workspaceRoot: string, candidate: string): boolean {
  const candidateRelative = relative(workspaceRoot, candidate);
  return (
    candidateRelative === ".." ||
    candidateRelative.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelative)
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatZodError(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}
