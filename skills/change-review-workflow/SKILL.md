---
name: change-review-workflow
description: Select proportionate diff review and coordinate authorized corrections. Choose implementation, quality, both, or skip low-risk work; not an automatic post-edit gate.
---

# Change Review Workflow

Assess review value at a coherent completion point, not after every edit or
commit. A review request alone does not authorize fixes, commits, or publication.

## Select the review scope

Inspect the complete intended change against its base, accepted outcome, and
available verification, not just the last patch. Honor explicitly requested
roles and mandatory caller/repository gates. Otherwise choose:

- **Skip**: routine, readily understood changes with no material behavior,
  contract, ownership, structural, or verification risk. Test names, comments,
  formatting, and ordinary tests using established fixtures usually fit.
- **Implementation**: material correctness, acceptance, failure-handling,
  compatibility, security, or behavioral-proof questions; structure is familiar.
- **Quality**: substantial structural or abstraction changes with no material
  behavior/contract uncertainty needing a separate implementation review.
- **Both**: distinct behavioral and structural risks, such as redesigning a
  shared primitive's contract, lifecycle, or owner across consumers.

Judge consequences and uncertainty, not file extensions, line counts, or the
mere presence of tests or primitives. Weakening a critical assertion can need
implementation review; changing a primitive's comment does not. Inspect uncertain
scope before deciding; inability to inspect is not evidence that review is safe
to skip. Select only roles with a concrete purpose, without a separate model call
or assessment artifact. Give a short reason in the existing completion summary.

A skip means no independent review ran, not a passing review. Do not invoke
Harness for a skip. Required local checks still apply. Explicit review requests
receive the requested review even for small changes; otherwise one relevant role
is sufficient when it covers the material risks.

## Run selected roles

Resolve the task/plan, base, and head. Harness reviews
`merge-base(base, head)..head`; staged, unstaged, and untracked changes are not
included. Use an authorized temporary review ref/commit object for local work,
or report the exact uncovered scope. Never commit unrelated work for the runner.

Discover the available `harness`, `.harness/bin/harness`, or source executable;
consult help for flags. Pass `--steps implementation`, `--steps quality`, or
`--steps implementation,quality` deliberately. The bare command still defaults
to both for compatibility; that is not a requirement to run both on every task.
Include `--plan` when relevant. Load [the handoff reference](references/review-handoff.md)
only for session-only context, selected scope, or follow-up decisions.

If the runner is unavailable, report the limitation. Use an available direct
reviewer only when the task permits it; never claim Harness ran. A delegated
operation returns to its caller and cannot waive that caller's review or
publication requirements. The unattended Linear worker retains both reviewers.

## Findings and remediation

Read structured reviewer outputs and metadata. Merge duplicate issues while
preserving provenance. Report findings only when evidence establishes a concrete
consequence for the accepted task. Omit nitpicks, equivalent styles, speculative
hardening, and unrelated cleanup rather than collecting them as advisories.
A blocker must explain why the issue prevents safe acceptance; severity alone
is not a blocker rule. Useful non-blocking observations do not require fixes or
another review cycle. No findings is a valid result.

Give material findings an evidence-backed Implement, Adapt, or Decline disposition.
When fixes are authorized, make the smallest accepted correction and run relevant
checks and required gates. Otherwise return findings without editing. Pause only
corrections needing new authority or a material human decision. New evidence of a
material defect remains valid even when a previous reviewer missed it; do not
reopen settled preferences without new evidence.

## Follow-up and completion

Reassess changes since the last review. Rerun only roles whose conclusions could
be materially invalidated, whose blockers need independent confirmation, or
whose execution failed. A logic fix may need implementation; a structural fix
may need quality or both. Mechanical edits or straightforward test additions can
be inspected and checked locally without another model run. Do not rerun solely
because HEAD changed. Do not drop an unresolved required role to obtain a pass.

Use at most three total runs: initial plus two follow-ups. Preserve the budget
and dispositions across continuations; report unresolved blockers or unavailable
required coverage when exhausted.

Complete when the selected required roles pass, material findings are resolved
or dispositioned with evidence, and later edits do not invalidate that evidence.
A quality-only result need not acquire an implementation pass. A selected-role
run remains `partial` relative to the full catalogue; omitted unnecessary roles
are not failed coverage. A failed or blocked required role is incomplete, not a
skip or approval. Skipping is a selection decision, never a fabricated verdict.

Report roles, the reviewed revision, checks, dispositions, and material limits.
If later edits were verified directly, distinguish them from the independently
reviewed revision. Do not claim a reviewer approved unseen changes. Publication
remains separate and requires task authority.
