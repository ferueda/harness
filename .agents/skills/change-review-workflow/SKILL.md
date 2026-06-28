---
name: change-review-workflow
description: Run and close the harness `change-review` workflow for current code changes. Use when the user asks to run a review, run a full review, run a review for these changes, run the change review workflow, run a harness review, run a multi-agent review, or compile and act on harness reviewer results. If the requested steps are not explicit, run all change-review steps.
---

# Change Review Workflow

Coordinate harness review runs and close the loop on reviewer findings.

## Workflow Choice

- Default to `change-review`, which runs all review roles:
  - `implementation`: correctness, plan/spec fit, behavioral regressions, missing tests.
  - `quality`: clarity, conventions, maintainability, behavior-preserving refinements.
  - `simplify`: unnecessary complexity and smaller equivalent shapes.
- Use `--steps <ids>` only when the caller intentionally selected roles, or on a follow-up run where you intentionally skip a role that already passed. Record the skip reason.

## Preferred Runtime

- Use Cursor SDK for `harness run change-review` (default provider).
- Include `--verbose` for day-to-day agent and automation runs so callers receive live workflow events while reviewers are still running.
- For Codex-backed review, use `--agent codex`; keep default `read-only`, `never`, and `high` unless the caller explicitly requests otherwise.

## Before Running

1. Compose a self-contained review handoff using [references/review-handoff.md](references/review-handoff.md). Completion criterion: a reviewer can understand the goal, scope, changed files, verification, and scrutiny points without chat history.
2. Pipe that handoff through stdin with `--handoff-stdin`. Do not write a handoff file into the target repo; harness writes the reviewer-facing file under the ignored run artifact directory.
3. Confirm Git review scope. Harness reviews `merge-base(base, head)..head`; unstaged, staged-but-uncommitted, and untracked files are excluded unless `head` points at a commit/tree containing them. If reviewing current worktree changes, create a temporary review ref or commit object and pass it with `--head`.
4. Include `--plan` when a plan/spec exists. Include `--workspace` when reviewing a repo other than the current one.

## Running

Use the available harness executable: `harness`, `.harness/bin/harness`, or `node bin/harness.ts` when working from this source repo.

```bash
printf '%s\n' "$HANDOFF" | harness run change-review --workspace /path/to/repo --base main --head HEAD --handoff-stdin --verbose
```

For a deliberate partial run:

```bash
printf '%s\n' "$HANDOFF" | harness run change-review --workspace /path/to/repo --base main --head HEAD --steps implementation,quality --handoff-stdin --verbose
```

Defaults: Cursor SDK `composer-2.5`; Codex SDK `gpt-5.5` with effort `high`. Use `--agent` or `--model` only when the caller asks or repo config requires it. Cursor SDK review models are constrained to `composer-2.5`, `claude-opus-4-8`, and `gpt-5.5`.

Run `harness models` before choosing a non-default model or checking the SDK params behind each mode.

## After Results

1. Read the run `summary.md`, `meta.json`, `events.jsonl` when `meta.eventsFile` is present, each reviewer JSON, and any `streamArtifacts` JSONL files under `.harness/runs/reviews/<run-id>/`.
2. Compile every finding from every completed reviewer. Preserve failed-reviewer details separately. Completion criterion: every reviewer finding and failure is accounted for exactly once.
3. Triage each finding as `Implement`, `Adapt`, or `Decline`. Back each decision with code-backed reasoning.
4. Apply accepted fixes yourself after triage. Keep reviewer agents read-only.
5. Run focused verification for the accepted fixes. Add regression tests for bugs when they fit.
6. Re-run `change-review` after material fixes. For follow-up cycles, decide whether to run all roles or use `--steps` to omit prior passing roles. Make that decision explicitly from the prior results and current change scope.

## Result Rules

- Treat `needs_changes` plus any `must_fix: true` finding as requiring action or a documented decline.
- Treat `blocked` or failed reviewers as incomplete review coverage; inspect preserved successful results, then decide whether to fix the blocker or re-run.
- Advisory findings may be declined, but only with a reason tied to scope, behavior, risk, or repo convention.
- On reviewer failure, read `meta.json` first. If `streamArtifacts.<stage>.status` is `written`, inspect the referenced `*.stream.jsonl`.
- For live caller feedback, run with `--verbose`; stdout remains final meta JSON, while stderr emits workflow events as JSONL.
- Callers that consume `--verbose` stderr should parse JSON object lines only. Durable truth remains `<runDir>/events.jsonl`.
- Use `events.jsonl` for the step timeline, including starts, heartbeats, ends, elapsed time, and output artifact paths.
- Use stream logs for forensics: tool activity, partial assistant output, timeout location, and SDK event order.
- Do not use stream logs as verdict sources. Verdicts come from `*-review.json` or the final raw provider artifact.
