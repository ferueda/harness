/** @typedef {{ verdict?: string, summary?: string, findings?: Array<{ title?: string, severity?: string, must_fix?: boolean }> }} ReviewOutput */

/**
 * @param {ReviewOutput | undefined} implReview
 * @param {ReviewOutput | undefined} qualityReview
 * @returns {"pass" | "needs_changes" | "blocked"}
 */
export function aggregateVerdict(implReview, qualityReview) {
  const reviews = [implReview, qualityReview].filter(Boolean);

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
export function renderSummary(input) {
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

/** @param {ReviewOutput["findings"]} findings */
function formatFindings(findings) {
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
