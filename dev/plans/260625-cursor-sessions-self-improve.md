# Plan 260625-cursor-sessions-self-improve: Cursor session extraction library

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: dx

## Why this matters

Cursor stores hundreds of agent chats under `~/.cursor/` as JSONL transcripts,
SQLite chat DBs, and project-scoped indexes — but harness has no way to browse,
filter, show, export, or gather basic stats from them. This plan adds **Layer 1
session extraction** (`lib/sessions/`): provider-agnostic contracts plus a
Cursor adapter that indexes all workspaces, lists/shows sessions, and exports
normalized transcripts.

Analysis and self-improve behavior is intentionally split out. See
`dev/plans/260626-session-index-analysis.md` for the next provider-neutral
lexical analysis layer.

## Current state

Harness today has no session-mining code. Relevant conventions and anchors:

- `package.json` — Node `>=24`, pnpm, ESM (`"type": "module"`), scripts:
  `pnpm typecheck`, `pnpm test`, `pnpm lint`, `make check`.
- `tsconfig.build.json` — compiles `bin/`, `lib/`, `providers/`, `workflows/` to
  `dist/`; excludes `test/`, `**/*.test.ts`, `scripts/**/*.ts`.
- `bin/harness.ts` — main CLI using `commander`; pattern for subcommands and
  option parsing.
- `lib/schemas.ts` — Zod schemas + `formatZodError`; use for cache/index
  validation.
- `test/config.test.ts` — Vitest style: `import { expect, test } from "vitest"`,
  temp dirs via `mkdtempSync`, direct lib imports from `../lib/...`.
- `lib/workflow-context.ts:143` — `createWorkflowContextForTest` injects deps for
  CI; session code must follow the same pattern (see **Test seams** below).
- `vitest.config.ts` — includes `test/**/*.test.ts` and `providers/**/*.test.ts`.

### Verified Cursor on-disk layout (local sample, 2026-06-25)

```
~/.cursor/
├── projects/<encoded-workspace>/
│   ├── agent-transcripts/<chat-uuid>/<chat-uuid>.jsonl   # primary transcript source
│   ├── agent-tools/<uuid>.txt                            # large tool spillover (out of v1 scope)
│   └── repo.json                                         # workspace UUID only
├── chats/<workspace-hash>/<chat-uuid>/
│   ├── store.db                                          # blobs + meta tables (avoid protobuf in v1)
│   └── meta.json                                         # createdAtMs, updatedAtMs
```

Workspace path decode from project folder name is **best-effort only**. Cursor
encodes path segments with `-`, so naive decode is **lossy** for hyphenated repo
names:

- `Users-example-dev-harness` → `/Users/example/dev/harness` (works; no hyphens in segments)
- `Users-example-dev-my-repo` → `/Users/example/dev/my/repo` if every `-` becomes `/` (**wrong**; should be `/Users/example/dev/my-repo`)

**Source of truth for `workspacePath`:** `Workspace Path:` from injected
`<user_info>` in the first user message when present →
`workspacePathConfidence: "explicit"`. Folder-name decode → `"decoded"` only.
Treat `"decoded"` paths as lower-confidence display/filter data because repo
names may contain hyphens.

JSONL line shape (agent-transcripts):

```json
{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\n...\n</user_query>"}]}}
```

`store.db` meta row (`key = "0"`) is hex-encoded JSON with `agentId`, `name`,
`mode`, `createdAt` (ms).

~93% of harness workspace transcripts are automated change-review workers
(first user message contains `You are running as an automated worker`). Default
filters must exclude these.

## Suggested executor toolkit

| Skill / resource | Use for |
| ---------------- | ------- |
| `implement-plan` | Follow this plan phase-by-phase |
| `.agents/skills/typescript-refactor` | Discriminated unions for `SessionRecord`, explicit return types on exported APIs |
| `.agents/skills/zod` | Cache row schemas, CLI arg validation |
| `.agents/skills/vitest` | Fixture-based tests, no shared mutable state |
| `.agents/skills/node` | Path handling, SQLite via `node:sqlite` or `better-sqlite3` — prefer **Node 24 built-in `node:sqlite`** if available; else `bun:sqlite`-free approach: use dynamic import of `node:sqlite` (Node 22.5+) |

