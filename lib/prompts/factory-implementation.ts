import type { FactoryWorkItem } from "../factory-schemas.ts";

export function renderFactoryImplementationPrompt(input: {
  workItem: FactoryWorkItem;
  planPath?: string;
  revision?: {
    blockingFindings: unknown;
    priorCommit: string;
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
    "- Edit files and run relevant non-destructive validation.",
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
    "",
  ].join("\n");
}
