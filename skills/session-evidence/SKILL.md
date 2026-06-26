---
name: session-evidence
description: Use when extracting information from local agent session history with `sessions analyze --include-turns`, searching transcript turns with `--turn-query`, using `--extract-only`, or inspecting snippets, artifacts, matched queries, session ids, and turn indexes.
---

# Session Evidence

Use `sessions analyze --provider cursor|codex --include-turns --extract-only`
as a local session extraction tool. It returns transcript snippets, artifacts,
and provenance; keep interpretation separate from extraction.

## Workflow

1. Start narrow. Choose `--days`, `--workspace`, `--query`, or repeatable
   `--turn-query` before scanning transcript evidence.
2. Use `--turn-query` when you need actual user-turn text, such as `verify`,
   `how to`, `review`, `test`, or `debug`.
3. Use `--extract-only` for investigation so index metadata does not bury the
   matching turns.
4. Scan table output first. Use `--evidence-limit` to keep the table small.
   Use `--format json` when handing extracted evidence to another agent.
5. Inspect `matches`, `matchedQueries`, `artifacts`, `sessionId`, and
   `turnIndex`.
6. Open the source only when snippets are not enough:
   `sessions cursor show <sessionId>` or `sessions codex show <sessionId>`.
7. Report extracted facts first; label any interpretation separately.

## Modes

- Targeted lookup: `--extract-only --turn-query <term>` returns matching user
  turns without index-analysis sections.
- Related terms: repeat `--turn-query`; matching uses OR semantics and
  `matchedQueries` records the exact terms that hit.
- Broad scan: omit `--turn-query` to get grouped `patterns`; use this when you
  do not yet know the terms to search.
- Metadata filter: use `--query` for title, id, workspace, or first user query;
  it does not search all transcript turns.
- Diagnostics: add `--include-automation` only when worker/subagent sessions
  are part of the question.

## Command Patterns

Recent workspace scan:

```bash
sessions analyze --provider cursor --include-turns --extract-only --days 30 --workspace /path/to/repo
```

Use Codex history:

```bash
sessions codex reindex
sessions analyze --provider codex --include-turns --extract-only --turn-query "verify"
```

Find turns mentioning verification:

```bash
sessions analyze --provider cursor --include-turns --extract-only --turn-query "verify"
```

Find how-to questions:

```bash
sessions analyze --provider cursor --include-turns --extract-only --turn-query "how to" --days 30
```

Find related exact terms:

```bash
sessions analyze --provider cursor --include-turns --extract-only --turn-query "verify" --turn-query "validate" --turn-query "check"
```

JSON handoff:

```bash
sessions analyze --provider cursor --include-turns --extract-only --turn-query "review" --format json
```

Small table preview:

```bash
sessions analyze --provider cursor --include-turns --extract-only --turn-query "review" --evidence-limit 5
```

`--query` filters sessions by indexed metadata: title, id, workspace, or first
user query. `--turn-query` searches user-turn transcript text.

Running `--include-turns` without `--days`, `--workspace`, `--query`, or
`--turn-query` scans all matching cached transcripts and prints a warning.

## Recommendations

- Prefer exact words and short phrases. Try adjacent terms when a phrase returns
  zero matches, such as `verify`, `validate`, and `check`.
- Use repeatable `--turn-query` for synonyms instead of broadening into fuzzy
  or semantic search.
- Keep table output small with `--evidence-limit`; JSON keeps the full
  `matches` and artifact arrays for agent handoff.
- Use `sessions cursor show <sessionId>` for the 1-2 most relevant matches
- Use `sessions cursor show <sessionId>` or `sessions codex show <sessionId>`
  for the 1-2 most relevant matches instead of opening every result.
- Codex indexing uses `~/.codex/state_5.sqlite` as the source of truth and only
  falls back to `~/.codex/sqlite/state_5.sqlite` if the root DB is missing.
- Codex metadata/evidence may clean a leading injected first-turn preamble
  using the DB first user message. Use `sessions codex show <sessionId>` when
  raw rollout transcript fidelity matters.
- Treat `patterns` as recurrence hints only. Do not treat output as a
  recommendation.

## Useful Questions

- What user turns match this term?
- Which snippets show the repeated request?
- Which files, commands, PRs, branches, plans, or URLs appear?
- Which session ids and turn indexes should be opened for more context?
- Which requested information is missing from snippets and needs
  `sessions cursor show` or `sessions codex show`?

## Reading Output

- `matches`: flat turn-query hits with snippets, artifacts, and provenance.
- `matchedQueries`: exact query terms that matched that user turn.
- `patterns`: grouped broad-scan evidence; treat support as recurrence, not
  importance.
- `artifacts`: extracted paths, commands, PRs, branches, plans, and URLs.
- `turnIndex`: full transcript turn index, including assistant and tool turns.
- `--evidence-limit`: caps table match rows and pattern examples/artifacts; it
  does not truncate JSON `matches`.

Keep privacy boundaries: summarize sensitive snippets; do not quote secrets,
tokens, or private transcript text.

## Report

Include:

- `Commands run`
- `Filters used`
- `Matching snippets`
- `Artifacts found`
- `Session ids / turn indexes`
- `Missing context`
