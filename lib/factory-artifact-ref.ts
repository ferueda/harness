import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { z } from "zod";

const RelativePathSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const portable = value.replaceAll("\\", "/");
    const segments = portable.split("/");
    if (
      value.includes("\\") ||
      portable.startsWith("/") ||
      /^\/?[A-Za-z]:/.test(portable) ||
      portable.startsWith("//") ||
      segments.some((segment) => segment === ".." || segment === "" || segment === ".")
    ) {
      ctx.addIssue({ code: "custom", message: "must be a portable relative path" });
    }
  });

const FactoryArtifactRefInputSchema = z
  .object({
    base: z.enum(["factory-store", "repository"]),
    path: RelativePathSchema,
  })
  .strict();

export const FactoryArtifactRefSchema = z
  .object({
    base: z.enum(["factory-store", "repository"]),
    path: RelativePathSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type FactoryArtifactRef = z.infer<typeof FactoryArtifactRefSchema>;

export function createFactoryArtifactRef(input: {
  base: FactoryArtifactRef["base"];
  root: string;
  path: string;
}): FactoryArtifactRef {
  const candidate = FactoryArtifactRefInputSchema.parse({ base: input.base, path: input.path });
  const absolute = resolve(input.root, candidate.path);
  assertContained(input.root, absolute);
  return FactoryArtifactRefSchema.parse({
    ...candidate,
    sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
  });
}

export function verifyFactoryArtifactRef(
  ref: FactoryArtifactRef,
  roots: Record<FactoryArtifactRef["base"], string>,
): string {
  const parsed = FactoryArtifactRefSchema.parse(ref);
  const path = resolve(roots[parsed.base], parsed.path);
  assertContained(roots[parsed.base], path);
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== parsed.sha256) throw new Error(`Factory artifact hash mismatch: ${parsed.path}`);
  return path;
}

function assertContained(root: string, path: string): void {
  const value = relative(realpathSync(resolve(root)), realpathSync(path));
  if (value === ".." || value.startsWith("../") || value.startsWith("..\\")) {
    throw new Error("Factory artifact path escapes its declared root");
  }
}
