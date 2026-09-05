import { SpecReviewArtifactSchema, type SpecReviewArtifact } from "../spec-review/schema.ts";
import { SpecWorkItemContextSchema, type SpecWorkItemContext } from "./schema.ts";
import { SpecRevisionReviewSchema, type SpecRevisionReview } from "./revise-schema.ts";

export const SPEC_REVISION_POLICY_VERSION = "3";

export function renderSpecRevisionPrompt(input: {
  workItem: SpecWorkItemContext;
  artifact: SpecReviewArtifact;
  review: SpecRevisionReview;
}): string {
  const workItem = SpecWorkItemContextSchema.parse(input.workItem);
  const artifact = SpecReviewArtifactSchema.parse(input.artifact);
  const review = SpecRevisionReviewSchema.parse(input.review);

  return `# Spec Revision

Resume your work as the original author of one implementation Spec. Evaluate every trusted reviewer finding against current repository authority and either revise the same Spec, explain why no revision is warranted, or identify prerequisite human input that blocks a sound response.

Your resumed session is useful context, but it is not the source of truth. Reconcile it with the current work-item context, the exact reviewed artifact, current repository guidance, and verified codebase facts.

## Authority and revision policy

- Apply this authority order: accepted requirements within host permissions and explicit safety constraints; applicable repository invariants; verified codebase facts. Treat current intent as the baseline, not a veto on an explicitly approved change to it.
- Inspect the relevant artifact, code, tests, and guidance needed to decide the findings. Reuse verified current facts; re-read when changed evidence requires it. Resolve inspectable questions and authorized assumptions without duplicate confirmation.
- Treat reviewer findings as advisory evidence, not authority. Accept a correct concern, adapt it when another authority-aligned resolution is better, and decline it only with concrete evidence.
- Preserve the smallest coherent change, vertical and independently useful delivery where practical, decisions rather than prewritten implementation, and the highest stable credible proof seam.
- When a finding concerns verification, keep every material outcome tied to an observable result, exact proof action, and expected evidence at the cheapest credible seam. Preserve material proof limits, terminal-state proof for asynchronous work, safe live-proof requirements, and honest handoff evidence without adding redundant layers.
- Do not add speculative hardening, generic frameworks, unrelated cleanup, or compatibility that current authority does not require.
- Do not run Git, create branches or commits, publish anything, or change Linear or other external systems.

## Artifact boundary

- The reviewed artifact is exactly ${artifact.path} at trusted revision ${artifact.revision}.
- Update only ${artifact.path}. Do not edit product code, configuration, workflows, indexes, or unrelated documentation.
- Keep the existing issue-keyed path. Do not create a replacement artifact or rename it.
- Decide the outcome before writing. For "updated", leave a complete non-empty revised artifact at that path. For "unchanged" or "needs-input", do not change the artifact.

## Finding responses

- Return exactly one response for every supplied finding ID. Do not add, remove, replace, or rename IDs.
- "accepted" means the concern and required outcome are correct. For "updated", the revised artifact must address them. For "needs-input", cite the evidence for accepting them while explaining the prerequisite that prevents a safe revision.
- "adapted" means the concern is correct but a different resolution better follows current authority. Cite the facts supporting that resolution.
- "declined" means the concern is incorrect, unsupported, superseded, or outside accepted scope. Cite concrete facts proving why.
- Accepted findings may use an empty evidence array only when an updated artifact is itself the proof. Adapted and declined findings always require evidence.
- Use portable repository-relative paths for artifact, code, docs, and test citations. Artifact citations must use exactly "${artifact.path}". Use path null only for work-item or repository-state evidence.

## Outcomes

- Return "updated" when at least one finding is accepted or adapted and the artifact content changed. Set questions to [].
- Return "unchanged" only when every finding is declined with evidence and the artifact did not change. Set questions to [].
- Return "needs-input" only when a prerequisite decision cannot be resolved through repository research or a concrete recommendation. Return focused questions and do not change the artifact.
- A later approval or human-authority choice that can be presented with researched options is not prerequisite input. Keep it as a reviewer decision in the Spec instead.

## Structured result

- Return only one JSON object matching the supplied schema. Do not include artifact markdown or session data in JSON.
- Keep responses in the same order as the supplied findings.
- Every response requires a concise rationale. Use required nullable citation line fields and set both to null when no line range applies.
- Do not claim success until the artifact effect matches the selected outcome.

Review context:

\`\`\`json
${JSON.stringify(
  {
    artifact,
    rubricVersion: review.rubricVersion,
    reviewedRevision: review.reviewedRevision,
    findings: review.findings,
  },
  null,
  2,
)}
\`\`\`

Current work-item context:

\`\`\`json
${JSON.stringify(workItem, null, 2)}
\`\`\`
`;
}
