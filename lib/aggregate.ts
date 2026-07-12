import type { ReviewOutput } from "./schemas.ts";

export type ReviewVerdict = "pass" | "needs_changes" | "blocked";

export type ReviewFindingLike = {
  title?: string;
  severity?: string;
  location?: string;
  issue?: string;
  recommendation?: string;
  rationale?: string;
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

export type FailedReview = {
  key: string;
  stage: string;
  error: string;
};

export type WorkflowStepMetadata = {
  workflow: string;
  availableSteps: string[];
  requestedSteps: string[];
  executedSteps: string[];
  omittedSteps: string[];
  partial: boolean;
};

export type ReviewScope = {
  baseRef: string;
  headRef: string;
  mergeBase: string;
  headSha: string;
};

type SummaryHeaderInput = {
  title: string;
  runId: string;
  workspace: string;
  scope?: ReviewScope;
  verdict: string;
  startedAt: string;
  durationMs: number;
  steps?: WorkflowStepMetadata;
};

const FAILED_REVIEW_TITLES: Record<string, string> = {
  implementation: "Implementation review",
  codeQuality: "Code quality review",
  spec: "Spec review",
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
  scope?: ReviewScope;
  reviews: ReviewSection[];
  verdict: string;
  startedAt: string;
  durationMs: number;
  steps?: WorkflowStepMetadata;
}): string {
  const lines = [
    ...renderSummaryHeader(input),
    ...renderStepSections(input.steps),
    ...renderReviewSections(input.reviews),
  ];

  return lines.join("\n");
}

export function renderFailedSummary(input: {
  title: string;
  runId: string;
  workspace: string;
  scope?: ReviewScope;
  reviews: ReviewSection[];
  failedReviews: FailedReview[];
  startedAt: string;
  durationMs: number;
  steps?: WorkflowStepMetadata;
}): string {
  const lines = [
    ...renderSummaryHeader({ ...input, verdict: "failed" }),
    ...renderStepSections(input.steps),
    ...renderReviewSections(input.reviews),
    ...renderFailedReviewSections(input.failedReviews),
  ];

  return lines.join("\n");
}

function renderSummaryHeader(input: SummaryHeaderInput): string[] {
  const lines = [
    `# ${input.title}`,
    "",
    `- **Run**: \`${input.runId}\``,
    `- **Workspace**: \`${input.workspace}\``,
  ];

  if (input.scope) {
    lines.push(
      `- **Scope**: \`${input.scope.baseRef}\` → \`${input.scope.headRef}\` (merge-base \`${input.scope.mergeBase}\`)`,
      `- **Head SHA**: \`${input.scope.headSha}\``,
    );
  }

  lines.push(
    `- **Started**: ${input.startedAt}`,
    `- **Duration**: ${Math.round(input.durationMs / 1000)}s`,
    `- **Aggregate verdict**: **${input.verdict}**`,
    "",
  );
  return lines;
}

function renderStepSections(steps: WorkflowStepMetadata | undefined): string[] {
  if (!steps?.partial) return [];

  const lines = [
    "## Steps",
    "",
    `- Available: ${formatStepList(steps.availableSteps)}`,
    `- Executed: ${formatStepList(steps.executedSteps)}`,
  ];

  if (steps.omittedSteps.length > 0) {
    lines.push(`- Omitted: ${formatStepList(steps.omittedSteps)}`);
  }

  return [...lines, ""];
}

function formatStepList(steps: string[]): string {
  return steps.length > 0 ? steps.map((step) => `\`${step}\``).join(", ") : "_none_";
}

function renderReviewSections(reviews: ReviewSection[]): string[] {
  return reviews.flatMap(({ title, review }) => [
    `## ${title}`,
    "",
    `- Verdict: **${review?.verdict ?? "unknown"}**`,
    `- Summary: ${review?.summary ?? "(none)"}`,
    "",
    ...formatFindings(review?.findings),
    "",
  ]);
}

function renderFailedReviewSections(failedReviews: FailedReview[]): string[] {
  return [
    "## Failed reviewers",
    "",
    ...failedReviews.flatMap((review) => [
      `### ${FAILED_REVIEW_TITLES[review.key] ?? review.key}`,
      "",
      `- **Key**: \`${review.key}\``,
      `- **Stage**: \`${review.stage}\``,
      `- **Error**: ${review.error}`,
      "",
    ]),
  ];
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
    `- **Rationale**: ${finding.rationale ?? ""}`,
    "",
  ]);
}
