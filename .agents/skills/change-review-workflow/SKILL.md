---
name: change-review-workflow
description: Run and close the harness `change-review` workflow for current code changes. Use when the user asks to run a review, run a full review, run a review for these changes, run the change review workflow, run a harness review, run a multi-agent review, or compile and act on harness reviewer results. If the requested steps are not explicit, run all change-review steps.
---

# Change Review Workflow

Decide whether the current implementation safely completes the original task.
Review converges on accepted scope; it does not turn the PR into a general
cleanup effort.

## Review contract

- Initial coverage runs all roles:
  - `implementation`: correctness, task and plan fidelity, contracts,
    regressions, and required behavioral tests.
  - `quality`: behavior-preserving clarity, simplicity, conventions, and
    maintainability, including smaller equivalent shapes for complexity
    introduced by the diff.
- Approval requires completed initial coverage, a passing implementation review
  of the current head, and no `must_fix` findings.
- `needs_changes` requires at least one `must_fix`. Advisory findings may
  accompany `pass`.
- `blocked` or a failed reviewer means incomplete coverage, not approval.
- Use at most three total runs: the initial run and two follow-ups. Remaining
  blockers after that are unresolved and require user direction.

## Before the initial run

1. Write the compact handoff from
   [references/review-handoff.md](references/review-handoff.md). Include only
   task context the diff and plan cannot provide.
2. Confirm scope. Harness reviews `merge-base(base, head)..head`; unstaged,
   staged-but-uncommitted, and untracked files are excluded. Use a temporary
   review ref or commit object when the current worktree must be included.
3. Include `--plan` when a plan exists and `--workspace` for another repo.
4. Run all roles through the available `harness`, `.harness/bin/harness`, or
   source checkout executable:

```bash
printf '%s\n' "$HANDOFF" | harness run change-review --workspace /path/to/repo --base main --head HEAD --handoff-stdin --verbose
```

## Triage

Read `meta.json`, `summary.md`, and every completed reviewer JSON. Read raw
or stream artifacts only for failed or ambiguous reviewers; use `events.jsonl`
when diagnosing the timeline.

Group duplicate findings by underlying issue while retaining reviewer
provenance. Reconcile conflicts among findings, the original task or accepted
plan, handoff context, and the diff using the authority and scope checks below.
Give each underlying issue an evidence-backed `Implement`, `Adapt`, or `Decline`
disposition. Decisions are issue-local; never apply one disposition to an
entire reviewer, run, or finding set. Advisories remain evidence by default;
adopt one only when it directly improves the original goal with low scope risk.

Before accepting any recommendation, confirm:

1. It serves the original goal or an accepted decision.
2. The diff introduced or worsened the problem, or the problem prevents an
   acceptance criterion or hard invariant.
3. It is required for safe acceptance.
4. The smallest correction stays inside accepted scope.

If a safe correction requires material scope expansion or a new product
decision, stop and ask the user. Do not let reviewer advice silently redefine
the task.

Apply only accepted in-scope fixes, then run focused verification. Add a
regression test when a bug fix needs one.

## Follow-up runs

After any code edit, always rerun `implementation`; add `quality` only when the
fix affects clarity, simplicity, conventions, maintainability, or tests. If no
code changed and a reviewer failed, retry only that role. Record why omitted
roles remain covered.

Use `--steps <ids>` for targeted follow-ups. A partial run passes only its
requested roles; it does not establish approval by itself.

The follow-up handoff names resolved blockers and settled decisions. Reviewers
may add a new blocker only when remediation introduced it or made it newly
observable. Do not reopen declined advisories or unchanged pre-existing debt.

## Completion

- **Approve**: required coverage complete for the current head; no blockers.
- **Needs changes**: in-scope blockers remain and another run is available.
- **Unresolved**: three runs exhausted, required scope expansion, human decision,
  blocked review, or reviewer failure that cannot be recovered.

Preserve all run artifacts. Structured reviewer JSON is verdict authority;
stream logs are diagnostics only.
