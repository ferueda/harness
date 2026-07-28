import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { errorMessage } from "../agent/invocation.ts";
import { SpecIssueReferenceSchema } from "./schema.ts";

export type SpecArtifactSnapshot = Readonly<{
  path: string;
  sha256: string;
}>;

export type SpecArtifactInspection =
  | Readonly<{ ok: true; snapshot: SpecArtifactSnapshot }>
  | Readonly<{ ok: false; error: string }>;

export function specArtifactPath(reference: string): string {
  return `dev/plans/${SpecIssueReferenceSchema.parse(reference)}.md`;
}

export function inspectSpecArtifact(input: {
  workspace: string;
  expectedPath: string;
  claimedPath?: string;
}): SpecArtifactInspection {
  const claimedPath = input.claimedPath ?? input.expectedPath;
  if (claimedPath !== input.expectedPath) {
    return {
      ok: false,
      error: `Invalid Spec artifact: expected ${input.expectedPath}, received ${claimedPath}.`,
    };
  }

  try {
    const workspaceRoot = realpathSync(input.workspace);
    const candidate = resolve(workspaceRoot, claimedPath);
    const candidateRelative = relative(workspaceRoot, candidate);
    if (
      candidateRelative === ".." ||
      candidateRelative.startsWith(`..${sep}`) ||
      isAbsolute(candidateRelative)
    ) {
      return {
        ok: false,
        error: `Invalid Spec artifact: ${claimedPath} resolves outside the supplied workspace.`,
      };
    }

    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        ok: false,
        error: `Invalid Spec artifact: ${claimedPath} must be a regular file.`,
      };
    }

    // A regular final file can still escape through a symlinked parent directory.
    const realCandidate = realpathSync(candidate);
    const realRelative = relative(workspaceRoot, realCandidate);
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
      return {
        ok: false,
        error: `Invalid Spec artifact: ${claimedPath} resolves outside the supplied workspace.`,
      };
    }

    const contents = readFileSync(realCandidate, "utf8");
    if (contents.trim() === "") {
      return { ok: false, error: `Invalid Spec artifact: ${claimedPath} is empty.` };
    }

    return {
      ok: true,
      snapshot: Object.freeze({
        path: claimedPath,
        sha256: createHash("sha256").update(contents).digest("hex"),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid Spec artifact ${claimedPath}: ${errorMessage(error)}`,
    };
  }
}
