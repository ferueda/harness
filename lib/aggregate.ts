import type { ReviewOutput } from "./schemas.ts";

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

export type ReviewSection = {
  key: string;
  title: string;
  review: ReviewOutput;
};

export type ReviewScope = {
  baseRef: string;
  headRef: string;
  mergeBase: string;
  headSha: string;
};

export function aggregateVerdict(...inputs: (ReviewOutputLike | undefined)[]): ReviewVerdict {
  const reviews = inputs.filter((review): review is ReviewOutputLike => Boolean(review));

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

  if (reviews.length > 0 && reviews.every((review) => review.verdict === "pass")) {
    return "pass";
  }

  return "needs_changes";
}

export function renderSummary(input: {
  title: string;
  runId: string;
  workspace: string;
  scope: ReviewScope;
  reviews: ReviewSection[];
  verdict: string;
  startedAt: string;
  durationMs: number;
}): string {
  const lines = [
    `# ${input.title}`,
    "",
    `- **Run**: \`${input.runId}\``,
    `- **Workspace**: \`${input.workspace}\``,
    `- **Scope**: \`${input.scope.baseRef}\` → \`${input.scope.headRef}\` (merge-base \`${input.scope.mergeBase}\`)`,
    `- **Head SHA**: \`${input.scope.headSha}\``,
    `- **Started**: ${input.startedAt}`,
    `- **Duration**: ${Math.round(input.durationMs / 1000)}s`,
    `- **Aggregate verdict**: **${input.verdict}**`,
    "",
    ...input.reviews.flatMap(({ title, review }) => [
      `## ${title}`,
      "",
      `- Verdict: **${review?.verdict ?? "unknown"}**`,
      `- Summary: ${review?.summary ?? "(none)"}`,
      "",
      ...formatFindings(review?.findings),
      "",
    ]),
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