**SQLite note**: Node 24 includes experimental `node:sqlite`. Use it for
read-only `store.db` meta reads. If `node:sqlite` is unavailable in the executor
environment, fall back to reading only `meta.json` + jsonl mtime and document
the degradation in code comments. Do **not** add a new dependency unless
`node:sqlite` fails at runtime during Step 3 verification.

## Scope

**In scope** (only these areas):

- `lib/sessions/core/**` — types, `SessionEnvironment`, `SessionProvider`, cache, filters, show/export
- `lib/sessions/cursor/**` — Cursor indexer, transcript parser, stats, provider
- `lib/sessions/codex/**` — stub provider only (`not implemented` errors)
- `bin/sessions.ts` — Layer 1 CLI
- `package.json` — add `sessions` bin entry
- `test/sessions/**` — unit tests + jsonl fixtures
- `test/fixtures/sessions/**` — sample transcripts
- `dev/plans/README.md` — status row for this plan

**Out of scope** (do NOT touch):

- `bin/harness.ts` — no new subcommands in main harness CLI (use dedicated bins)
- `automations/` — no weekly automation doc yet
- `store.db` protobuf blob graph walking — meta table only in v1
- `agent-tools/*.txt` spillover files
- Codex adapter implementation (stub seam only)
- Global Cursor User Rules file writes (proposals as markdown text only)
- `sdk-agent-store/index.db` — defer to follow-up

## Architecture

```
lib/sessions/
├── core/
│   ├── types.ts           # SessionBase, CursorSession, workspacePathConfidence, Turn, UserTurn, ...
│   ├── env.ts             # SessionEnvironment (injectable paths + clock)
│   ├── provider.ts        # SessionProvider interface
│   ├── factory.ts         # createSessionProvider("cursor" | "codex" | "auto")
│   ├── cache.ts           # cache read/write under env.cacheRoot
│   ├── filters.ts         # apply SessionFilters on normalized records
│   ├── show.ts            # markdown transcript renderer
│   └── export.ts          # json | jsonl | md export
├── cursor/
│   ├── paths.ts           # cursorHome from env; best-effort workspace decode
│   ├── index.ts           # buildIndex(env): glob under env.cursorHome
│   ├── transcript.ts      # parse jsonl; extract Workspace Path + <user_query>
│   ├── classify.ts        # isAutomation, isSubagent heuristics
│   ├── meta.ts            # read meta.json + store.db meta row
│   ├── stats.ts           # lightweight index stats
│   └── provider.ts        # createCursorSessionProvider(env)
└── codex/
    └── provider.ts        # throws new Error("Codex session provider not implemented")

bin/sessions.ts              # sessions cursor reindex|list|show|export|stats
```

**Dependency rule**: `cursor/` and `codex/` never cross-import. Future analyzers
must import only `core/` plus the provider factory.

### Test seams (required in Step 1)

Match `createWorkflowContextForTest` in `lib/workflow-context.ts`. All path and
clock access goes through `SessionEnvironment`; production CLIs supply defaults,
tests inject temp dirs.

```ts
export type SessionEnvironment = {
  cursorHome: string;       // default: join(homedir(), ".cursor")
  cacheRoot: string;        // default: join(homedir(), ".harness", "session-index")
  homeDir: string;          // default: homedir()
  harnessRoot: string;      // default: resolve from import.meta.url to repo root
  now: () => Date;          // default: () => new Date()
};

export function defaultSessionEnvironment(
  overrides?: Partial<SessionEnvironment>,
): SessionEnvironment;

export function createCursorSessionProvider(
  env?: Partial<SessionEnvironment>,
): SessionProvider;
```

