import {
  SpecReviewArtifactSchema,
  SpecReviewWorkItemContextSchema,
  type SpecReviewArtifact,
  type SpecReviewWorkItemContext,
} from "./schema.ts";

export const SPEC_REVIEW_RUBRIC_VERSION = "1";
export const SPEC_REVIEW_PROMPT_VERSION = "1";

export function renderSpecReviewPrompt(input: {
  workItem: SpecReviewWorkItemContext;
  artifact: SpecReviewArtifact;
}): string {
  const workItem = SpecReviewWorkItemContextSchema.parse(input.workItem);
  const artifact = SpecReviewArtifactSchema.parse(input.artifact);

  return `# Independent Spec Review

You are an independent reviewer for one implementation Spec. Review the exact artifact named below against current repository authority and return either approval or material, evidence-backed change requests.

This is a fresh review. You do not have the Spec author's session and must not infer hidden author intent.

## Review boundary

- Work only in read-only mode. Do not edit files, create branches or commits, publish anything, or change external systems.
- Review exactly ${artifact.path} at trusted revision ${artifact.revision}. The caller has verified the checkout revision; do not run Git or replace that identity with repository state.
- Read repository guidance and the authoritative project intent or vision source, then inspect only the relevant code, tests, docs, work-item context, and Spec.
- Apply this authority order: repository invariants and current project intent; explicit requirements and accepted decisions; verified codebase facts.
- Review the Spec as a decision record for a capable but context-limited executor. Do not demand template sections, detail, or ceremony that would not change an executor decision or prove acceptance.

## Versioned rubric

Evaluate whether the Spec:

1. follows repository invariants, project intent, accepted requirements, and verified code reality;
2. resolves planning-time choices instead of handing them to the executor;
3. uses Needs Input and reviewer decisions consistently: prerequisite input blocks every useful Spec, while later human-authority choices may remain as researched reviewer decisions;
4. chooses the smallest coherent change and avoids speculative hardening, generic frameworks, unrelated cleanup, and unrequired compatibility;
5. uses vertical, independently useful units where appropriate and explains unavoidable horizontal work;
6. captures decisions, boundaries, ownership, dependencies, risks, and test scenarios without pre-writing code, replacement Spec prose, or shell-command choreography;
7. connects material outcomes to the highest stable credible proof seam;
8. is right-sized, portable, and executable without the author's hidden context.

## Findings

- Request changes only for a material correctness, scope, architecture, delivery, verification, risk, or simplicity gap.
- Every finding must identify the deficient artifact section or line range, cite one or more facts that prove the problem, explain the problem, and state the required outcome.
- artifactLocation identifies where the Spec is deficient. Evidence identifies the independent work-item, artifact, code, docs, test, or repository-state facts that support the finding.
- Use path null for work-item citations. Use portable repository-relative paths for artifact, code, docs, and test citations. An artifact citation path must be exactly "${artifact.path}".
- Use positive, ordered line ranges when line evidence is useful; otherwise use null for both lineStart and lineEnd.
- Do not write replacement Spec text, implementation code, or executor command sequences.
- Keep findings distinct. Do not repeat one problem under multiple criteria.

## Structured result

- Return only one JSON object matching the supplied schema.
- The strict provider schema uses required nullable lineStart and lineEnd fields. Use null when a line is not cited.
- For "approved", provide at least one evidence citation and set findings to [].
- For "changes-requested", set top-level evidence to [] and provide one or more findings.
- Do not add finding IDs, artifact identity, revision, policy versions, hashes, provenance, or session data. Trusted code adds those after validation.
- If required authority is genuinely unavailable, do not invent evidence or turn absence into a finding. Return invalid output rather than claiming approval or a deficiency; the caller treats unavailable required context as an execution failure, not a verdict.

Work-item context:

\`\`\`json
${JSON.stringify(workItem, null, 2)}
\`\`\`
`;
}
