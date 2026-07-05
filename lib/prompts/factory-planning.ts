export type FactoryPlanningInitialPromptInput = {
  workItemJson: string;
  draftPath: string;
  currentDate: string;
};

export type FactoryPlanningRevisionPromptInput = {
  draftPath: string;
  currentDate: string;
  reviewFindingsJson: string;
};

const PLANNING_RULES = `Return only structured JSON matching schemas/factory-planning-output.schema.json.
Do not mutate files, branches, labels, issues, pull requests, tracker state, or any file except the draft path.
Write or edit the complete implementation plan directly at the draft path.
The harness snapshots, reviews, and copies the final approved plan. You only own the draft file and small JSON metadata.
When outcome is draft-ready, the draft path must exist and contain the complete current plan.
When outcome is needs-human, return humanQuestions with the exact missing decisions.

Plan requirements:
- Verify current state before prescribing edits.
- Define scope, ownership, hard out-of-scope boundaries, commands, tests, done criteria, and STOP conditions.
- Include a "Skills for the executor" table with only verified skills/tools from the prompt context.
- Match create-plan discipline: requirements first, evidence-backed current state, explicit ordered steps, command-level gates.
- Anticipate review-spec concerns: architecture, feasibility, simplicity, reliability, edge cases, and testing.`;

export function renderFactoryPlanningInitialPrompt(
  input: FactoryPlanningInitialPromptInput,
): string {
  return `# Factory Planning

You are the planner for one factory work item in the target repository.

Current date: ${input.currentDate}

${PLANNING_RULES}

Draft path:

\`\`\`text
${input.draftPath}
\`\`\`

Work item JSON:

\`\`\`json
${input.workItemJson}
\`\`\`
`;
}

export function renderFactoryPlanningRevisionPrompt(
  input: FactoryPlanningRevisionPromptInput,
): string {
  return `# Factory Planning Revision

You are revising the implementation plan for one factory work item after plan-review.

Current date: ${input.currentDate}

${PLANNING_RULES}

Revision rules:
- Edit the draft path in place. Do not return the plan markdown in JSON.
- The latest review findings below have synthetic ids.
- Return exactly one findingDecisions entry for every latest finding id.
- Use decision "implement" when applying the recommendation directly.
- Use decision "adapt" when solving the underlying issue differently.
- Use decision "decline" only when the finding is not applicable, and explain why.
- Do not include decisions for old or unknown findings.

Draft path:

\`\`\`text
${input.draftPath}
\`\`\`

Latest review findings:

\`\`\`json
${input.reviewFindingsJson}
\`\`\`
`;
}
