# Agent harness — active roadmap

**Status:** `in_progress`  
**Updated:** 2026-06-28

## Goal

Multi-repo agent harness: one `harness` repo maintains skills, workflows, and runner code; runs against **target repos** via `--workspace`; persists audit artifacts under target `.harness/` (gitignored).

North star: durable orchestration (checkpointed steps, retries, triggers). **Inngest is Phase 2** — not a blocker for local `steps.json`, graders, or inbox work.

## Locked constraints

1. Single repo: `harness` owns instructions, workflows, runner, future orchestrator.
2. Always pass `--workspace <target-repo>`; never copy harness into each app.
3. Artifacts live in **target repo** `.harness/` — not in harness repo.
4. Code writes human reports (`summary.md`); LLMs produce structured JSON only.
5. Human gates on post-review triage and merge until explicitly changed.
6. **Skills** = `SKILL.md` instructions; **workflows** = runnable orchestration.

## Shipped (summary)

Live today: `harness run change-review` (implementation → quality → simplify), Cursor/Codex SDK reviewers, `events.jsonl` + `*.stream.jsonl`, handoff stdin, partial `--steps`, `harness init` + target shim, run prune, schema-aware JSON parse, install + skills install. Ad-hoc Cursor delegation: `skills/cursor-cli/` (standalone; not harness init).

Shipped work index: `dev/plans/README.md` (PR links; finished plans removed from tree).

## Pending phases

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **0.6** | `steps.json` resumability; artifact schema v1 | **Next** |
| **1c** | Deterministic grader; `digestReview()`; `REVIEW_RULES` | Pending |
| **1.5** | Triggers: GH Action → `.harness/inbox/review.json` | Pending |
| **2** | `orchestrator/` — Inngest; `onFailure`; concurrency per SHA | Pending |
| **2.5** | Capped fix-and-re-review loop | Pending |
| **3** | Hill-climbing meta-review → skill prompt PRs (human-gated) | Pending |

## Known gaps (today)

- Not durable: process death → full re-run.
- No `steps.json` — step status not persisted for restart.
- No `digestReview()` — full prior review JSON inlined where needed.
- No deterministic pre-checks (tests/lint) in review pipeline.
- No triggers — manual CLI only.

## Phase 0.6 / 1c contracts

### `steps.json` v1 (target)

Add alongside `meta.json` under `.harness/runs/reviews/<run-id>/`:

```json
{
  "runId": "20260621-143022-abc123",
  "schemaVersion": 1,
  "workspace": "/path/to/app",
  "scope": { "baseRef": "main", "headRef": "HEAD", "mergeBase": "abc...", "headSha": "def..." },
  "steps": [
    { "id": "prepare-context", "label": "step:prepare", "status": "completed", "outputs": ["context/diff.patch"] },
    { "id": "verify-tests", "label": "grader:test", "status": "pending" },
    { "id": "review-implementation", "label": "reviewer:impl", "status": "completed", "outputs": ["implementation-review.json"] }
  ],
  "verdict": null
}
```

**Semantics:**

- Statuses: `pending`, `running`, `completed`, `failed`, `skipped`.
- Write outputs to temp files, then rename into place.
- On restart: skip `completed` only when listed outputs exist; treat stale `running` as retryable.
- Future Inngest `step.run()` IDs align with `steps.json` step `id`.
- Optional v1 metadata: per-step `startedAt`, `durationMs`, `sessionId`; scope `diffChars`, `diffLines`. See `meta.json`, `lib/workflow-context.ts`.
- Step IDs: `lib/workflow-events.ts` (`STEP_ID_BY_AGENT`) for reviewer steps; reserve `prepare-context` and `verify-tests` (`grader:test`) for Phase 0.6 / 1c.

### Grader contract (Phase 1c)

- CLI: `--test-command` or auto-detect package scripts.
- Output: `{ id, status, command, exitCode, durationMs, stdoutPath, stderrPath }`.
- Large stdout/stderr → files, not `steps.json`.
- Missing command → `skipped`; failing command → `failed`.

### `digestReview()` (Phase 1c)

Compress prior review JSON to ~500 tokens (verdict, summary, findings by severity) for downstream prompts. Full JSON stays on disk for `change-review-workflow` triage.

## Next steps (ordered)

1. **`steps.json` resumability** — Phase 0.6; align step IDs with `events.jsonl`.
2. **`digestReview()`** — before quality-review consumes prior review output.
3. **One deterministic grader** (`grader:test`) with `--test-command`.
4. **Parse resilience** — [FER-33](https://linear.app/ferueda/issue/FER-33/improve-reviewer-json-parse-resilience).
5. **Extract `runSingleReview` / `finalizeReview`** from `runReviewSteps` — prerequisite for Inngest lib import.
6. **Inbox trigger** — GH Action writes `.harness/inbox/review.json`.
7. **`orchestrator/`** — Inngest function per workflow; start with `change-review`.
8. **`onFailure` notifier** — file sink first.
9. **Phase 2.5** — capped fix-and-re-review loop.

## Open items

| Item | Notes |
|------|-------|
| Inngest hosting | Self-hosted vs cloud — decide before Phase 2 |
| Per-step CLI vs lib | Prefer lib import for orchestrator |
| Review Manager agent | Defer unless needed for post-review triage |
| SQLite artifact index | Defer until cross-run queries hurt |
| Parallel vs serial | Graders parallel; LLM steps serial when consuming digests |

## Assumptions (do not re-litigate)

1. Harness runs against target repos, not only itself.
2. Artifacts belong in target `.harness/`.
3. `harness` is the single source of truth — migration done.
4. Durability (Inngest) is Phase 2, not blocking graders or inbox.
5. Human gates on review reaction and merge remain until changed.

## Key paths

```
bin/harness.ts
workflows/change-review.workflow.ts
workflows/review-steps.ts
lib/workflow-context.ts
lib/aggregate.ts
providers/cursor/
providers/codex/
skills/
README.md
```

## Skills for the executor

| Step | Skill / resource |
|------|------------------|
| Workflow reference | `workflows/change-review.workflow.ts` |
| Review agents | SDK providers; ad-hoc `cursor-cli` skill outside harness |
| Review instructions | `review-implementation`, `code-quality-review`, `simplify-review` |
| Chat coordinator | `change-review-workflow` |
| Handoff | `handoff-work` — `--handoff`, `--handoff-stdin` |
| Post-review triage | `change-review-workflow` (After Results) |
| Phase 2 | Inngest docs; extract per-step runners first |