`buildCursorIndex(env)`, cache read/write, `globTranscriptFiles(env)`, and
`createCursorSessionProvider(env)` must accept environment overrides — no
hardcoded `~/.cursor` or `~/.harness` in library code. CI tests pass a temp tree
under `mkdtempSync` and never read the developer's live Cursor install.

### Core interface

```ts
export interface SessionProvider {
  readonly id: "cursor" | "codex";
  reindex(options?: ReindexOptions): Promise<IndexSnapshot>;
  list(filters: SessionFilters): SessionRecord[];
  get(sessionId: string): SessionRecord | undefined;
  getTranscript(sessionId: string): Transcript;
  iterUserTurns(filters: SessionFilters): AsyncIterable<UserTurn>;
}
```

### Cache location

Default `env.cacheRoot` → `~/.harness/session-index/`. Files:
`cursor.jsonl` (one JSON object per line, Zod-validated) and `meta.json` (see
**Cache `meta.json` spec**). Written on every `reindex`.

### Automation / subagent filters (Cursor)

Default `excludeAutomation: true` unless `--include-automation`:

- First extracted user query contains `You are running as an automated worker`
- Session id starts with `agent-`
- First user query contains `Hard requirements for your FINAL answer` (harness worker template)

## Extraction success criteria

Keep verification useful but not corpus-specific. CI must run only on synthetic
fixtures; manual smoke can inspect live Cursor data without adding live ids to
the repo.

### CI — Parser, indexer, filters, show/export

Unit tests on `test/fixtures/sessions/` prove parsing and classification logic
in isolation. No dependency on the developer's live Cursor install.

| Check | Test file | Pass |
| ----- | --------- | ---- |
| Workspace decode (no hyphens) | `paths.test.ts` | `Users-example-dev-harness` → `/Users/example/dev/harness`, confidence `"decoded"` |
| Workspace decode (hyphenated repo) | `paths.test.ts` | `Users-alice-dev-my-repo` decode is wrong without override; explicit `Workspace Path:` wins |
| `Workspace Path:` extraction | `transcript.test.ts` | sets `workspacePath` + confidence `"explicit"` |
| JSONL → `Turn[]` | `transcript.test.ts` | role count and order match fixture |
| `<user_query>` extraction | `transcript.test.ts` | query text matches; `UserTurn.text` excludes injected blocks |
| Automation classification | `classify.test.ts` | worker fixture → `isAutomation: true`; real-user → `false` |
| Subagent classification | `classify.test.ts` | `agent-*` id → `isSubagent: true` |
| Filters | `filters.test.ts` | `excludeAutomation`, `excludeSubagent`, `query`, `days`, workspace prefix |
| Show/export | `show-export.test.ts` | markdown rendering, truncation, json/jsonl/md export |

Indexer fixture test:

`index.test.ts` builds a temp `SessionEnvironment` mimicking
`<cursorHome>/projects/<key>/agent-transcripts/<id>/<id>.jsonl` and asserts the
indexer finds every file, prefers explicit `Workspace Path:`, records zero
`skipped`, and never reads the real `~/.cursor`.

### Manual smoke — Live extraction

After `sessions cursor reindex` on a machine with Cursor data:

```bash
# Baseline: raw transcript files on disk
find ~/.cursor/projects -path '*/agent-transcripts/*/*.jsonl' 2>/dev/null | wc -l

# Extractor
node dist/bin/sessions.js cursor stats
```

**Pass when:**

- `stats.indexedSessions === stats.transcriptsFound` (or every difference appears
  in `stats.skipped` with a reason)
- `stats.skippedUnparseable === 0`
- `stats.indexedSessions > 0`

Spot-check one real-user session and one automation session with:

```bash
node dist/bin/sessions.js cursor show <sessionId> | head -40
```

Confirm the rendered transcript, `workspacePathConfidence`, and automation flag
match what `sessions cursor list --include-automation` showed. Do not commit
live session ids or transcript content.

### `stats` command spec

