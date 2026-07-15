import { readFileSync } from "node:fs";
import { z } from "zod";
import { aggregateVerdict } from "./aggregate.ts";
import { FactoryArtifactRefSchema } from "./factory-artifact-ref.ts";
import { ReviewOutputSchema, type ReviewOutput } from "./schemas.ts";
import { assertTerminalReviewVerdict } from "./factory-implementation-review-checkpoint.ts";

export const FactoryImplementationSessionSchema = z.object({
  provider: z.enum(["cursor", "codex"]),
  id: z.string().trim().min(1),
});

export const FactoryImplementationCandidateEvidenceSchema = z.object({
  version: z.literal(1),
  phaseRunId: z.string(),
  attempt: z.number().int().positive(),
  base: z.string(),
  ref: z.string(),
  commit: z.string(),
  tree: z.string(),
  status: z.string(),
  effectiveSession: FactoryImplementationSessionSchema,
  artifacts: z.object({
    raw: FactoryArtifactRefSchema,
    stream: FactoryArtifactRefSchema,
    diff: FactoryArtifactRefSchema,
  }),
});

export const FactoryImplementationReviewEvidenceSchema = z.object({
  version: z.literal(1),
  phaseRunId: z.string(),
  reviewRound: z.number().int().positive(),
  candidateAttempt: z.number().int().positive(),
  base: z.string(),
  commit: z.string(),
  tree: z.string(),
  partial: z.literal(false),
  verdict: z.enum(["pass", "needs_changes", "blocked"]),
  reviewers: z.object({
    implementation: FactoryArtifactRefSchema,
    quality: FactoryArtifactRefSchema,
  }),
  blockingFindings: FactoryArtifactRefSchema.optional(),
});

const BlockingFindingSchema = z.object({
  title: z.string(),
  severity: z.enum(["Critical", "High", "Medium", "Low"]),
  location: z.string(),
  issue: z.string(),
  recommendation: z.string(),
  rationale: z.string(),
  must_fix: z.literal(true),
  id: z.string().min(1),
  reviewer: z.enum(["implementation", "quality"]),
});
export const FactoryImplementationBlockingFindingsSchema = z.array(BlockingFindingSchema).min(1);
export type FactoryImplementationBlockingFindings = z.infer<
  typeof FactoryImplementationBlockingFindingsSchema
>;

export type ImplementationReviewEvidence = {
  verdict: "pass" | "needs_changes" | "blocked";
  implementation: ReviewOutput;
  quality: ReviewOutput;
  blocking: Array<ReviewOutput["findings"][number] & { id: string; reviewer: string }>;
};

export function validateImplementationReviewEvidence(input: {
  meta: unknown;
  implementationPath: string;
  qualityPath: string;
}): ImplementationReviewEvidence {
  if (!isRecord(input.meta)) throw new Error("Change-review metadata is invalid");
  if (
    input.meta.status !== "completed" ||
    input.meta.partial !== false ||
    JSON.stringify(input.meta.requestedSteps) !== JSON.stringify(["implementation", "quality"]) ||
    JSON.stringify(input.meta.executedSteps) !== JSON.stringify(["implementation", "quality"]) ||
    JSON.stringify(input.meta.omittedSteps) !== JSON.stringify([])
  )
    throw new Error("Change-review did not complete the fixed full reviewer set");
  const implementation = ReviewOutputSchema.parse(
    JSON.parse(readFileSync(input.implementationPath, "utf8")),
  );
  const quality = ReviewOutputSchema.parse(JSON.parse(readFileSync(input.qualityPath, "utf8")));
  const evidence = validateCumulativeImplementationReviewEvidence({ implementation, quality });
  const { verdict } = evidence;
  if (input.meta.verdict !== verdict) throw new Error("Change-review aggregate verdict mismatch");
  return evidence;
}

export function validateCumulativeImplementationReviewEvidence(input: {
  implementation: ReviewOutput;
  quality: ReviewOutput;
}): ImplementationReviewEvidence {
  assertTerminalReviewVerdict("implementation", input.implementation);
  assertTerminalReviewVerdict("quality", input.quality);
  const verdict = aggregateVerdict(input.implementation, input.quality);
  const blocking = [
    ...blockingFor("implementation", input.implementation),
    ...blockingFor("quality", input.quality),
  ];
  if (verdict === "needs_changes" && blocking.length === 0)
    throw new Error("needs_changes review has no blocking findings");
  return { verdict, ...input, blocking };
}

export function collectImplementationBlockingFindings(input: {
  implementationPath: string;
  qualityPath: string;
}): FactoryImplementationBlockingFindings {
  const implementation = ReviewOutputSchema.parse(
    JSON.parse(readFileSync(input.implementationPath, "utf8")),
  );
  const quality = ReviewOutputSchema.parse(JSON.parse(readFileSync(input.qualityPath, "utf8")));
  return FactoryImplementationBlockingFindingsSchema.parse([
    ...blockingFor("implementation", implementation),
    ...blockingFor("quality", quality),
  ]);
}

function blockingFor(reviewer: string, review: ReviewOutput) {
  return review.findings.flatMap((finding, index) =>
    finding.must_fix
      ? [{ ...finding, must_fix: true as const, id: `${reviewer}-${index + 1}`, reviewer }]
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
