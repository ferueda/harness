# Plan 260626-session-index-analysis: Add provider-neutral session index analysis

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: dev/plans/260625-cursor-sessions-self-improve.md
- **Category**: dx

## Why this matters

Layer 1 creates a normalized session cache, but it does not yet help us learn
whether the cache is good enough. We need a lightweight analysis command that
mines the indexed data for repeated phrases, missing fields, weak workspace
path confidence, and suspicious automation/subagent classifications. This
should improve the index with evidence, not guesses, while keeping full
semantic or LLM-driven analysis out of scope.

This plan also preserves the bridge to the original jxnl-style self-improve
idea. The upstream `self_improve.py` uses exact lexical markers such as
preference words, noise filters, project-context tokens, and support thresholds
to find durable user preferences. This plan does **not** implement preference
mining yet; it first audits the indexed Cursor data so the later self-improve
layer can choose markers from evidence instead of copying another repo's word
lists blindly.

## Current state

- `bin/sessions.ts` exposes provider-scoped Cursor commands:
  `sessions cursor reindex|list|show|export|stats`.
- `lib/sessions/core/cache.ts` reads and writes
  `~/.harness/session-index/cursor.jsonl` plus `meta.json`.
- `lib/sessions/core/types.ts` defines normalized `SessionRecord` data:
  provider, session id, workspace key/path, title, timestamps, automation flags,
  first user query, turn counts, and source file paths.
- `lib/sessions/core/filters.ts` already provides provider-neutral filtering
  over cached session records.
- `lib/sessions/cursor/classify.ts` currently uses exact lexical markers:
  `"You are running as an automated worker"` and
  `"Hard requirements for your FINAL answer"`.
- `lib/sessions/cursor/stats.ts` reports aggregate counts, but not pattern
  candidates or samples.
- The deferred self-improve layer should eventually use a jxnl-style pattern:
  preference markers, skip/noise filters, sentence splitting, normalization,
  bucket classification, and support thresholds. This plan should emit enough
  lexical evidence to decide which of those markers belong in harness.

The new command must be top-level and provider-neutral:

```bash
sessions analyze --provider cursor
sessions analyze --provider cursor --format json
```

Do not add `sessions cursor analyze` in this plan. A provider alias can be added
later if it proves useful.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Sessions tests | `pnpm test -- test/sessions` | all sessions tests pass |
| CLI tests | `pnpm exec vitest run test/cli.test.ts` | CLI tests pass |
| Build | `pnpm run build` | exit 0 |
| Full gate | `make check` | exit 0 |

## Suggested executor toolkit

| Skill / resource | Use for |
| --- | --- |
| `implement-plan` | Execute this plan phase by phase |
| `.agents/skills/typescript-refactor` | Keep provider-neutral result types explicit and narrow |
| `.agents/skills/zod` | Validate JSON output shape if schemas are added |
| `.agents/skills/vitest` | Add focused fixture tests without shared mutable state |
| `.agents/skills/node` | Preserve Node 24 ESM/type-stripping-compatible style |

## Scope

**In scope**:

- `bin/sessions.ts` — add top-level `analyze` command.
- `lib/sessions/core/analyze.ts` — provider-neutral analysis over
  `SessionRecord[]`.
- `lib/sessions/cursor/analyze.ts` — Cursor-specific suspicious samples and
  marker candidate analysis.
- `lib/sessions/core/factory.ts` — use existing provider factory if needed.
- `test/sessions/**` — unit tests and CLI-style behavior tests.
- `test/fixtures/sessions/**` — add fixtures only if existing fixtures are not
  enough.
- `dev/plans/README.md` — update status when implemented.

**Out of scope**:

- No LLM calls, embeddings, vector stores, or semantic similarity.
- No self-improve proposals, skill edits, AGENTS.md edits, or Cursor rule
  proposals.
- No full-transcript scan unless a cache-only metric cannot be computed from
  `SessionRecord`.
- No auto-patching classifier markers.
- No Codex provider implementation.
- No `sessions cursor analyze` alias.
- No changes to `harness` review workflows.

## Steps

### Step 1: Define provider-neutral analysis result types

Create `lib/sessions/core/analyze.ts`.

Add exported types and a pure function:

```ts
export type SessionAnalysis = {
  provider: SessionProviderId | "all";
  totalSessions: number;
  missing: {
    title: number;
    firstUserQuery: number;
    updatedAtMs: number;
  };
  classifications: {
    automation: number;
    subagent: number;
    realUser: number;
  };
  workspacePathConfidence: Record<WorkspacePathConfidence, number>;
  topFirstQueryPrefixes: PhraseCount[];
  topFirstQueryWords: PhraseCount[];
  candidatePreferenceMarkers: PhraseCount[];
  candidateNoiseMarkers: PhraseCount[];
};

export function analyzeSessions(
  sessions: readonly SessionRecord[],
  options?: { provider?: SessionProviderId | "all"; limit?: number },
): SessionAnalysis;
```

Keep tokenization simple and deterministic:

- lowercase
- split on non-alphanumeric boundaries
- ignore words shorter than 3 characters
- ignore a small local stop-word set in this file
- count query prefixes using the first 120 normalized chars of
  `firstUserQuery`
- compute marker candidates from first-query snippets only; do not infer user
  preferences or write proposals

