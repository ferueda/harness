---
name: sessions
description: >
  Browse and analyze local Cursor or Codex session history via the sessions CLI.
  Use sessions analyze for transcript lookup, workflow/skill usage audits, and
  evaluating planning or review routing against real sessions.
---

# Sessions

Skill-owned CLI for local agent session history.

Use `sessions analyze --provider cursor|codex --include-turns --extract-only`
for transcript snippets, artifacts, and provenance. Keep interpretation separate
from extraction.

## Install launcher

Requires Node >=24 and pnpm or Corepack.

From the loaded or installed skill root:

```bash
./scripts/install.sh
```

From a harness checkout:

```bash
skills/sessions/scripts/install.sh
```

The installer runs `pnpm install --ignore-workspace --prod --frozen-lockfile`
inside the skill directory, then symlinks `sessions` into `~/.local/bin` by
default. Override the bin directory with `SESSIONS_INSTALL_BIN`.

Or manually:

```bash
pnpm install --ignore-workspace --prod --frozen-lockfile
mkdir -p ~/.local/bin
ln -sf "$PWD/scripts/sessions.ts" ~/.local/bin/sessions
chmod +x scripts/sessions.ts
```

Ensure `~/.local/bin` is on `PATH` when using `install.sh`.

Direct run without install:

```bash
pnpm install --ignore-workspace --prod --frozen-lockfile
node scripts/sessions.ts --help
```

Session index cache defaults to `~/.sessions/index` (migrated automatically from
`~/.harness/session-index` on first use). Override with `SESSIONS_CACHE_DIR`.

## Workflow

1. Refresh the provider index before analysis. Use the provider you will query:
   `sessions cursor reindex` or `sessions codex reindex`.
2. Start narrow. Choose `--days`, `--workspace`, exact `--session-id`, fuzzy
   `--query`, or repeatable `--turn-query` before scanning transcript evidence.
3. Use `--turn-query` for user-turn text. Starter terms by goal:
   [references/turn-queries.md](references/turn-queries.md).
4. Use `--extract-only` for investigation so index metadata does not bury the
   matching turns.
5. Scan table output first. Use `--evidence-limit` to keep the table small.
   Use `--format json` when handing extracted evidence to another agent.
6. Inspect `matches`, `matchedQueries`, `artifacts`, `sessionId`, and
   `turnIndex`.
7. Open the source only when snippets are not enough:
   `sessions cursor show <sessionId>` or `sessions codex show <sessionId>`.
8. Report extracted facts first; label any interpretation separately.

## Modes

- Targeted lookup: `--extract-only --turn-query <term>` returns matching user
  turns without index-analysis sections.
- Related terms: repeat `--turn-query`; matching uses OR semantics and
  `matchedQueries` records the exact terms that hit.
- Broad scan: omit `--turn-query` to get grouped `patterns`; use this when you
  do not yet know the terms to search.
- Exact target: use `--session-id <id>`; it is exact equality and composes with
  `--days` and `--workspace`.
- Metadata discovery: `--query` fuzzily matches title, id, workspace, or first
  user query; it does not search all transcript turns. Use a returned id with
  `--session-id` for exact targeting.
- Diagnostics: `--include-automation` includes automation sessions only and
  `--include-subagents` includes subagent sessions only. Defaults exclude both;
  pass both flags for a session classified as both.

## Command Patterns

Recent workspace scan:

```bash
sessions cursor reindex
sessions analyze --provider cursor --include-turns --extract-only --days 30 --workspace /path/to/repo
```

Use Codex history:

```bash
sessions codex reindex
sessions analyze --provider codex --include-turns --extract-only --turn-query "verify"
```

Find turns mentioning verification:

```bash
sessions cursor reindex
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

Exact executor lookup:

```bash
sessions codex reindex
# Discover the stored workspace and canonical id; add --include-subagents for child work.
sessions codex list --include-subagents --query "executor"
# `--workspace` is a literal path prefix; use the stored path exactly.
sessions analyze --provider codex --include-turns --extract-only \
  --session-id <id> --workspace /path/to/repo --include-subagents
```

`--turn-query` evidence contains user turns. Use `show` or `export` to inspect
assistant and tool turns. Full `show` remains the default; bounded inspection
keeps canonical indexes:

```bash
sessions codex show <id> --turn 12 --context 2 --max-tool-chars 1000
```

`--query` filters sessions by indexed metadata: title, id, workspace, or first
user query. It is discovery, not exact-id targeting. `--turn-query` searches
user-turn transcript text.

Running `--include-turns` without `--days`, `--workspace`, `--session-id`,
`--query`, or `--turn-query` scans all matching cached transcripts and prints a
warning.

## Recommendations

- Turn-query categories and examples: [references/turn-queries.md](references/turn-queries.md).
- Prefer exact words and short phrases. Try adjacent terms in the same category when a phrase returns zero matches.
- Use repeatable `--turn-query` for synonyms instead of broadening into fuzzy
  or semantic search.
- Keep table output small with `--evidence-limit`; JSON keeps the full
  `matches` and artifact arrays for agent handoff.
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
- Did planning or review workflows route to the expected skills?
- Which skills have zero invokes over 90 days?

## Evaluation

Workflow and skill audits: [references/audit-examples.md](references/audit-examples.md). Exploration turn queries: [references/turn-queries.md](references/turn-queries.md). Coordinator fixtures (e.g. `planning-workflow/references/routing.md`) define expected routing.

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
