import type { FactoryWorkItem } from "../factory-schemas.ts";

export function renderFactoryImplementationPrompt(input: {
  workItem: FactoryWorkItem;
  planPath?: string;
}): string {
  return [
    "# Factory implementation action",
    "",
    "Implement the accepted work item in the current repository.",
    input.planPath
      ? `Follow the reviewed plan at: ${input.planPath}`
      : "No plan: keep to the direct request.",
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
