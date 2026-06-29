# Plan 260629-cursor-display-titles: Derive Cursor display titles from first query

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug

## Why this matters

The sessions skill is a lookup, audit, and handoff tool. Cursor Glass/agent
sessions often have transcripts under `~/.cursor/projects/*/agent-transcripts/`
without matching `~/.cursor/chats/*/*/store.db` metadata. Current indexing treats
those sessions as missing titles even when the transcript already has a usable
`firstUserQuery`, so `sessions analyze` reports noisy title gaps and JSON/cache
consumers get blank labels. The index should store a best display title and keep
provenance so missing `store.db` stays visible as metadata context, not a title
failure.

This is an index-time change. Existing cache rows will not be backfilled by
`readCachedSessions()` or `analyzeCursorSessions()`; users must run
`sessions cursor reindex` after the change lands.

## Current state

- `skills/sessions/lib/cursor/meta.ts` builds a metadata index only from
  `~/.cursor/chats` and reads `title` from `storeDb.meta.name`.

```ts
// skills/sessions/lib/cursor/meta.ts:37
export function buildCursorMetaIndex(env: SessionEnvironment): CursorMetaIndex {
  const chatsRoot = join(env.cursorHome, "chats");

// skills/sessions/lib/cursor/meta.ts:67
title: stringValue(storeDb.meta.name),
```

- `skills/sessions/lib/cursor/index.ts` parses the transcript and has
  `firstUserQuery`, but writes `title: meta.title` directly.

```ts
// skills/sessions/lib/cursor/index.ts:18
const parsed = parseTranscriptFile(file.jsonlPath);
const meta = await readCursorSessionMeta(metaIndex.get(file.chatId));

// skills/sessions/lib/cursor/index.ts:32
title: meta.title,
```

- `skills/sessions/lib/cursor/transcript.ts` already extracts transcript query
  text and has `stripInjectedBlocks()` for injected context.

```ts
// skills/sessions/lib/cursor/transcript.ts:41
firstUserQuery ??= userQuery ?? rawText;

// skills/sessions/lib/cursor/transcript.ts:60
export function stripInjectedBlocks(text: string): string {
```

- `skills/sessions/lib/core/analyze.ts` counts missing titles by checking only
  `session.title`.

```ts
// skills/sessions/lib/core/analyze.ts:103
missing: {
  title: countWhere(scopedSessions, (session) => !hasText(session.title)),
```

- `skills/sessions/scripts/sessions.ts` table output already falls back to
  `firstUserQuery`, so human display and JSON/cache semantics disagree.

```ts
// skills/sessions/scripts/sessions.ts:382
shorten(session.title ?? session.firstUserQuery ?? "", 36),
```

- Repo conventions:
  - Native Node TypeScript, ESM, `.ts` import extensions.
  - `skills/sessions/tsconfig.json` has `verbatimModuleSyntax`,
    `erasableSyntaxOnly`, `isolatedModules`, and `noEmit`.
  - Tests use Vitest with explicit imports from `vitest`, no globals.
  - Prefer small helpers beside the code that uses them; no duplicate V2 files.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Sessions typecheck | `cd skills/sessions && pnpm run typecheck` | exit 0, no TypeScript errors |
| Targeted tests | `cd skills/sessions && pnpm run test -- test/cursor/index.test.ts test/cursor/analyze.test.ts test/cli.test.ts test/core/cache.test.ts` | exit 0, all selected tests pass |
| Sessions full check | `cd skills/sessions && pnpm run check` | exit 0 |
| Root full gate | `pnpm run check` | exit 0 |

## Suggested executor toolkit

| Skill | Use for |
| --- | --- |
| `implement-plan` | Execute this plan phase by phase. |
| `sessions` | Reproduce `sessions analyze`/`sessions list` behavior and validate CLI wording. |
| `typescript-refactor` | Keep `titleSource` typing narrow and erasable; avoid enums/namespaces. |
| `vitest` | Add focused regression tests and update existing CLI/analyzer tests. |
| `node` | Preserve Node native TypeScript/type-stripping constraints. |

Verified skills exist in this repo or host skill list:
`skills/implement-plan/SKILL.md`, `skills/sessions/SKILL.md`,
`.agents/skills/typescript-refactor/SKILL.md`, `.agents/skills/vitest/SKILL.md`,
`.agents/skills/node/SKILL.md`.

