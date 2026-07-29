import {
  SpecReviewArtifactSchema,
  SpecReviewWorkItemContextSchema,
  type SpecReviewArtifact,
  type SpecReviewWorkItemContext,
} from "./schema.ts";

export const SPEC_REVIEW_RUBRIC_VERSION = "3";
export const SPEC_REVIEW_PROMPT_VERSION = "3";

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
- Treat decisions marked accepted, current, locked, or superseding as authority. Treat unmarked proposals, comments, metadata, summaries, and reviewer preferences as context only.
- When the Spec depends on an executor skill or specialized repository pattern, inspect only the matching SKILL.md files and use them as subordinate evidence, not a new checklist.
- Review the Spec as a decision record for a capable but context-limited executor. Do not demand template sections, detail, or ceremony that would not change an executor decision or prove acceptance.

## Versioned rubric

Evaluate whether the Spec:

1. follows repository invariants, project intent, accepted requirements, and verified code reality;
2. resolves planning-time choices instead of handing them to the executor;
3. uses Needs Input and reviewer decisions consistently: prerequisite input blocks every useful Spec, while later human-authority choices may remain as researched reviewer decisions;
4. chooses the smallest coherent change and avoids speculative hardening, generic frameworks, unrelated cleanup, and unrequired compatibility;
5. uses vertical, independently useful units where appropriate and explains unavoidable horizontal work;
6. captures decisions, boundaries, ownership, dependencies, risks, and test scenarios without pre-writing code, replacement Spec prose, or shell-command choreography;
7. connects every material outcome or forbidden effect to the cheapest credible proof action and expected observable evidence;
8. is right-sized, portable, and executable without the author's hidden context.

Trace every proposed change and test to an accepted requirement, a repository invariant, or a verified risk. Unsupported work already proposed by the Spec is a scope defect.

Check these details only when the proposed change makes them material:

- For replaced, redirected, split, deprecated, or removed behavior: the post-change owner, exact removals, cutover order, and required compatibility.
- For changed failure handling, state or data flow, privacy, security, reliability, performance, or edge cases: the intended behavior and credible proof beside the affected change.

### Outcome-proof contract

- The canonical repository gate proves general health; it does not replace acceptance-level behavioral proof.
- Require another proof layer only for a distinct boundary or failure mode that the cheaper seam cannot observe. Approve focused proof plus the gate when it is sufficient.
- Require material limits of mocks, fakes, intercepted requests, or source-only checks to be explicit.
- For asynchronous work, require observation of the terminal state or downstream effect. Acceptance or enqueueing alone is insufficient.
- For live proof, require explicit authority, prerequisites, disposable data, assertions, stop conditions, redaction, cleanup, and remaining uncertainty.
- Require unavailable material proof and handoff evidence to state exact observed results, skipped checks with reasons, concrete blockers, and remaining unknowns.

## Findings

- Every returned finding requests a change. Omit advisory observations that do not justify revising the Spec.
- Request changes only when the Spec omits or contradicts an accepted goal, requirement, decision, or boundary; materially expands scope without authority; violates a repository invariant; introduces a verified correctness, security, reliability, or compatibility risk; or omits a material executor decision or behavioral proof needed for safe implementation.
- Reviewer-proposed optional hardening, alternative architectures, preferences, nearby cleanup, and unrelated future work cannot request changes.
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
- For "insufficient-context", set evidence and findings to [] and use rationale to state the smallest exact missing authority or evidence. Use it only when a project-level, architectural, boundary, public API, data, provider, or workflow-wide decision cannot be reviewed safely.
- A narrow bug fix or local refactor may be approved without a project intent file when the Spec records that none was found and makes no project-level direction or boundary decision.
- Do not add finding IDs, artifact identity, revision, policy versions, hashes, provenance, or session data. Trusted code adds those after validation.
- If required authority is genuinely unavailable, do not invent evidence or turn absence into a change request. Return "insufficient-context"; trusted code maps it to an execution failure rather than a review verdict.

Work-item context:

\`\`\`json
${JSON.stringify(workItem, null, 2)}
\`\`\`
`;
}
