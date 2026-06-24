---
name: change-review-workflow
description: Run and close the harness `change-review` workflow for current code changes. Use when the user asks to run a review, run a full review, run a review for these changes, run the change review workflow, run a harness review, run a multi-agent review, or compile and act on harness reviewer results. If the requested steps are not explicit, run all change-review steps.
---

# Change Review Workflow

Coordinate harness review runs and close the loop on reviewer findings.

## Workflow Choice

- Default to `change-review`, which runs `implementation`, `quality`, and `simplify`.
- Use `--steps <ids>` only when the caller intentionally selects a subset.
- Valid step ids are `implementation`, `quality`, and `simplify`.
- In follow-up review cycles, the caller should decide whether a step that returned no findings in a previous run should be omitted. Do not infer that automatically; record the reason when you intentionally use `--steps`.

## Before Running

1. Create a self-contained review handoff using [references/review-handoff.md](references/review-handoff.md). Completion criterion: a reviewer can understand the goal, scope, changed files, verification, and scrutiny points without chat history.
2. Confirm the Git review scope. Harness reviews `merge-base(base, head)..head`; unstaged, staged-but-uncommitted, and untracked files are not included unless `head` points at a commit/tree that contains them. If reviewing current worktree changes, create an explicit temporary review ref or commit object and pass it with `--head`.
3. Prefer `--handoff-stdin` for generated handoffs. Harness writes the reviewer-facing file under the ignored run artifact directory. Use `--handoff <path>` only when a handoff file already exists.
4. Include `--plan` when a plan/spec exists. Include `--workspace` when reviewing a repo other than the current one.

## CLI

Installed package:

```bash
printf '%s\n' "$HANDOFF" | harness run change-review --workspace /path/to/repo --handoff-stdin
```

Local harness source:

```bash
printf '%s\n' "$HANDOFF" | node bin/harness.ts run change-review --workspace /path/to/repo --handoff-stdin
```

Built local package:

```bash
printf '%s\n' "$HANDOFF" | node dist/bin/harness.js run change-review --workspace /path/to/repo --handoff-stdin
```

Selected steps:

```bash
printf '%s\n' "$HANDOFF" | harness run change-review --workspace /path/to/repo --steps implementation,quality --handoff-stdin
```

Useful flags:

- `--base <ref>` and `--head <ref>` set the diff range.
- `--plan <path>` gives reviewers the implementation plan or spec.
- `--steps <ids>` runs only the selected change-review steps in workflow order.
- Prefer `--handoff-stdin` for generated handoffs; it gives reviewers shared context without requiring callers to create files.
- `--handoff <path>` remains available for existing handoff files.
- `--dry-run` writes prompts/context without running reviewer agents.
- `--runs-dir <path>` overrides the default `.harness/runs/reviews` output root.

## After Results

1. Read the run `summary.md`, `meta.json`, and each reviewer JSON under `.harness/runs/reviews/<run-id>/`.
2. Compile every finding from every completed reviewer. Preserve failed-reviewer details separately. Completion criterion: every reviewer finding and failure is accounted for exactly once.
3. Triage each finding as `Implement`, `Adapt`, or `Decline`. The final call is yours; back each decision with code-backed reasoning.
4. Apply accepted fixes yourself after triage. Keep reviewer agents read-only.
5. Run focused verification for the accepted fixes. Add regression tests for bugs when they fit.
6. Re-run `change-review` after material fixes. For follow-up cycles, decide whether to run all steps or use `--steps` to omit prior no-finding steps. Make that decision explicitly from the prior results and current change scope.

## Result Rules

- Treat `needs_changes` plus any `must_fix: true` finding as requiring action or a documented decline.
- Treat `blocked` or failed reviewers as incomplete review coverage; inspect preserved successful results, then decide whether to fix the blocker or re-run.
- Advisory findings may be declined, but only with a reason tied to scope, behavior, risk, or repo convention.
