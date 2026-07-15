import type { FactoryWorkItem } from "../factory-schemas.ts";

export function renderFactoryImplementationPrompt(input: {
  workItem: FactoryWorkItem;
  planPath?: string;
  revision?: {
    blockingFindings: unknown;
    priorCommit: string;
    operatorResponse: string;
  };
}): string {
  return [
    "# Factory implementation action",
    "",
    "Implement the accepted work item in the current repository.",
    input.planPath
      ? `Follow the reviewed plan at: ${input.planPath}`
      : "No plan: keep to the direct request.",
    ...(input.revision
      ? [
          "",
          "## Revision authority",
          "",
          `Revise the prior candidate commit: ${input.revision.priorCommit}`,
          "Address every blocking finding below. Keep valid prior work unless a finding requires changing it.",
          "",
          "```json",
          JSON.stringify(input.revision.blockingFindings, null, 2),
          "```",
          "",
          "## Accepted operator response",
          "",
          "The operator selected revision for this exact candidate. Treat this response as accepted clarification within the original task scope.",
          "",
          input.revision.operatorResponse,
        ]
      : []),
    "",
    "## Work-item authority",
    "",
    "```json",
    JSON.stringify(input.workItem, null, 2),
    "```",
    "",
    "## Boundaries",
    "",
    "- Follow the target repository's instructions, including its canonical final handoff gate.",
    "- Run scoped non-destructive validation while iterating, then run the required final gate before reporting completion.",
    "- If that gate fails or cannot run, report the exact blocker and do not claim the implementation is complete.",
    "- Do not stage, commit, checkout, create branches, mutate refs, or push.",
    "- Do not mutate trackers, run reviewers, or write Factory lifecycle state.",
    "- Stop on a material plan/repository conflict or scope expansion.",
    "",
  ].join("\n");
}

export function renderFactoryImplementationReviewHandoff(input: {
  workItem: FactoryWorkItem;
  phaseRunId: string;
  candidateCommit: string;
  continuation?: {
    decision: "revise" | "re-review";
    response: string;
    priorReview?: { implementation: unknown; quality: unknown };
  };
}): string {
  return [
    "# Factory implementation review handoff",
    "",
    `Phase run: ${input.phaseRunId}`,
    `Candidate commit: ${input.candidateCommit}`,
    "",
    "Use the work item below as original intent and scope authority.",
    "",
    "```json",
    JSON.stringify(input.workItem, null, 2),
    "```",
    ...(input.continuation
      ? [
          "",
          "## Accepted operator response",
          "",
          `The operator selected ${input.continuation.decision} for the continuation governing this review. Treat this response as accepted clarification and evidence within the original task scope.`,
          "",
          input.continuation.response,
          ...(input.continuation.priorReview
            ? [
                "",
                "## Prior implementation review",
                "",
                "```json",
                JSON.stringify(input.continuation.priorReview.implementation, null, 2),
                "```",
                "",
                "## Prior quality review",
                "",
                "```json",
                JSON.stringify(input.continuation.priorReview.quality, null, 2),
                "```",
              ]
            : []),
        ]
      : []),
    "",
  ].join("\n");
}
