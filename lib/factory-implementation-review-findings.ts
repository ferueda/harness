import { readFileSync } from "node:fs";
import { ReviewOutputSchema, formatZodError, type ReviewOutput } from "./schemas.ts";

export type FactoryImplementationReviewRole = "implementation" | "quality" | "simplify";

export type FactoryImplementationReviewFinding = ReviewOutput["findings"][number] & {
  id: string;
  role: FactoryImplementationReviewRole;
  index: number;
};

export type NormalizedFactoryImplementationReview = {
  roles: Record<FactoryImplementationReviewRole, ReviewOutput>;
  findings: FactoryImplementationReviewFinding[];
  verdict: ReviewOutput["verdict"];
};

const ROLE_ORDER = ["implementation", "quality", "simplify"] as const;
const ROLE_PREFIX: Record<FactoryImplementationReviewRole, string> = {
  implementation: "implementation",
  quality: "quality",
  simplify: "simplify",
};

export function normalizeFactoryImplementationReviewFindings(input: {
  implementation: unknown;
  quality: unknown;
  simplify: unknown;
}): NormalizedFactoryImplementationReview {
  const roles = {
    implementation: parseReview(input.implementation, "implementation"),
    quality: parseReview(input.quality, "quality"),
    simplify: parseReview(input.simplify, "simplify"),
  } satisfies Record<FactoryImplementationReviewRole, ReviewOutput>;
  const findings: FactoryImplementationReviewFinding[] = [];
  for (const role of ROLE_ORDER) {
    const review = roles[role];
    if (review.verdict === "needs_changes" && review.findings.length === 0) {
      throw new FactoryImplementationReviewFindingsError(
        `${role} reviewer returned needs_changes without findings`,
      );
    }
    review.findings.forEach((finding, index) => {
      findings.push({
        ...finding,
        id: `${ROLE_PREFIX[role]}-${String(index + 1).padStart(3, "0")}`,
        role,
        index,
      });
    });
  }
  const verdict =
    roles.simplify.verdict === "blocked" ||
    roles.quality.verdict === "blocked" ||
    roles.implementation.verdict === "blocked"
      ? "blocked"
      : roles.simplify.verdict === "needs_changes" ||
          roles.quality.verdict === "needs_changes" ||
          roles.implementation.verdict === "needs_changes" ||
          findings.some((finding) => finding.must_fix)
        ? "needs_changes"
        : "pass";
  return { roles, findings, verdict };
}

export function readFactoryImplementationReviewFindings(input: {
  implementationPath: string;
  qualityPath: string;
  simplifyPath: string;
}): NormalizedFactoryImplementationReview {
  return normalizeFactoryImplementationReviewFindings({
    implementation: readJson(input.implementationPath),
    quality: readJson(input.qualityPath),
    simplify: readJson(input.simplifyPath),
  });
}

export class FactoryImplementationReviewFindingsError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryImplementationReviewFindingsError";
  }
}

function parseReview(value: unknown, role: FactoryImplementationReviewRole): ReviewOutput {
  const result = ReviewOutputSchema.safeParse(value);
  if (result.success) return result.data;
  throw new FactoryImplementationReviewFindingsError(
    `Invalid ${role} reviewer output: ${formatZodError(result.error)}`,
    { cause: result.error },
  );
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new FactoryImplementationReviewFindingsError(`Cannot read reviewer output: ${path}`, {
      cause: error,
    });
  }
}
