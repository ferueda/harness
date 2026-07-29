import { createHash } from "node:crypto";
import type { SpecReviewArtifact, SpecReviewFindingDraft } from "./schema.ts";

export function createSpecReviewFindingId(input: {
  artifact: SpecReviewArtifact;
  rubricVersion: string;
  finding: SpecReviewFindingDraft;
}): string {
  return `spec-review-finding-${sha256(
    JSON.stringify({
      artifact: input.artifact,
      rubricVersion: input.rubricVersion,
      finding: JSON.parse(canonicalSpecReviewFinding(input.finding)) as unknown,
    }),
  )}`;
}

export function canonicalSpecReviewFinding(finding: SpecReviewFindingDraft): string {
  const evidence = finding.evidence
    .map((citation) => ({
      source: citation.source,
      path: citation.path,
      lineStart: citation.lineStart,
      lineEnd: citation.lineEnd,
      summary: citation.summary,
    }))
    // Finding identity must not depend on process locale or provider citation order.
    .toSorted((left, right) => compareCanonicalJson(left, right));

  // Explicit field order makes identity independent of object construction order.
  return JSON.stringify({
    criterion: finding.criterion,
    artifactLocation: {
      section: finding.artifactLocation.section,
      lineStart: finding.artifactLocation.lineStart,
      lineEnd: finding.artifactLocation.lineEnd,
    },
    evidence,
    problem: finding.problem,
    requiredOutcome: finding.requiredOutcome,
  });
}

function compareCanonicalJson(left: object, right: object): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  if (leftJson < rightJson) return -1;
  if (leftJson > rightJson) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