## Scope

**In scope**:
- `skills/sessions/lib/core/types.ts`
- `skills/sessions/lib/core/cache.ts`
- `skills/sessions/lib/cursor/index.ts`
- `skills/sessions/lib/cursor/analyze.ts`
- `skills/sessions/scripts/sessions.ts`
- `skills/sessions/test/cursor/index.test.ts`
- `skills/sessions/test/cursor/analyze.test.ts`
- `skills/sessions/test/cli.test.ts`
- `skills/sessions/test/core/cache.test.ts`
- `skills/sessions/test/helpers.ts` only if test factories need `titleSource`

**Out of scope**:
- Codex provider title semantics.
- Reconstructing or writing Cursor `store.db`.
- Changing transcript discovery, workspace path resolution, automation
  classification, or evidence extraction.
- Renaming public command flags.

## Steps

### Step 1: Add title provenance to the session contract

In `skills/sessions/lib/core/types.ts`, add an erasable string-union type such
as:

```ts
export type SessionTitleSource = "store-db" | "first-query";
```

Add optional `titleSource?: SessionTitleSource` to `SessionBase`. Do not use a
TypeScript `enum`.

In `skills/sessions/lib/core/cache.ts`, add optional `titleSource` validation to
`SessionRecordBaseSchema` with `z.enum(["store-db", "first-query"]).optional()`.
This must remain optional so existing cache rows without the field still parse.

**Verify**: `cd skills/sessions && pnpm run typecheck` -> exit 0.

### Step 2: Derive Cursor display title during indexing

In `skills/sessions/lib/cursor/index.ts`, replace direct `title: meta.title`
with a small helper that returns `{ title, titleSource }`.

Expected behavior:
- If `meta.title` has text, use it unchanged and set `titleSource:
  "store-db"`.
- Otherwise clean `firstUserQuery` by:
  - applying `stripInjectedBlocks()`,
  - replacing repeated whitespace with one space,
  - trimming,
  - truncating to final length 80 with `...` only when longer than 80
    (`value.length <= 80 ? value : value.slice(0, 77) + "..."`).
- If the cleaned query has text, use it and set `titleSource: "first-query"`.
- If both are empty, leave both `title` and `titleSource` undefined.

Import `stripInjectedBlocks` from `./transcript.ts`; keep type-only imports as
type-only imports. Keep the title helper local to Cursor indexing unless another
caller needs it during implementation.

**Verify**: `cd skills/sessions && pnpm run typecheck` -> exit 0.

### Step 3: Reframe Cursor analysis signals

In `skills/sessions/lib/cursor/analyze.ts`:
- Keep `analysis.missing.title` as the count of missing display titles. After
  Step 2, this means no store-db title and no usable first query.
- Rename `cursor.missingTitles` to `cursor.missingDisplayTitles` to avoid
  preserving the old raw-metadata meaning. Extend `CursorSpecificAnalysis` with
  `missingDisplayTitles: CursorAnalysisSampleSet`.
- Add `missingStoreDbMetadata: CursorAnalysisSampleSet` to
  `CursorSpecificAnalysis`.
- Change the missing-display-title predicate to `!hasText(session.title)`.
  Reason text: "session has no display title".
- Add a Cursor-specific sample set for missing store metadata, for sessions
  where `storeDbPath` is absent. Reason text should make this informational,
  for example "session has no Cursor store.db metadata".
- Update `indexImprovementCandidates()`:
  - Add a high-severity `missing-display-title` candidate when
    `analysis.missing.title > 0`.
  - Add a medium-severity `missing-store-db-metadata` candidate when any Cursor
    sessions lack `storeDbPath`; message should say this is expected for
    transcript-only Glass sessions.
  - Remove or stop emitting the old `missing-title-metadata` candidate so the
    signal no longer implies missing display labels.

In `skills/sessions/scripts/sessions.ts`, update table labels/messages:
- `missing title:` -> `missing display title:`
- Add a summary line for `missing store-db metadata:` using
  `analysis.cursor.missingStoreDbMetadata.total`.
- `Missing titles with query` -> `Missing display titles`
- Add a rendered sample section for missing store-db metadata.
- Keep `renderSessionTable()` fallback `session.title ?? session.firstUserQuery`
  intentionally for stale caches until users reindex; add no new fallback paths
  to analyzer JSON.