Implement `lib/sessions/cursor/stats.ts` returning a typed `IndexStats` object.
CLI prints a compact human table and supports `--format json`.

```ts
export type IndexStats = {
  provider: "cursor";
  schemaVersion: 1;
  lastReindexAt: string | null;       // ISO-8601 from cache meta
  transcriptsFound: number;         // glob count on disk
  indexedSessions: number;          // rows written to cache
  skipped: number;                  // transcriptsFound - indexedSessions
  skippedUnparseable: number;       // jsonl parse failures
  withUserQuery: number;
  automationSessions: number;
  subagentSessions: number;
  realUserSessions: number;         // indexed - automation (approx)
  workspaces: number;
  oldestSessionAt: string | null;   // ISO-8601
  newestSessionAt: string | null;
};
```

### Cache `meta.json`

`~/.harness/session-index/meta.json` stores `schemaVersion`, `provider`,
`lastReindexAt`, and counts for `transcriptsFound`, `indexedSessions`, and
`skippedUnparseable`.

## Steps

### Step 1: Core types, environment seams, and cache

Create `lib/sessions/core/types.ts`, `env.ts`, `provider.ts`, `cache.ts`,
`filters.ts`.

- Define `SessionEnvironment`, `defaultSessionEnvironment`,
  `SessionBase`, `CursorSession`, `CodexSession` (stub), `Turn`, `UserTurn`,
  `Transcript`, `SessionFilters`, `IndexSnapshot`.
- `SessionBase` fields include `workspaceKey`, `workspacePath`,
  `workspacePathConfidence: "explicit" | "decoded"`.
- `SessionFilters` fields: `limit`, `days`, `workspacePathPrefix`,
  `workspaceKey`, `query`, `excludeAutomation` (default true), `excludeSubagent`
  (default true), `provider` (implicit).
- Cache read/write with Zod schema under `env.cacheRoot`; tolerate missing cache
  (empty list, suggest reindex).

**Verify**: `pnpm typecheck` → exit 0.

**Verify**: `pnpm test -- test/sessions/core/env.test.ts` (if added) or
typecheck-only in Step 1 — env defaults resolve without reading `~/.cursor`.

### Step 2: Cursor paths and transcript parser

Create `lib/sessions/cursor/paths.ts`, `transcript.ts`, `classify.ts`.

`paths.ts` (all paths from `SessionEnvironment`):

- `cursorProjectsRoot(env)` → `join(env.cursorHome, "projects")`
- `decodeWorkspacePathFromKey(projectDirName: string): { path: string; confidence: "decoded" }` — best-effort; document lossy hyphen behavior in comment
- `extractWorkspacePathFromUserInfo(text: string): { path: string; confidence: "explicit" } | null` — parse `Workspace Path: ...` line
- `globTranscriptFiles(env): { workspaceKey, workspacePath, workspacePathConfidence, chatId, jsonlPath }[]`

`transcript.ts`:

- Parse jsonl lines; map `role` → `Turn`
- Extract user query from `<user_query>...</user_query>` when present
- Extract `Workspace Path:` from raw user message for indexer (call paths helper)
- Strip known injected blocks from user text before preference mining (keep raw
  in `Turn.rawText`)

`classify.ts`:

- `isAutomationSession(session, firstUserQuery): boolean`
- `isSubagentSession(chatId, firstUserQuery): boolean`

Add fixtures:

- `test/fixtures/sessions/cursor-real-user.jsonl`
- `test/fixtures/sessions/cursor-automation-worker.jsonl`
- `test/fixtures/sessions/cursor-hyphenated-workspace.jsonl` — project key
  `Users-alice-dev-my-repo` with explicit `Workspace Path: /Users/alice/dev/my-repo`
  in user_info

**Verify**: `pnpm test -- test/sessions/cursor/transcript.test.ts test/sessions/cursor/paths.test.ts` → all pass.

### Step 3: Cursor indexer and meta enrichment

Create `lib/sessions/cursor/meta.ts`, `index.ts`, `stats.ts`, `provider.ts`.

