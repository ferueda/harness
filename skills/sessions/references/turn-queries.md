# Turn-query starters

Recommended `--turn-query` terms for exploration and research. Repeat flags use **OR** semantics; `matchedQueries` shows which term hit.

**Not for workflow audits** — skill-name scans live in [audit-examples.md](audit-examples.md).

## Rules

1. Start with one category below (2–5 terms), not the whole list.
2. Zero matches → try adjacent terms in the same category, or a broad scan without `--turn-query` and read `patterns`.
3. Prefer short exact phrases. No fuzzy or semantic search.
4. Reindex first, then discover the stored workspace and canonical id with
   `sessions <provider> list`. Combine `--days`, literal `--workspace` path
   prefixes, exact `--session-id`, and `--extract-only` before opening full
   transcripts. Add `--include-subagents` when child work is in scope.
5. Label interpretation separately from match counts.

`--query` is fuzzy metadata discovery, including partial ids; do not use it for
exact targeting. Search user evidence with `--turn-query`; inspect assistant or
tool context with `sessions <provider> show <id> --turn <index> --context <n>`
or `export`.

```bash
sessions analyze --provider codex --include-turns --extract-only \
  --workspace /path/to/repo --days 30 \
  --turn-query "verify" --turn-query "validate" --turn-query "check" \
  --format json
```

## Verification

`verify`, `validate`, `check`, `confirm`, `test`

Use when looking for test runs, acceptance checks, or “did this work?” turns.

## How / why

`how to`, `why`, `what is`, `explain`

Use when mining learning questions, architecture explanations, or onboarding-style threads.

## Problems

`debug`, `error`, `fails`, `broken`, `bug`

Use when tracing incidents, regressions, or flaky behavior. Pair with artifact paths in output.

## Research

`explore`, `investigate`, `find`, `where is`, `how does`

Use when the user was orienting in the codebase before acting. Good for “what did we look at?” sessions.

## Planning

`plan`, `implement`, `create plan`, `audit`

Use for plan-build cycles and portfolio surveys. For skill routing audits, switch to [audit-examples.md](audit-examples.md) skill names (`planning-workflow`, `create-plan`, …).

## Review

`review`, `adversarial`, `change-review`

Use for spec/plan validation and post-implementation review threads. Harness-injected `review-implementation` text can inflate counts — prefer `isFirstUserTurn` and explicit user phrasing.

## Preferences and corrections

Inspired by repeated user instruction mining — turns that often contain durable workflow preferences:

`make sure`, `prefer`, `instead of`, `do not`, `don't`, `never`, `always`, `default to`, `should be`, `preserve`

Use when looking for recurring corrections to skills, `AGENTS.md`, or process — not one-off task asks. Inspect 1–2 hits with `sessions show` before treating as a pattern.

## Persistence and friction

`continue`, `keep going`, `don't stop`, `come on`, `can't you just`

Use when studying autonomy boundaries: where the agent stopped early or the user had to nudge. High signal for coordinator and handoff improvements.

## Question shapes (exploration only)

Common user-turn openings — useful for research, usually **not** durable preferences on their own:

`how should`, `how do you`, `can you look`, `could you look`, `what should`, `can you propose`

Search these when mapping how requests are phrased; follow up with `show` before proposing doc edits.

## Noise to down-rank

When interpreting snippets, deprioritize:

- Injected harness / reviewer boilerplate (`review-implementation`, `handoff`, `.harness/runs/`)
- Transient environment errors (`could not read from remote repository`, `repository not found`)
- Pure assistant/tool dumps with no user preference (`diff hunk`, `review findings` as snippet-only hits)

## Category → next step

| Goal                     | Start with                            | Then                                                    |
| ------------------------ | ------------------------------------- | ------------------------------------------------------- |
| Find how we verify work  | Verification                          | Artifacts → commands, test output                       |
| Understand a bug arc     | Problems → Research                   | `sessions show` on 1–2 session ids                      |
| Map planning usage       | Planning + audit-examples skill names | Score against `planning-workflow/references/routing.md` |
| Find repeated user rules | Preferences and corrections           | Recurrence ≥ 2 before editing skills                    |
| Agent stopped too early  | Persistence and friction              | Check handoff and coordinator docs                      |
