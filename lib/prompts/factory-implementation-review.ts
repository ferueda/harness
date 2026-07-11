import type { AgentSessionRef } from "../agents.ts";
import type { FactoryImplementationReviewFinding } from "../factory-implementation-review-findings.ts";
import type {
  CandidateTuple,
  WorkspaceProvenance,
} from "../factory-implementation-review-schemas.ts";

export function renderFactoryImplementationRemediationPrompt(input: {
  workItem: { id: string; title: string; body: string };
  originalReviewBase: string;
  approvedCandidate: CandidateTuple;
  findings: readonly FactoryImplementationReviewFinding[];
  implementerAgent: { name: string; model?: string };
}): string {
  const findings = input.findings
    .map((finding) =>
      [
        `### ${finding.id}: ${finding.title}`,
        `- Role: ${finding.role}`,
        `- Severity: ${finding.severity}`,
        `- must_fix: ${finding.must_fix}`,
        `- Location: ${finding.location}`,
        `- Issue: ${finding.issue}`,
        `- Recommendation: ${finding.recommendation}`,
        `- Rationale: ${finding.rationale}`,
      ].join("\n"),
    )
    .join("\n\n");
  return [
    "# Factory Implementation Remediation",
    "",
    "## Implementer Role",
    "",
    `Agent: ${input.implementerAgent.name}${input.implementerAgent.model ? ` (${input.implementerAgent.model})` : ""}`,
    "",
    "## Work Item",
    "",
    `- ${input.workItem.id}: ${input.workItem.title}`,
    input.workItem.body ? `- Request: ${input.workItem.body}` : "",
    "",
    "## Review Findings",
    "",
    findings || "_No findings._",
    "",
    "## Required Output",
    "",
    "Return exactly one structured object with `summary` and `findingDecisions`.",
    "Each current finding ID must occur exactly once. Every decision is `implement`, `adapt`, or `decline`, and every rationale is non-empty.",
    "",
    "## Boundaries",
    "",
    `- Preserve the implementation session and work against the current workspace tree for candidate ${input.approvedCandidate.ref}.`,
    `- Review base is ${input.originalReviewBase}; do not reset, checkout, commit, branch, push, or update refs.`,
    "- Do not write decision files, lifecycle state, checkpoints, summaries, handoffs, prompts, streams, refs, branches, or PRs.",
    "- Do not write durable artifacts or mutate tracker state. Harness owns all durable evidence.",
    "- Make only source, test, or documentation edits required by the work item and findings.",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function renderFactoryImplementationPrReadyHandoff(input: {
  workItem: { id: string; title: string };
  implementationRunId: string;
  attempts: ReadonlyArray<{
    attemptId: string;
    reviewIndex: number;
    nestedReviewRefs: readonly string[];
    decisions: ReadonlyArray<{ findingId: string; decision: string; rationale: string }>;
  }>;
  originalReviewBase: string;
  finalCandidate: CandidateTuple;
  cumulativeDiff: string;
  implementerSession: AgentSessionRef;
  workspace: WorkspaceProvenance;
  acceptedDebt: ReadonlyArray<{
    findingId: string;
    rationale: string;
    attemptId: string;
    reviewIndex: number;
  }>;
}): string {
  const attempts = [...input.attempts]
    .sort((a, b) => a.reviewIndex - b.reviewIndex || a.attemptId.localeCompare(b.attemptId))
    .flatMap((attempt) => [
      `### Attempt ${attempt.reviewIndex}: ${attempt.attemptId}`,
      "",
      `- Nested reviews: ${attempt.nestedReviewRefs.length > 0 ? attempt.nestedReviewRefs.join(", ") : "none"}`,
      ...(attempt.decisions.length > 0
        ? [
            "- Decisions:",
            ...[...attempt.decisions]
              .sort((a, b) => a.findingId.localeCompare(b.findingId))
              .map(
                (decision) =>
                  `  - ${decision.findingId}: ${decision.decision} — ${decision.rationale}`,
              ),
          ]
        : ["- Decisions: none"]),
      "",
    ]);
  return [
    "# Factory Implementation Review Handoff",
    "",
    "**Status:** PR-ready",
    "",
    `- Work item: ${input.workItem.id} — ${input.workItem.title}`,
    `- Owning implementation run: ${input.implementationRunId}`,
    `- Implementer session: ${input.implementerSession.provider} ${input.implementerSession.id}`,
    `- Original review base: ${input.originalReviewBase}`,
    `- Final candidate: ${input.finalCandidate.ref} (${input.finalCandidate.commit})`,
    `- Final tree: ${input.finalCandidate.tree}`,
    `- Physical workspace: ${input.workspace.physicalGitRoot}`,
    "",
    "## Review Attempts",
    "",
    ...(attempts.length > 0 ? attempts : ["_No remediation attempts._", ""]),
    "## Accepted Debt",
    "",
    ...(input.acceptedDebt.length > 0
      ? input.acceptedDebt
          .slice()
          .sort((a, b) => a.findingId.localeCompare(b.findingId))
          .map((debt) => `- ${debt.findingId}: ${debt.rationale}`)
      : ["_None._"]),
    "",
    "## Cumulative Diff",
    "",
    input.cumulativeDiff || "_No cumulative diff._",
    "",
    "No branch or PR was created by Factory. The handoff is ready for the operator's normal PR workflow.",
    "",
  ].join("\n");
}
