---
name: session-evidence
description: Use when extracting information from local agent session history with `sessions analyze --include-turns`, searching transcript turns with `--turn-query`, or inspecting snippets, artifacts, session ids, and turn indexes.
---

# Session Evidence

Use `sessions analyze --include-turns --extract-only` as a local session
extraction tool. It returns transcript snippets, artifacts, and provenance;
keep interpretation separate from extraction.

## Workflow

1. Start narrow. Choose `--days`, `--workspace`, `--query`, or repeatable
   `--turn-query` before scanning transcript evidence.
2. Use `--turn-query` when you need actual user-turn text, such as `verify`,
   `how to`, `review`, `test`, or `debug`.
3. Use `--extract-only` for investigation so index metadata does not bury the
   matching turns.
4. Scan table output first. Use `--format json` when handing extracted evidence
   to another agent.
5. Inspect `matches`, `matchedQueries`, `artifacts`, `sessionId`, and
   `turnIndex`.
6. Open the source only when snippets are not enough:
   `sessions cursor show <sessionId>`.
7. Report extracted facts first; label any interpretation separately.

## Command Patterns

Recent workspace scan:

```bash
sessions analyze --provider cursor --include-turns --extract-only --days 30 --workspace /path/to/repo
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

`--query` filters sessions by indexed metadata: title, id, workspace, or first
user query. `--turn-query` searches user-turn transcript text.

Running `--include-turns` without `--days`, `--workspace`, `--query`, or
`--turn-query` scans all matching cached transcripts and prints a warning.

## Useful Questions

- What user turns match this term?
- Which snippets show the repeated request?
- Which files, commands, PRs, branches, plans, or URLs appear?
- Which session ids and turn indexes should be opened for more context?
- Which requested information is missing from snippets and needs
  `sessions cursor show`?

## Reading Output

- `matches`: flat turn-query hits with snippets, artifacts, and provenance.
- `matchedQueries`: exact query terms that matched that user turn.
- `patterns`: grouped broad-scan evidence; treat support as recurrence, not
  importance.
- `artifacts`: extracted paths, commands, PRs, branches, plans, and URLs.
- `turnIndex`: full transcript turn index, including assistant and tool turns.

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