API/migration note for executor and reviewer: `cursor.missingTitles` and
`missing-title-metadata` are replaced. JSON consumers should use
`cursor.missingDisplayTitles`, `cursor.missingStoreDbMetadata`,
`missing-display-title`, and `missing-store-db-metadata`.

**Verify**: `cd skills/sessions && pnpm run typecheck` -> exit 0.

### Step 4: Add regression tests

Update/add focused tests.

In `skills/sessions/test/cursor/index.test.ts`:
- Add a no-`store.db` transcript case: expect `title` to equal a cleaned first
  query and `titleSource` to be `"first-query"`.
- Add or update a store-db case: expect store title to win and `titleSource` to
  be `"store-db"`.
- Add an injected-block cleanup/truncation case. If easiest, write a custom
  transcript file under the temp env in the test rather than adding a fixture.

In `skills/sessions/test/core/cache.test.ts`:
- Add coverage that cache rows with `titleSource` parse.
- Confirm rows without `titleSource` still parse.

In `skills/sessions/test/cursor/analyze.test.ts`:
- Update missing-title expectations so sessions with fallback titles are not
  counted as missing display titles.
- Use post-index record shape in cache/analyzer fixtures: when a fixture has a
  usable `firstUserQuery`, set the expected derived `title` and `titleSource`,
  or build the fixture through `buildCursorIndex()`. Do not expect analyzer code
  to backfill stale cache rows.
- Add coverage for `missingDisplayTitles`, `missingStoreDbMetadata`, and the
  `missing-store-db-metadata` candidate.
- Add coverage that truly untitled sessions produce `missing-display-title`
  high-severity candidate.

In `skills/sessions/test/cli.test.ts`:
- Update JSON assertions from `missing-title-metadata` to the new candidate ids.
- Update table-output assertions for the new labels and sample section.

**Verify**:
`cd skills/sessions && pnpm run test -- test/cursor/index.test.ts test/cursor/analyze.test.ts test/cli.test.ts test/core/cache.test.ts`
-> exit 0, all selected tests pass.

### Step 5: Run full gates and inspect diff

Run:

```bash
cd skills/sessions && pnpm run check
```

Expected: exit 0.

Then from repo root:

```bash
pnpm run check
git diff -- skills/sessions
```

Expected:
- root check exits 0;
- diff only changes the in-scope sessions files unless `test/helpers.ts` was
  needed;
- no Codex provider behavior changes.

## Test plan

- Regression: Cursor transcript-only session receives a display `title` from
  cleaned `firstUserQuery`.
- Regression: store-db title remains primary.
- Regression: injected transcript blocks do not leak into fallback titles.
- Regression: fallback titles are capped at 80 characters.
- Contract: cache parser accepts optional `titleSource` and remains backward
  compatible with old rows.
- Analyzer: missing display title and missing store-db metadata are separate
  counts/signals.
- CLI: table and JSON output use the reframed labels/candidate ids.

## Done criteria

- [x] `title` in Cursor cache is the best display title.
- [x] Cursor sessions with first queries but no `store.db` are not counted as
  missing display titles.
- [x] `titleSource` records `"store-db"` or `"first-query"` when a title is set.
- [x] Missing `store.db` is reported separately from missing display title.
- [x] `cd skills/sessions && pnpm run check` exits 0.
- [x] `pnpm run check` exits 0.
- [x] `git diff` shows only in-scope files modified.

## STOP conditions

Stop and report if:
- Existing cache consumers require `title` to mean only raw `store.db` title.
- Adding `titleSource` requires a cache schema version bump beyond optional
  backward-compatible parsing.
- More than two non-test modules outside the in-scope list need edits.
- Test fixtures show `firstUserQuery` often contains sensitive injected blocks
  that `stripInjectedBlocks()` does not remove.
- Verification fails twice after a reasonable fix attempt.

## Maintenance notes

Reviewers should focus on the semantic change: `title` becomes display label,
not raw Cursor metadata. `titleSource` is the escape hatch for provenance.
Future Cursor storage changes should add new provenance values only when a new
source is actually indexed. Keep missing `store.db` as an informational Cursor
storage characteristic, not a high-severity index failure.
