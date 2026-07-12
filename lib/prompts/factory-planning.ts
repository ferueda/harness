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
Always return both arrays: use humanQuestions: [] and findingDecisions: [] when not applicable.

Planning priorities, in order:
1. Repository hard invariants and documented project intent.
2. Explicit work-item goal, requirements, acceptance criteria, and scope.
3. Architecture decisions the work item explicitly marks accepted, current, locked, or superseding an earlier direction.
4. Verified repository facts and existing patterns.
Triage evidence and reviewer recommendations are advisory. Unmarked proposals and option lists are context, not accepted decisions. Never infer authority from tracker comment order. If explicit directions conflict and no explicit supersession resolves them, return needs-human and quote the conflicting directions.

Write the minimum sufficient plan for a capable, context-limited executor with repository access but without prior context about the task at hand. Include decisions needed for safe execution; omit useful-only context and inspectable repository basics.

Use this default plan shape:
# <Outcome-oriented title>
## Goal
Problem, intended outcome, acceptance criteria, and material project constraints.
## Changes
Ordered items: file or symbol, decision, intended behavior, and relevant test seam. Inline current facts only when decision-shaping.
## Verify
Focused behavioral check and canonical repository validation. Do not repeat covered checks or routine diff inspection without a named risk.
## Boundaries
Concrete non-goals or STOP conditions that prevent a likely scope mistake. Omit when none exist.

Planning rules:
- Choose the smallest coherent change satisfying the goal and invariants.
- Prefer the highest existing stable test seam proving acceptance; use a lower seam only for a distinct invariant or failure mode unobservable there.
- Include excerpts only when the exact target shape is load-bearing.
- Add material only when it changes an executor decision or proves a distinct criterion, invariant, or verified regression risk.
- Do not add preserved behavior, speculative hardening, future-proofing, or repetition.
- Generic planning templates are optional unless explicitly required for Factory plans.

Verify current state. Prefer concise durable source references over reproduction. Length follows decision and change-surface complexity, not a target.`;

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
- The latest blocking review findings below have stable synthetic ids. Advisory findings remain in review evidence but are intentionally omitted here.
- Reviewer input remains lower priority than task authority, but every supplied must_fix finding requires a decision. If task authority conflicts with a blocker, return needs-human.
- When outcome is draft-ready, return exactly one findingDecisions entry for every latest blocking finding id.
- When outcome is needs-human, return humanQuestions; findingDecisions may be empty but must still be present.
- Use decision "implement" when applying the recommendation directly.
- Use decision "adapt" when solving the underlying issue differently.
- Use decision "decline" only when the finding is not applicable, and explain why.
- Do not include decisions for old or unknown findings.
- After addressing the blockers, remove obsolete, duplicated, speculative, or superseded material. A revision should not grow unless a blocking finding requires new scope.

Draft path:

\`\`\`text
${input.draftPath}
\`\`\`

Latest blocking review findings:

\`\`\`json
${input.reviewFindingsJson}
\`\`\`
`;
}
