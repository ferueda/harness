import type { RepositoryCheckpoint } from "../repository/types.ts";
import type { ImplementationDecision, ImplementationProof } from "../implementation/schema.ts";
import type { ImplementationRevisionDecision } from "../implementation/revise-schema.ts";
import type { ImplementationSource } from "../implementation/source.ts";
import type { ChangeReviewResult } from "../../workflows/change-review.workflow.ts";
import type { WorkItemContext } from "../work-item/schema.ts";

export const IMPLEMENTATION_PULL_REQUEST_TITLE_LIMIT = 240;
export const IMPLEMENTATION_PULL_REQUEST_BODY_LIMIT = 20_000;
export const IMPLEMENTATION_LINEAR_COMMENT_LIMIT = 8_000;
const FIELD_LIMIT = 2_000;
const FINDING_LIMIT = 600;

export type ImplementationReviewPresentation = Readonly<{
  result: ChangeReviewResult;
  exhausted: boolean;
}>;

export class ImplementationPresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementationPresentationError";
  }
}

export function renderImplementationPullRequest(input: {
  workItem: WorkItemContext;
  decision: Extract<ImplementationDecision, { outcome: "implemented" }>;
  source: ImplementationSource;
  checkpoint: RepositoryCheckpoint;
  review: ImplementationReviewPresentation;
}): Readonly<{ title: string; body: string }> {
  const titlePrefix = input.review.exhausted ? "[UNAPPROVED] " : "";
  const title = boundedTitle(`${titlePrefix}${input.workItem.reference}: `, input.workItem.title);
  const body = [
    "## Implementation",
    input.review.exhausted
      ? "**Review status:** Automated review exhausted with unresolved findings."
      : "**Review status:** Passed automated implementation and quality review.",
    `Linear issue: [${input.workItem.reference} — ${input.workItem.title}](${input.workItem.url})`,
    `Source: ${sourceDescription(input.source)}`,
    `Checkpoint: \`${input.checkpoint.revision}\``,
    "",
    bounded(input.decision.summary),
    "",
    `## Verification\n${proofList(input.decision.proof)}`,
    `## Remaining uncertainty\n${list(input.decision.remainingUncertainty)}`,
    `## Review\n${reviewSummary(input.review.result)}`,
  ];
  return Object.freeze({
    title,
    body: assertLimit(
      "Implementation pull-request body",
      body.join("\n"),
      IMPLEMENTATION_PULL_REQUEST_BODY_LIMIT,
    ),
  });
}

export function renderImplementationOutcomeComment(input: {
  marker: string;
  workItem: WorkItemContext;
  decision: Extract<ImplementationDecision, { outcome: "implemented" }>;
  source: ImplementationSource;
  checkpoint: RepositoryCheckpoint | null;
  review: ImplementationReviewPresentation | null;
  pullRequestUrl?: string;
}): string {
  const body = [
    input.marker,
    "## Agent implementation",
    input.pullRequestUrl
      ? input.review?.exhausted
        ? "**Outcome:** Pull request published; automated review exhausted"
        : "**Outcome:** Pull request published and ready for human review"
      : "**Outcome:** No repository changes found",
    `**Summary:** ${bounded(input.decision.summary)}`,
    `**Source:** ${sourceDescription(input.source)}`,
    ...(input.checkpoint ? [`**Checkpoint:** \`${input.checkpoint.revision}\``] : []),
    ...(input.pullRequestUrl ? [`**Pull request:** ${input.pullRequestUrl}`] : []),
    `**Verification**\n${proofList(input.decision.proof)}`,
    `**Remaining uncertainty**\n${list(input.decision.remainingUncertainty)}`,
    ...(input.review ? [`**Review**\n${reviewSummary(input.review.result)}`] : []),
  ];
  return assertLimit(
    "Linear implementation outcome comment",
    body.join("\n\n"),
    IMPLEMENTATION_LINEAR_COMMENT_LIMIT,
  );
}

export function renderImplementationNeedsInputComment(input: {
  marker: string;
  summary: string;
  questions: readonly string[];
}): string {
  return assertLimit(
    "Linear implementation Needs Input comment",
    [
      input.marker,
      "## Agent implementation",
      "**Outcome:** Needs input",
      `**Why:** ${bounded(input.summary)}`,
      `**Questions**\n${input.questions.map((question) => `- ${boundedText(question, 400)}`).join("\n")}`,
    ].join("\n\n"),
    IMPLEMENTATION_LINEAR_COMMENT_LIMIT,
  );
}

