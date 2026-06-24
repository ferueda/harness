---
name: change-review-workflow
description: Run and close the harness `review` or `review-full` workflow for current code changes. Use when the user asks to run a review, run a full review, run review-full, run a review for these changes, run the change review workflow, run a harness review, run a multi-agent review, or compile and act on harness reviewer results. If the requested workflow is not explicit, use `review`, not `review-full`.
---

# Change Review Workflow

Coordinate harness review runs and close the loop on reviewer findings.

## Workflow Choice

- Default to `review` unless the user explicitly asks for `review-full`.
- Use `review` for the normal gate: `review-implementation` plus `code-quality-review`.
- Use `review-full` only when requested, or when the user explicitly wants the extra read-only simplification pass.

## Before Running

1. Create a self-contained review handoff using [references/review-handoff.md](references/review-handoff.md). Completion criterion: a reviewer can understand the goal, scope, changed files, verification, and scrutiny points without chat history.
2. Confirm the Git review scope. Harness reviews `merge-base(base, head)..head`; unstaged, staged-but-uncommitted, and untracked files are not included unless `head` points at a commit/tree that contains them. If reviewing current worktree changes, create an explicit temporary review ref or commit object and pass it with `--head`.
3. Save the handoff in the target repo and pass it with `--handoff`. The workflow sends that same context to every reviewer; do not rely on chat history.
4. Include `--plan` when a plan/spec exists. Include `--workspace` when reviewing a repo other than the current one.

## CLI

Installed package:

```bash
harness run review --workspace /path/to/repo --handoff /path/to/handoff.md
```

Local harness source:

```bash
node bin/harness.ts run review --workspace /path/to/repo --handoff /path/to/handoff.md
```

Built local package:

```bash
node dist/bin/harness.js run review --workspace /path/to/repo --handoff /path/to/handoff.md
```

Explicit full review:

```bash
harness run review-full --workspace /path/to/repo --handoff /path/to/handoff.md
```

Useful flags:

- `--base <ref>` and `--head <ref>` set the diff range.
- `--plan <path>` gives reviewers the implementation plan or spec.
- `--dry-run` writes prompts/context without running reviewer agents.
- `--runs-dir <path>` overrides the default `.harness/runs/reviews` output root.

## After Results

1. Read the run `summary.md`, `meta.json`, and each reviewer JSON under `.harness/runs/reviews/<run-id>/`.
2. Compile every finding from every completed reviewer. Preserve failed-reviewer details separately. Completion criterion: every reviewer finding and failure is accounted for exactly once.
3. Triage each finding as `Implement`, `Adapt`, or `Decline`. The final call is yours; back each decision with code-backed reasoning.
4. Apply accepted fixes yourself after triage. Keep reviewer agents read-only.
5. Run focused verification for the accepted fixes. Add regression tests for bugs when they fit.
6. Re-run `review` after material fixes. Use `review-full` on re-run only if it was explicitly requested for the original pass.

## Result Rules

- Treat `needs_changes` plus any `must_fix: true` finding as requiring action or a documented decline.
- Treat `blocked` or failed reviewers as incomplete review coverage; inspect preserved successful results, then decide whether to fix the blocker or re-run.
- Advisory findings may be declined, but only with a reason tied to scope, behavior, risk, or repo convention.
