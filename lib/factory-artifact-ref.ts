import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { z } from "zod";

const RelativePathSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const normalized = normalize(value);
    if (isAbsolute(value) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
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
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== parsed.sha256) throw new Error(`Factory artifact hash mismatch: ${parsed.path}`);
  return path;
}