**Verify**: `pnpm typecheck` exits 0.

### Step 2: Add Cursor-specific analysis

Create `lib/sessions/cursor/analyze.ts`.

Add a function that accepts cached `CursorSession[]` and returns Cursor-only
signals:

- unflagged sessions whose `firstUserQuery` contains likely automation terms:
  `automated`, `worker`, `final answer`, `hard requirements`, `workflow`,
  `handoff`, `review`
- sessions with `workspacePathConfidence === "decoded"`
- sessions with missing title but present first query
- candidate marker phrases from repeated first-query prefixes
- candidate self-improve markers, grouped separately:
  - preference-like words/phrases: `prefer`, `always`, `never`, `default to`,
    `make sure`, `I want you to`, `don't`, `do not`
  - noise/skip words/phrases: `diff`, `review`, `workflow`, `handoff`,
    `automated worker`, `final answer`, `AGENTS.md instructions`
- short samples showing why a candidate might be useful for a later
  self-improve preference miner

Return bounded samples, not entire transcripts. Include `sessionId`,
`workspacePath`, `title`, `firstUserQuery` snippet, and reason.

Do not hard-code these candidates into `lib/sessions/cursor/classify.ts` during
this plan. The output is an evidence report for a future plan.

**Verify**: `pnpm typecheck` exits 0.

### Step 3: Add `sessions analyze`

In `bin/sessions.ts`, add a top-level command:

```bash
sessions analyze --provider cursor --format table
sessions analyze --provider cursor --format json
```

Rules:

- `--provider` accepts `cursor` for now. Reject `codex` and `all` until those
  providers have cache readers.
- Default `--provider cursor`.
- `--format` accepts `table|json`, default `table`.
- Read the provider cache only; do not reindex automatically.
- Table output should show counts, top prefixes, top words, and Cursor-specific
  sample sections.
- Include a "Self-improve marker candidates" section with preference-like
  markers and noise/skip markers. It should be explicitly labeled as
  informational and not applied automatically.
- JSON output should include the full structured analysis result.

**Verify**:

```bash
pnpm run build
node dist/bin/sessions.js analyze --provider cursor --format json
```

Expected: command exits 0 when a cursor cache exists and prints JSON with
`provider: "cursor"`.

### Step 4: Add tests

Add focused tests under `test/sessions/`:

- core analyzer counts missing fields and classifications
- core analyzer returns stable top words and prefixes
- Cursor analyzer reports likely unflagged automation samples
- Cursor analyzer reports preference-like marker candidates separately from
  noise/skip marker candidates
- CLI rejects unsupported providers
- CLI JSON output is parseable

Model fixture setup after existing `test/sessions/cursor/*.test.ts` files:
temp dirs, injected `SessionEnvironment`, and no reads from the developer's
live `~/.cursor`.

**Verify**: `pnpm test -- test/sessions` passes.

### Step 5: Update docs and plan index

Update `dev/plans/README.md` only after implementation:

- mark this plan `done`
- keep `260625-cursor-sessions-self-improve.md` as the Layer 1 dependency

**Verify**: `git diff -- dev/plans/README.md` shows only the intended status
change.

## Test plan

- Unit tests for pure analyzer functions should not touch the filesystem.
- CLI tests should write a small cache into a temp `HOME` or injected cache root
  if the current CLI has a test seam by then.
- Include at least one session that looks like automation but has
  `isAutomation: false`, and verify it appears as a suspicious sample.
- Include at least one decoded workspace path and verify it is counted.
- Include at least one preference-like query (`prefer`, `always`, or `make
  sure`) and one worker/review query; verify they land in separate candidate
  groups.

## Done criteria

- [ ] `sessions analyze --provider cursor` exists as a top-level command.
- [ ] `sessions analyze --provider cursor --format json` returns parseable JSON.
- [ ] Core analyzer works over `SessionRecord[]` without Cursor imports.
- [ ] Cursor-specific analyzer is isolated under `lib/sessions/cursor/`.
- [ ] Output includes self-improve marker candidates as evidence only.
- [ ] Output separates preference-like markers from noise/skip markers.
- [ ] No semantic search, embeddings, LLM calls, or full-transcript scanning.
- [ ] No self-improve proposal generation or file-edit suggestions.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm test -- test/sessions` exits 0.
- [ ] `pnpm run build` exits 0.
- [ ] `make check` exits 0.
- [ ] `dev/plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- The Layer 1 cache shape is changed or unavailable.
- The analysis needs transcript body content, not just indexed fields.
- Marker candidates require copying the upstream jxnl word lists wholesale
  instead of deriving useful harness-specific evidence from indexed data.
- Supporting `all` or `codex` requires implementing a Codex cache reader.
- CLI tests require invasive changes outside `bin/sessions.ts` or session libs.

## Maintenance notes

This command is evidence-gathering for future classifier/index improvements.
Reviewers should scrutinize whether reported markers are deterministic,
bounded, and explainable. If future work adds semantic analysis, put it behind a
separate plan and keep this lexical analyzer fast and local.

The intended follow-up after this plan is a separate self-improve plan. That
later plan may use jxnl-style preference markers, skip/noise filters, sentence
normalization, bucket classification, and support thresholds, but it should take
its first marker set from this analyzer's observed data rather than assuming the
upstream script's words are correct for Cursor/harness sessions.