`index.ts` `buildCursorIndex(env)`:

1. Glob all `join(env.cursorHome, "projects", "*", "agent-transcripts", "**", "*.jsonl")`
2. Best-effort decode workspace from project folder name → `workspacePathConfidence: "decoded"`
3. **Override** from `Workspace Path:` in first user message when present → `"explicit"`
4. Join `join(env.cursorHome, "chats", <hash>, chatId, ...)` meta when discoverable
5. Optionally read `store.db` `meta` table for `name`, `mode`, `createdAt`
6. Emit `CursorSession` rows; track `skippedUnparseable` and skip reasons
7. Write cache under `env.cacheRoot` per **Cache `meta.json` spec**

`stats.ts` aggregates from cache + optional live glob for `transcriptsFound`
reconciliation.

`provider.ts`: `createCursorSessionProvider(env)` implements `SessionProvider`.

**Verify** (CI): `pnpm test -- test/sessions/cursor/index.test.ts` → pass
without `~/.cursor`.

**Verify** (manual, after Step 4 build):

```bash
pnpm run build
node dist/bin/sessions.js cursor reindex
node dist/bin/sessions.js cursor stats
node dist/bin/sessions.js cursor stats --format json
```

Pass **Manual smoke — Live extraction**:

- `indexedSessions === transcriptsFound`
- `skippedUnparseable === 0`
- `indexedSessions > 0`

### Step 4: Show, export, and Layer 1 CLI

Create `lib/sessions/core/show.ts`, `export.ts`, `factory.ts`, `bin/sessions.ts`.

`sessions` CLI commands (commander):

```
sessions cursor reindex [--force]
sessions cursor list [--limit 25] [--days N] [--workspace <path-or-key>]
                        [--query TEXT] [--include-automation]
sessions cursor show <sessionId> [--max-tool-chars 2000]
sessions cursor export <sessionId> [--format json|md|jsonl]
sessions cursor stats [--format table|json]
```

`stats` must implement the `IndexStats` shape from **Extraction success criteria**.

Wire `package.json` bin:

```json
"sessions": "./dist/bin/sessions.js"
```

Add explicit return types on exported functions per repo TS conventions.

**Verify**:

```bash
pnpm run build
node dist/bin/sessions.js cursor list --limit 5
```

→ table with columns: updated, workspace, title/name, sessionId, automation flag.

**Verify** (manual): spot-check one real-user and one automation session with
`sessions cursor show <sessionId>`.

### Step 5: Codex stub seam

Create `lib/sessions/codex/provider.ts`:

```ts
export function createCodexSessionProvider(): SessionProvider {
  throw new Error("Codex session provider not implemented");
}
```

`factory.ts` routes `cursor` → cursor provider, `codex` → stub error,
`auto` → cursor (document in `--help`).

**Verify**: `pnpm typecheck` → exit 0.

### Step 6: Lint, format, docs index

1. Run `pnpm run format` on new files (or `make fix`).
2. Update `dev/plans/README.md` — add row for this plan as `in_progress` → executor sets `done` when finished.
3. Optionally add a short section to root `README.md` under skills/tooling — **only** if there is an existing "CLI tools" section; otherwise skip README (avoid scope creep).

**Verify**: `make check` → exit 0.

## Test plan

| File | Cases |
| ---- | ----- |
| `test/sessions/cursor/transcript.test.ts` | parse roles; extract `<user_query>`; handle missing tags |
| `test/sessions/cursor/classify.test.ts` | automation worker detection; `agent-` subagent id |
| `test/sessions/cursor/paths.test.ts` | no-hyphen decode; hyphenated key wrong without explicit override; explicit wins |
| `test/sessions/cursor/index.test.ts` | temp `SessionEnvironment`; zero skipped |
| `test/sessions/cursor/stats.test.ts` | `IndexStats` aggregation from fixture cache |
| `test/sessions/core/filters.test.ts` | days, workspace prefix, excludeAutomation, excludeSubagent, query |
| `test/sessions/core/show-export.test.ts` | markdown metadata/truncation; json/jsonl/md export |
| `test/sessions/core/cache.test.ts` | strict cursor cache validation |
| `test/sessions/cursor/provider.test.ts` | stale-cache transcript error suggests reindex |

