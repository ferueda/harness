---
name: change-review-workflow
description: Run Harness change-review and coordinate finding resolution for a full-workflow request. Fixes and publication remain limited to the authority granted for the task.
---

# Change Review Workflow

Decide whether current changes satisfy the accepted task. Keep review and
remediation in scope; a review request alone does not authorize source fixes,
commits, or external publication.

## Start

Resolve base, head, requested roles, and the task/plan. Harness reviews
`merge-base(base, head)..head`: staged, unstaged, and untracked work is excluded.
A committed review does not cover uncommitted changes. Include local
work through an authorized temporary review ref/commit object, or report the
exact uncovered scope. Do not commit someone else's work to satisfy the runner.

Load [the handoff reference](references/review-handoff.md) only when session-only
context or follow-up decisions need transferring. Discover an available
`harness`, `.harness/bin/harness`, or source executable; consult its help for
flags rather than guessing commands. For example:

```bash
printf '%s\n' "$HANDOFF" | harness run change-review --workspace /path/to/repo --base main --head HEAD --handoff-stdin --verbose
```

Include `--plan` when a plan exists. By default run both `implementation` and
`quality` for initial full coverage. An explicitly limited role request proves
only that role, not full approval. If the runner is unavailable, state that
limit; use a direct available reviewer only when the requested deliverable
allows it, never claim Harness ran.

## Triage and continue

Read structured reviewer JSON and run metadata/summary. Streams are diagnostics,
not verdict authority. Merge duplicate issues while preserving provenance.
Give each material issue an evidence-backed `Implement`, `Adapt`, or `Decline`
disposition. A reviewer preference cannot redefine accepted scope.

Blockers must establish a changed-code regression, unmet acceptance, hard
invariant violation, or required missing proof. Optional polish and pre-existing
debt do not block. New evidence of a material defect is valid on follow-up even
when an earlier review missed it; explain why it changes the decision. Do not
reopen settled preferences without new evidence.

When fixes are authorized, apply the smallest accepted corrections, fix failures
caused by them, and run focused checks plus required gates. Continue without
asking for approval at each iteration. Otherwise return findings and proposed
corrections without editing. Material scope expansion or a new human decision
pauses only the affected correction.

After any code edit, always rerun `implementation`. Add `quality` when the fix
changes clarity, conventions, maintainability, or tests. If no code changed,
retry only failed roles. Use `--steps <ids>` and explain why omitted roles remain
covered. Preserve all review artifacts and accepted dispositions.

## Completion

Use at most three total runs: initial plus two follow-ups. Stop with unresolved
blockers or failed coverage when the budget is exhausted; do not restart the
counter by naming another workflow.

Approve only with completed initial coverage, a passing implementation review
of the current head, and no `must_fix` findings. `needs_changes` requires at
least one must-fix; advisories may accompany `pass`. A failed or `blocked`
reviewer means incomplete coverage, not approval. Report the reviewed revision,
observed checks, dispositions, and remaining blockers. Publication is separate
and requires its own task authority.
