export type ReviewVerdict = "pass" | "needs_changes" | "blocked";

export type ReviewFindingLike = {
  title?: string;
  severity?: string;
  location?: string;
  issue?: string;
  recommendation?: string;
  must_fix?: boolean;
};

export type ReviewOutputLike = {
  verdict?: string;
  summary?: string;
  findings?: ReviewFindingLike[];
};

export type ReviewScope = {
  baseRef: string;
  headRef: string;
  mergeBase: string;
  headSha: string;
};

export function aggregateVerdict(
  implReview: ReviewOutputLike | undefined,
  qualityReview: ReviewOutputLike | undefined,
): ReviewVerdict {
  const reviews = [implReview, qualityReview].filter((review): review is ReviewOutputLike =>
    Boolean(review),
  );

  if (reviews.some((review) => review.verdict === "blocked")) {
    return "blocked";
  }

  if (reviews.some((review) => review.verdict === "needs_changes")) {
    return "needs_changes";
  }

  const hasMustFix = reviews.some((review) =>
    (review.findings ?? []).some((finding) => finding.must_fix === true),
  );
  if (hasMustFix) return "needs_changes";

  if (reviews.length === 2 && reviews.every((review) => review.verdict === "pass")) {
    return "pass";
  }

  return "needs_changes";
}

/**
 * @param {{ runId: string, workspace: string, scope: object, implReview: ReviewOutput, qualityReview: ReviewOutput, verdict: string, startedAt: string, durationMs: number }} input
 */
export function renderSummary(input: {
  runId: string;
  workspace: string;
  scope: ReviewScope;
  implReview: ReviewOutputLike;
  qualityReview: ReviewOutputLike;
  verdict: string;
  startedAt: string;
  durationMs: number;
}): string {
  const lines = [
    "# Dual Review Summary",
    "",
    `- **Run**: \`${input.runId}\``,
    `- **Workspace**: \`${input.workspace}\``,
    `- **Scope**: \`${input.scope.baseRef}\` → \`${input.scope.headRef}\` (merge-base \`${input.scope.mergeBase}\`)`,
    `- **Head SHA**: \`${input.scope.headSha}\``,
    `- **Started**: ${input.startedAt}`,
    `- **Duration**: ${Math.round(input.durationMs / 1000)}s`,
    `- **Aggregate verdict**: **${input.verdict}**`,
    "",
    "## Implementation review",
    "",
    `- Verdict: **${input.implReview?.verdict ?? "unknown"}**`,
    `- Summary: ${input.implReview?.summary ?? "(none)"}`,
    "",
    ...formatFindings(input.implReview?.findings),
    "",
    "## Code quality review",
    "",
    `- Verdict: **${input.qualityReview?.verdict ?? "unknown"}**`,
    `- Summary: ${input.qualityReview?.summary ?? "(none)"}`,
    "",
    ...formatFindings(input.qualityReview?.findings),
    "",
  ];

  return lines.join("\n");
}

function formatFindings(findings: ReviewFindingLike[] | undefined): string[] {
  if (!findings?.length) {
    return ["_No findings._"];
  }

  return findings.flatMap((finding, index) => [
    `### ${index + 1}. ${finding.title ?? "Untitled"}`,
    "",
    `- **Severity**: ${finding.severity ?? "unknown"}`,
    `- **Location**: \`${finding.location ?? "unknown"}\``,
    `- **must_fix**: ${finding.must_fix === true}`,
    `- **Issue**: ${finding.issue ?? ""}`,
    `- **Recommendation**: ${finding.recommendation ?? ""}`,
    "",
  ]);
}
