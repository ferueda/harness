import type { SpecReviewProvenance } from "../spec-review/review.ts";
import type { SpecReviewDecision, SpecReviewFinding } from "../spec-review/schema.ts";
import type { SpecRevisionProvenance } from "./revise.ts";
import type { SpecRevisionDecision } from "./revise-schema.ts";
import type { SpecDecision, SpecReviewerDecision, SpecWorkItemContext } from "./schema.ts";
import type { SpecProvenance } from "./spec.ts";

export const SPEC_PULL_REQUEST_TITLE_LIMIT = 240;
export const SPEC_PULL_REQUEST_BODY_LIMIT = 20_000;
export const SPEC_LINEAR_COMMENT_LIMIT = 8_000;
export const SPEC_DESCRIPTIVE_FIELD_LIMIT = 2_000;
export const SPEC_REVIEW_FINDING_PR_SUMMARY_LIMIT = 600;
export const SPEC_REVIEW_FINDING_LINEAR_SUMMARY_LIMIT = 240;
export const SPEC_REVISION_COMMENT_FIELD_LIMIT = 300;

type ReadySpecDecision = Extract<SpecDecision, { outcome: "ready-for-review" }>;

export type SpecWorkspaceChange = Readonly<{
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted";
}>;

export type SpecRepositoryIdentity = Readonly<{
  owner: string;
  repository: string;
}>;

export class SpecPresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecPresentationError";
  }
}

export function validateSpecWorkspaceChanges(input: {
  reference: string;
  decision: SpecDecision;
  changes: readonly SpecWorkspaceChange[];
}): readonly SpecWorkspaceChange[] {
  if (input.decision.outcome === "needs-input") {
    if (input.changes.length > 0) {
      throw new SpecPresentationError("Needs Input must leave the repository workspace clean.");
    }
    return Object.freeze([]);
  }

  const artifactPath = `dev/plans/${input.reference}.md`;
  const artifactChanges = input.changes.filter((change) => change.path === artifactPath);
  if (
    artifactChanges.length !== 1 ||
    !["added", "untracked"].includes(artifactChanges[0]?.status ?? "")
  ) {
    throw new SpecPresentationError(
      `Ready Spec must add exactly one new ${artifactPath} artifact.`,
    );
  }

  for (const change of input.changes) {
    if (change.path === artifactPath) continue;
    if (change.path === "dev/plans/README.md" && ["added", "modified"].includes(change.status)) {
      continue;
    }
    throw new SpecPresentationError(
      `Ready Spec contains an unsupported ${change.status} change at ${change.path}.`,
    );
  }

  return Object.freeze(input.changes.map((change) => Object.freeze({ ...change })));
}

export function validateSpecRevisionWorkspaceChanges(input: {
  reference: string;
  outcome: SpecRevisionDecision["outcome"];
  changes: readonly SpecWorkspaceChange[];
}): readonly SpecWorkspaceChange[] {
  if (input.outcome !== "updated") {
    if (input.changes.length > 0) {
      throw new SpecPresentationError(
        `${formatOutcome(input.outcome)} Spec revision must leave the repository workspace clean.`,
      );
    }
    return Object.freeze([]);
  }

  const artifactPath = `dev/plans/${input.reference}.md`;
  if (
    input.changes.length !== 1 ||
    input.changes[0]?.path !== artifactPath ||
    input.changes[0].status !== "modified" ||
    input.changes[0].previousPath !== undefined
  ) {
    throw new SpecPresentationError(
      `Updated Spec revision must modify only the existing ${artifactPath} artifact.`,
    );
  }

  return Object.freeze(input.changes.map((change) => Object.freeze({ ...change })));
}

export function renderSpecPullRequest(input: {
  workItem: SpecWorkItemContext;
  decision: ReadySpecDecision;
  provenance: SpecProvenance;
}): Readonly<{ title: string; body: string }> {
  const title = boundedTitle(
    `${input.workItem.reference}: Spec for `,
    input.workItem.title,
    SPEC_PULL_REQUEST_TITLE_LIMIT,
  );
  const body = [
    "## Spec",
    `Linear issue: [${input.workItem.reference} — ${input.workItem.title}](${input.workItem.url})`,
    `Artifact: \`${input.decision.artifactPath}\``,
    "",
    boundedProse(input.decision.summary),
    "",
    "## Decisions for review",
    reviewerDecisions(input.decision.reviewerDecisions),
    "",
    "## Provenance",
    provenanceList(input.provenance),
  ].join("\n");

  return Object.freeze({
    title,
    body: assertBodyLimit("Spec pull-request body", body, SPEC_PULL_REQUEST_BODY_LIMIT),
  });
}

