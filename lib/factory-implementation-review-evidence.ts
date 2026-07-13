import { readFileSync } from "node:fs";
import { aggregateVerdict } from "./aggregate.ts";
import { ReviewOutputSchema, type ReviewOutput } from "./schemas.ts";

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
  const verdict = aggregateVerdict(implementation, quality);
  if (input.meta.verdict !== verdict) throw new Error("Change-review aggregate verdict mismatch");
  const blocking = [
    ...blockingFor("implementation", implementation),
    ...blockingFor("quality", quality),
  ];
  if (verdict === "needs_changes" && blocking.length === 0)
    throw new Error("needs_changes review has no blocking findings");
  return { verdict, implementation, quality, blocking };
}

function blockingFor(reviewer: string, review: ReviewOutput) {
  return review.findings.flatMap((finding, index) =>
    finding.must_fix ? [{ ...finding, id: `${reviewer}-${index + 1}`, reviewer }] : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
