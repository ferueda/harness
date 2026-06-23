---
name: review-pipeline
description: >
  Run a sequential dual-review pipeline: review-implementation then code-quality-review
  via headless Cursor agents. Persists structured artifacts under .agent-runs/reviews/.
  Trigger when the user says "dual review", "run review pipeline", "review this branch
  with both reviewers", or after implement-plan before merge.
---

# Review Pipeline

Sequential, read-only dual review for a git diff:

1. **review-implementation** — adversarial correctness and plan adherence
2. **code-quality-review** — clarity, conventions, maintainability (sees reviewer 1 output)

Phase 0: file-based orchestration via `run-dual-review.mjs` + `cursor-cli`. No durable scheduler yet.

## When to Use

- After `implement-plan` + `handoff-work`, before merge
- Manual branch review with both reviewer personas
- Dogfooding the review chain before adding Inngest/cron (Phase 2)

## Prerequisites

- `agent` on PATH (`agent login` or `CURSOR_API_KEY`)
- `skills/cursor-cli` available (bundled in this repo or at `~/.agents/skills/cursor-cli`)
- Target workspace is a git repo with `main` (or pass `--base`)

## Usage

```bash
# Dry-run: prepare context + prompts only (no LLM calls)
node skills/review-pipeline/scripts/run-dual-review.mjs \
  --workspace /path/to/target-repo \
  --dry-run

# Full run against current branch vs main
node skills/review-pipeline/scripts/run-dual-review.mjs \
  --workspace /path/to/target-repo \
  --base main \
  --head HEAD

# With plan + handoff artifacts
node skills/review-pipeline/scripts/run-dual-review.mjs \
  --workspace /path/to/target-repo \
  --plan dev/plans/250621-feature.md \
  --handoff .agent-runs/handoff.md
```

**Exit codes:** `0` aggregate pass, `1` needs_changes/blocked or reviewer failure, `2` usage error.

## Output

Artifacts under `<workspace>/.agent-runs/reviews/<run-id>/`:

| File | Purpose |
|------|---------|
| `meta.json` | Run metadata, verdict, session IDs |
| `summary.md` | Human-readable rollup |
| `implementation-review.json` | Reviewer 1 structured output |
| `quality-review.json` | Reviewer 2 structured output |
| `context/diff.patch` | Reviewed diff |
| `context/plan.md` | Copied plan (if provided) |
| `*.prompt.md` | Rendered prompts (debug) |

## Aggregate verdict

- `blocked` if either reviewer is blocked
- `needs_changes` if either reviewer needs changes or any finding has `must_fix: true`
- `pass` only when both reviewers pass

## Next steps (later phases)

- Phase 1: wire `handoff-work` template + `react-to-review` on aggregated JSON
- Phase 2: Inngest wrapper with `step.run()` checkpointing per reviewer

## Tests

```bash
node --test skills/review-pipeline/scripts/run-dual-review.test.mjs
```