export function renderReviewedSpecPullRequest(input: {
  workItem: SpecWorkItemContext;
  specDecision: ReadySpecDecision;
  specProvenance: SpecProvenance;
  reviewDecision: SpecReviewDecision;
  reviewProvenance: SpecReviewProvenance;
  approved: boolean;
}): Readonly<{ title: string; body: string }> {
  assertReviewOutcome(input.approved, input.reviewDecision);

  const title = boundedTitle(
    input.approved
      ? `${input.workItem.reference}: Spec for `
      : `[UNAPPROVED] ${input.workItem.reference}: Spec for `,
    input.workItem.title,
    SPEC_PULL_REQUEST_TITLE_LIMIT,
  );
  const body = [
    "## Review status",
    input.approved
      ? "**Approved by automated Spec review.**"
      : "**Unapproved: the bounded automated review cycle was exhausted.**",
    boundedProse(input.reviewDecision.rationale),
    ...(input.reviewDecision.outcome === "changes-requested"
      ? [
          "",
          "## Unresolved findings",
          reviewFindings(input.reviewDecision.findings, SPEC_REVIEW_FINDING_PR_SUMMARY_LIMIT),
        ]
      : []),
    "",
    "## Spec",
    `Linear issue: [${input.workItem.reference} — ${input.workItem.title}](${input.workItem.url})`,
    `Artifact: \`${input.specDecision.artifactPath}\``,
    "",
    boundedProse(input.specDecision.summary),
    "",
    "## Decisions for review",
    reviewerDecisions(input.specDecision.reviewerDecisions),
    "",
    "## Execution",
    executionDetails(input.specProvenance, input.reviewProvenance),
  ].join("\n");

  return Object.freeze({
    title,
    body: assertBodyLimit("Reviewed Spec pull-request body", body, SPEC_PULL_REQUEST_BODY_LIMIT),
  });
}

export function renderSpecOutcomeComment(input: {
  marker: string;
  decision: SpecDecision;
  provenance: SpecProvenance;
  pullRequestUrl?: string;
}): string {
  const sections =
    input.decision.outcome === "ready-for-review"
      ? readyCommentSections(input.marker, input.decision, input.provenance, input.pullRequestUrl)
      : needsInputCommentSections(input.marker, input.decision, input.provenance);
  return assertBodyLimit(
    "Linear Spec outcome comment",
    sections.join("\n\n"),
    SPEC_LINEAR_COMMENT_LIMIT,
  );
}

export function renderReviewedSpecOutcomeComment(input: {
  marker: string;
  workItem: SpecWorkItemContext;
  specDecision: ReadySpecDecision;
  specProvenance: SpecProvenance;
  reviewDecision: SpecReviewDecision;
  reviewProvenance: SpecReviewProvenance;
  approved: boolean;
  pullRequestUrl: string;
}): string {
  assertReviewOutcome(input.approved, input.reviewDecision);
  if (!input.pullRequestUrl.trim()) {
    throw new SpecPresentationError("Reviewed Spec comment requires a pull-request URL.");
  }

  const sections = [
    input.marker,
    "## Agent Spec",
    input.approved
      ? "**Outcome:** Approved and ready for human review"
      : "**Outcome:** Automated review exhausted — unapproved",
    `**Summary:** ${boundedProse(input.specDecision.summary)}`,
    `**Artifact:** \`${input.specDecision.artifactPath}\``,
    `**Pull request:** ${input.pullRequestUrl}`,
    `**Automated review:** ${boundedProse(input.reviewDecision.rationale)}`,
    ...(input.reviewDecision.outcome === "changes-requested"
      ? [
          `**Unresolved findings**\n${reviewFindings(
            input.reviewDecision.findings,
            SPEC_REVIEW_FINDING_LINEAR_SUMMARY_LIMIT,
          )}`,
        ]
      : []),
    `**Execution**\n${executionDetails(input.specProvenance, input.reviewProvenance)}`,
  ];

  return assertBodyLimit(
    "Reviewed Linear Spec outcome comment",
    sections.join("\n\n"),
    SPEC_LINEAR_COMMENT_LIMIT,
  );
}

export function renderSpecRevisionNeedsInputComment(input: {
  marker: string;
  decision: SpecRevisionDecision;
  provenance: SpecRevisionProvenance;
}): string {
  if (input.decision.outcome !== "needs-input") {
    throw new SpecPresentationError(
      "Spec revision Needs Input comment requires a needs-input decision.",
    );
  }

  const body = [
    input.marker,
    "## Agent Spec revision",
    "**Outcome:** Needs input",
    `**Why Needs Input:** ${boundedProse(input.decision.rationale)}`,
    `**Questions**\n${input.decision.questions
      .map((question) => `- ${boundedText(question, SPEC_REVISION_COMMENT_FIELD_LIMIT)}`)
      .join("\n")}`,
    `**Finding responses**\n${revisionResponses(input.decision)}`,
    `**Execution**\n${revisionProvenanceList(input.provenance)}`,
  ].join("\n\n");

  return assertBodyLimit("Linear Spec revision comment", body, SPEC_LINEAR_COMMENT_LIMIT);
}

export function renderSpecFailureComment(input: { marker: string; error: string }): string {
  const body = [
    input.marker,
    "## Spec automation needs attention",
    boundedProse(input.error),
    "No workspace is retained automatically. Cleanup was attempted. Resolve the problem, then manually requeue the issue when it is ready.",
  ].join("\n\n");
  return assertBodyLimit("Linear Spec failure comment", body, SPEC_LINEAR_COMMENT_LIMIT);
}

