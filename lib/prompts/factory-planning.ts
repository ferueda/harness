export type FactoryPlanningInitialPromptInput = {
  workItemJson: string;
  currentDate: string;
};

export type FactoryPlanningRevisionPromptInput = FactoryPlanningInitialPromptInput & {
  previousPlanMarkdown: string;
  reviewFindingsJson: string;
};

const PLANNING_RULES = `Return only structured JSON matching schemas/factory-planning-output.schema.json.
Do not mutate files, branches, labels, issues, pull requests, or tracker state.
The harness writes final files. You only return JSON.
When outcome is draft-ready, return a complete implementation plan in planMarkdown, not a diff.
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
- Return a full revised plan in planMarkdown, not a patch or partial section.
- The latest review findings below have synthetic ids.
- Return exactly one findingDecisions entry for every latest finding id.
- Use decision "implement" when applying the recommendation directly.
- Use decision "adapt" when solving the underlying issue differently.
- Use decision "decline" only when the finding is not applicable, and explain why.
- Do not include decisions for old or unknown findings.

Work item JSON:

\`\`\`json
${input.workItemJson}
\`\`\`

Previous plan:

\`\`\`markdown
${input.previousPlanMarkdown}
\`\`\`

Latest review findings:

\`\`\`json
${input.reviewFindingsJson}
\`\`\`
`;
}