Fixture: `test/fixtures/sessions/cursor-hyphenated-workspace.jsonl` — see Step 2.

Model tests after `test/config.test.ts`: temp dirs, direct imports, no network.

**Verification**: `pnpm test` → all pass including new tests (≥ 6 new test files or equivalent describe blocks).

## Done criteria

ALL must hold:

- [ ] `lib/sessions/core/`, `lib/sessions/cursor/`, `lib/sessions/codex/` exist; codex provider throws on use
- [ ] `SessionEnvironment` injectable; no hardcoded `~/.cursor` / `~/.harness` in lib (CI uses temp env)
- [ ] `workspacePathConfidence` on session records; hyphenated decode fixture test passes
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0 with session coverage
- [ ] `pnpm lint` exits 0
- [ ] `pnpm run build` produces `dist/bin/sessions.js`
- [ ] CI: `pnpm test -- test/sessions/` all pass without reading live `~/.cursor`
- [ ] Manual live extraction: `stats.indexedSessions === stats.transcriptsFound`, `skippedUnparseable === 0`, and `indexedSessions > 0`
- [ ] `sessions cursor stats --format json` emits valid `IndexStats` per spec
- [ ] `~/.harness/session-index/meta.json` written on reindex with `counts` block
- [ ] `dev/plans/README.md` updated with this plan row marked `done`
- [ ] No files outside in-scope list modified (`git diff --name-only`)

## STOP conditions

Stop and report back (do not improvise) if:

- Session tests read real `~/.cursor` instead of injected temp dirs — stop; fix seams first.
- `~/.cursor/projects/` layout differs materially (no `agent-transcripts` dirs) —
  include `ls ~/.cursor/projects/<one-project>/` output in report.
- JSONL line schema differs from `{"role","message":{"content":[{"type":"text"}]}}` —
  paste one sample line and halt.
- `node:sqlite` cannot open `store.db` read-only **and** `meta.json` is absent for
  all sessions — ship jsonl-only index with a code comment; do not add npm sqlite
  dependency without user approval.
- Implementing protobuf `store.db` blob parsing seems required for basic list/show —
  stop; that is out of scope.
- A step's verification fails twice after a reasonable fix attempt.
- Touching `bin/harness.ts` or workflow code seems necessary — stop and ask.

## Maintenance notes

- **Workspace decode**: prefer explicit `Workspace Path:`; never target project files from `"decoded"` paths when repo name may contain hyphens.
- **Test seams**: new providers accept `SessionEnvironment`; follow `createWorkflowContextForTest` precedent.
- **Codex follow-up**: implement `lib/sessions/codex/{index,rollout,provider}.ts`
  using `~/.codex/state_5.sqlite` + rollout JSONL.
- **New analyzers**: see `dev/plans/260626-session-index-analysis.md`; consume
  `SessionProvider` only.
- **Privacy**: transcripts may contain secrets — `show`/`export` should not be
  logged to CI artifacts; redact obvious token patterns in reports if cheap.
- **Harness noise**: automation sessions dominate harness workspace; keep
  `excludeAutomation: true` as default forever.
- **Reviewer focus**: provider seam cleanliness, no cross-imports, fixture
  coverage without relying on developer `~/.cursor` in CI.

## Follow-ups (explicitly deferred)

- `lib/sessions/codex/` full adapter
- `sessions analyze --provider cursor` (`dev/plans/260626-session-index-analysis.md`)
- `automations/self-improve.md` scheduled dream pass
- `sdk-agent-store` integration for CLI/SDK-only runs
- `agent-tools` spillover inclusion in `show`
- Additional analysis skills: `workflow-insights`, `session-patterns`
- `harness sessions` subcommand alias in main CLI
