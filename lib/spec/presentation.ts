import type { SpecDecision, SpecReviewerDecision, SpecWorkItemContext } from "./schema.ts";
import type { SpecProvenance } from "./spec.ts";

export const SPEC_PULL_REQUEST_TITLE_LIMIT = 240;
export const SPEC_PULL_REQUEST_BODY_LIMIT = 20_000;
export const SPEC_LINEAR_COMMENT_LIMIT = 8_000;
export const SPEC_DESCRIPTIVE_FIELD_LIMIT = 2_000;

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

export function renderSpecFailureComment(input: { marker: string; error: string }): string {
  const body = [
    input.marker,
    "## Spec automation needs attention",
    boundedProse(input.error),
    "The issue remains claimed with its Spec action so the retained workspace can be inspected.",
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

function boundedTitle(prefix: string, suffix: string, limit: number): string {
  const room = limit - prefix.length;
  if (room < 1) throw new SpecPresentationError("Spec pull-request title prefix is too long.");
  const trimmed = suffix.trim();
  if (prefix.length + trimmed.length <= limit) return `${prefix}${trimmed}`;
  return `${prefix}${trimmed.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
}

function boundedProse(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= SPEC_DESCRIPTIVE_FIELD_LIMIT) return trimmed;
  return `${trimmed.slice(0, SPEC_DESCRIPTIVE_FIELD_LIMIT - 1).trimEnd()}…`;
}

function assertBodyLimit(label: string, body: string, limit: number): string {
  if (body.length > limit) {
    throw new SpecPresentationError(`${label} exceeds its ${limit}-character limit.`);
  }
  return body;
}
