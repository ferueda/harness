import type { ImplementationPlanSourceAuthority, ImplementationSourceAuthority } from "./source.ts";
import {
  ImplementationRevisionReviewSchema,
  type ImplementationRevisionReview,
} from "./revise-schema.ts";

export const IMPLEMENTATION_REVISION_POLICY_VERSION = "1";

export function renderImplementationRevisionPrompt(input: {
  authority: ImplementationSourceAuthority;
  review: ImplementationRevisionReview;
}): string {
  const review = ImplementationRevisionReviewSchema.parse(input.review);
  const { selectedSource, selectedSourcePath } = revisionSourceContext(input.authority);

  return `# Revise Implementation

Resume your work as the original implementation author. Evaluate every trusted actionable finding against current repository authority. Accept a correct finding, adapt it when a smaller or more accurate resolution is better, or decline it with concrete evidence.

Your resumed session is context, not authority. Reconcile it with current repository guidance, the exact selected implementation source, current code, tests, documentation, and the trusted findings below.

## Authority and revision policy

- Apply this authority order: repository invariants and current project intent; the selected implementation source; verified current-code facts.
- Re-read the relevant guidance, source, code, tests, and docs. Trace complete control flow and resolve inspectable questions yourself before deciding.
- Treat findings as advisory evidence. The original author owns the final disposition for every actionable finding.
- Make the smallest coherent correction. Do not add speculative hardening, generic frameworks, unrelated cleanup, or compatibility that current authority does not require.
- Keep the selected source unchanged. When it is a plan, do not edit, rename, delete, or replace it.
- Do not run Git, create commits or checkpoints, invoke reviewers, mutate Linear, publish a pull request, or perform other external mutations.

## Finding responses

- Return exactly one response for every supplied finding ID, in the supplied order. Do not add, remove, replace, or rename IDs.
- "accepted" means the concern and requested correction are sound.
- "adapted" means the concern is sound but another authority-aligned correction is better. Cite the facts supporting it.
- "declined" means the concern is incorrect, already resolved, unsupported, superseded, or outside accepted scope. Cite concrete facts proving why.
- Adapted and declined responses always require evidence. Accepted responses may omit evidence only for "updated", where the implemented correction and proof provide the result.
- Use portable repository-relative paths for code, docs, and test evidence. For selected-source evidence, use path ${selectedSourcePath}. Use path null for repository-state evidence.

## Outcomes and proof

- Return "updated" when at least one finding is accepted or adapted and you made the warranted workspace changes. Return at least one focused proof record and no questions.
- Return "unchanged" only when every finding is declined with evidence and no workspace change is warranted. Return at least one focused proof record supporting that decision and no questions.
- Return "needs-input" only when a prerequisite human decision materially changes scope or architecture and cannot be resolved through repository research or a concrete recommendation. Return focused questions, no proof records, no remaining-uncertainty records, and evidence for every finding response.
- Partial edits may remain for "needs-input". Do not clean them up or claim they will be preserved; the caller owns discard and recovery.
- For "updated" and "unchanged", report the highest stable focused proof that supports the result. Record failed or skipped proof honestly and include the resulting remaining uncertainty.
- The caller, not this operation, inspects Git and decides whether the workspace effect matches the declared outcome.

## Structured result

- Return only one JSON object matching the supplied schema. Do not include session data in JSON.
- Include a concise overall rationale, every finding response, proof, remaining uncertainty, and questions as required by the selected outcome.
- Never claim a proof action passed without its observed result.

Trusted review context:

\`\`\`json
${JSON.stringify(review, null, 2)}
\`\`\`

Selected implementation source:

\`\`\`json
${JSON.stringify(selectedSource, null, 2)}
\`\`\`
`;
}

function revisionSourceContext(authority: ImplementationSourceAuthority) {
  if (isPlanAuthority(authority)) {
    return {
      selectedSource: {
        kind: "plan",
        issueReference: authority.issueReference,
        path: authority.source.path,
        content: authority.planContent,
      },
      selectedSourcePath: `"${authority.source.path}"`,
    } as const;
  }
  return {
    selectedSource: {
      kind: "linear",
      workItem: authority.source.workItem,
    },
    selectedSourcePath: "null",
  } as const;
}

function isPlanAuthority(
  authority: ImplementationSourceAuthority,
): authority is ImplementationPlanSourceAuthority {
  return authority.source.kind === "plan";
}