export function reservedPullRequestUrl(repository: SpecRepositoryIdentity): string {
  return `https://github.com/${repository.owner}/${repository.repository}/pull/${"9".repeat(20)}`;
}

function readyCommentSections(
  marker: string,
  decision: ReadySpecDecision,
  provenance: SpecProvenance,
  pullRequestUrl: string | undefined,
): string[] {
  if (!pullRequestUrl) {
    throw new SpecPresentationError("Ready Spec comment requires a pull-request URL.");
  }
  return [
    marker,
    "## Agent Spec",
    "**Outcome:** Ready for review",
    `**Summary:** ${boundedProse(decision.summary)}`,
    `**Artifact:** \`${decision.artifactPath}\``,
    `**Pull request:** ${pullRequestUrl}`,
    `**Decisions for review**\n${reviewerDecisions(decision.reviewerDecisions)}`,
    `**Execution**\n${provenanceList(provenance)}`,
  ];
}

function needsInputCommentSections(
  marker: string,
  decision: Extract<SpecDecision, { outcome: "needs-input" }>,
  provenance: SpecProvenance,
): string[] {
  return [
    marker,
    "## Agent Spec",
    "**Outcome:** Needs input",
    `**Why Needs Input:** ${boundedProse(decision.summary)}`,
    `**Questions**\n${decision.questions.map((question) => `- ${question}`).join("\n")}`,
    `**Execution**\n${provenanceList(provenance)}`,
  ];
}

function reviewerDecisions(decisions: readonly SpecReviewerDecision[]): string {
  if (decisions.length === 0) return "None.";
  return decisions
    .map(
      (decision, index) =>
        `${index + 1}. **${decision.question}**\n   Recommendation: ${decision.recommendation}\n   Rationale: ${decision.rationale}`,
    )
    .join("\n");
}

function provenanceList(provenance: SpecProvenance): string {
  return [
    `- Provider: ${provenance.provider}`,
    `- Model: ${provenance.model} (${provenance.modelReasoningEffort})`,
    `- Policy: ${provenance.policyVersion}`,
  ].join("\n");
}

function executionDetails(
  specProvenance: SpecProvenance,
  reviewProvenance: SpecReviewProvenance,
): string {
  return [
    `- Author provider: ${specProvenance.provider}`,
    `- Author model: ${specProvenance.model} (${specProvenance.modelReasoningEffort})`,
    `- Author policy: ${specProvenance.policyVersion}`,
    `- Reviewer provider: ${reviewProvenance.provider}`,
    `- Reviewer model: ${reviewProvenance.model} (${reviewProvenance.modelReasoningEffort})`,
    `- Review rubric: ${reviewProvenance.rubricVersion}`,
  ].join("\n");
}

function revisionProvenanceList(provenance: SpecRevisionProvenance): string {
  return [
    `- Provider: ${provenance.provider}`,
    `- Model: ${provenance.model} (${provenance.modelReasoningEffort})`,
    `- Policy: ${provenance.policyVersion}`,
    ...(provenance.reviewRubricVersion
      ? [`- Review rubric: ${provenance.reviewRubricVersion}`]
      : []),
  ].join("\n");
}

function reviewFindings(findings: readonly SpecReviewFinding[], summaryLimit: number): string {
  return findings
    .map(
      (finding, index) =>
        `${index + 1}. \`${finding.id}\` — **${finding.criterion}**, ${finding.artifactLocation.section}\n   ${boundedText(finding.problem, summaryLimit)}`,
    )
    .join("\n");
}

function revisionResponses(decision: SpecRevisionDecision): string {
  return decision.responses
    .map(
      (response) =>
        `- \`${response.findingId}\` — **${response.disposition}**: ${boundedText(
          response.rationale,
          SPEC_REVISION_COMMENT_FIELD_LIMIT,
        )}`,
    )
    .join("\n");
}

function assertReviewOutcome(approved: boolean, decision: SpecReviewDecision): void {
  const decisionApproved = decision.outcome === "approved";
  if (approved !== decisionApproved) {
    throw new SpecPresentationError(
      approved
        ? "Approved Spec presentation requires an approved review decision."
        : "Unapproved Spec presentation requires a changes-requested review decision.",
    );
  }
}

function formatOutcome(outcome: SpecRevisionDecision["outcome"]): string {
  return outcome === "needs-input" ? "Needs Input" : "Unchanged";
}

function boundedTitle(prefix: string, suffix: string, limit: number): string {
  const room = limit - prefix.length;
  if (room < 1) throw new SpecPresentationError("Spec pull-request title prefix is too long.");
  const trimmed = suffix.trim();
  if (prefix.length + trimmed.length <= limit) return `${prefix}${trimmed}`;
  return `${prefix}${trimmed.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
}

function boundedProse(value: string): string {
  return boundedText(value, SPEC_DESCRIPTIVE_FIELD_LIMIT);
}

function boundedText(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function assertBodyLimit(label: string, body: string, limit: number): string {
  if (body.length > limit) {
    throw new SpecPresentationError(`${label} exceeds its ${limit}-character limit.`);
  }
  return body;
}