export function renderImplementationFailureComment(input: {
  marker: string;
  error: string;
}): string {
  return assertLimit(
    "Linear implementation failure comment",
    [
      input.marker,
      "## Implementation automation needs attention",
      bounded(input.error),
      "The issue was returned to Open without Agent Ready. Review the failure, then grant Agent Ready to retry.",
    ].join("\n\n"),
    IMPLEMENTATION_LINEAR_COMMENT_LIMIT,
  );
}

export function renderImplementationCleanupFailureComment(input: {
  marker: string;
  error: string;
}): string {
  return assertLimit(
    "Linear implementation cleanup failure comment",
    [
      input.marker,
      "## Implementation workspace cleanup needs attention",
      bounded(input.error),
      "The Linear outcome was retained, but the repository run could not be released. Inspect the Grove lease before retrying the issue.",
    ].join("\n\n"),
    IMPLEMENTATION_LINEAR_COMMENT_LIMIT,
  );
}

export function renderImplementationRevisionNeedsInputComment(input: {
  marker: string;
  decision: ImplementationRevisionDecision;
}): string {
  if (input.decision.outcome !== "needs-input") {
    throw new ImplementationPresentationError(
      "Implementation revision Needs Input presentation requires a needs-input decision.",
    );
  }
  return assertLimit(
    "Linear implementation revision Needs Input comment",
    [
      input.marker,
      "## Agent implementation revision",
      "**Outcome:** Needs input",
      `**Why:** ${bounded(input.decision.rationale)}`,
      `**Questions**\n${input.decision.questions.map((question) => `- ${boundedText(question, 400)}`).join("\n")}`,
      `**Finding responses**\n${input.decision.responses
        .map(
          (response) =>
            `- \`${response.findingId}\` — **${response.disposition}**: ${boundedText(response.rationale, 400)}`,
        )
        .join("\n")}`,
    ].join("\n\n"),
    IMPLEMENTATION_LINEAR_COMMENT_LIMIT,
  );
}

export function reservedImplementationPullRequestUrl(repository: {
  owner: string;
  repository: string;
}): string {
  return `https://github.com/${repository.owner}/${repository.repository}/pull/${"9".repeat(20)}`;
}

export function implementationReviewAuthority(source: ImplementationSource): {
  planPath?: string;
  handoffText?: string;
} {
  if (source.kind === "plan") return { planPath: source.path };
  return {
    handoffText: [
      "## Implementation authority (Linear)",
      "",
      "The following complete normalized Linear work item is the selected implementation source:",
      "",
      "```json",
      JSON.stringify(source.workItem, null, 2),
      "```",
    ].join("\n"),
  };
}

function sourceDescription(source: ImplementationSource): string {
  return source.kind === "plan"
    ? `merged plan \`${source.path}\``
    : "complete Linear issue context";
}

function reviewSummary(result: ChangeReviewResult): string {
  const outputs = result.reviewOutputs;
  const sections = [
    `Verdict: ${result.status === "completed" ? result.verdict : "failed"}`,
    `Implementation reviewer: ${outputs.implementation?.verdict ?? "unavailable"}`,
    `Code-quality reviewer: ${outputs.quality?.verdict ?? "unavailable"}`,
  ];
  const findings = [
    ...(outputs.implementation?.findings ?? []),
    ...(outputs.quality?.findings ?? []),
  ].filter((finding) => finding.must_fix);
  if (findings.length > 0) {
    sections.push(
      "Unresolved actionable findings:\n" +
        findings
          .map(
            (finding, index) =>
              `${index + 1}. **${finding.title}** — ${boundedText(finding.issue, FINDING_LIMIT)}`,
          )
          .join("\n"),
    );
  }
  return sections.join("\n");
}

function proofList(proof: readonly ImplementationProof[]): string {
  return proof
    .map(
      (item) =>
        `- **${item.status}:** ${boundedText(item.action, 400)} — ${boundedText(item.observedResult, 600)}`,
    )
    .join("\n");
}

function list(values: readonly string[]): string {
  return values.length === 0
    ? "None reported."
    : values.map((value) => `- ${bounded(value)}`).join("\n");
}

function boundedTitle(prefix: string, suffix: string): string {
  const room = IMPLEMENTATION_PULL_REQUEST_TITLE_LIMIT - prefix.length;
  if (room < 1)
    throw new ImplementationPresentationError("Implementation title prefix is too long.");
  const trimmed = suffix.trim();
  return prefix.length + trimmed.length <= IMPLEMENTATION_PULL_REQUEST_TITLE_LIMIT
    ? `${prefix}${trimmed}`
    : `${prefix}${trimmed.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
}

function bounded(value: string): string {
  return boundedText(value, FIELD_LIMIT);
}

function boundedText(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function assertLimit(label: string, value: string, limit: number): string {
  if (value.length > limit)
    throw new ImplementationPresentationError(`${label} exceeds its ${limit}-character limit.`);
  return value;
}
