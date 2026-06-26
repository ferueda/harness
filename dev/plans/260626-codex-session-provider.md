# Plan 260626-codex-session-provider: Add Codex session extraction with shared analyzer parity

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in the "STOP conditions" section occurs, stop and report.
> Do not improvise around Codex storage, classification, or analyzer behavior.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: [260625-cursor-sessions-self-improve.md](./260625-cursor-sessions-self-improve.md), [260626-session-index-analysis.md](./260626-session-index-analysis.md), [260626-session-evidence-extraction.md](./260626-session-evidence-extraction.md), [260626-session-turn-search-extraction.md](./260626-session-turn-search-extraction.md)
- **Category**: dx

## Why this matters

The sessions tool can currently extract and analyze Cursor history, but Codex is only a stub. Agents should be able to inspect local Codex sessions with the same evidence and metadata engine used for Cursor, so provider differences stay at the adapter boundary and analysis results stay comparable. This plan adds Codex as a real `SessionProvider` while keeping core analyzer/evidence logic provider-neutral.

This is not a workflow-mining or self-improvement automation feature. It is a simple extraction layer that lets agents ask questions like "what did the user repeatedly ask for?", "which review/debug/test loops recur?", and "where is the evidence in past sessions?" across Cursor and Codex.

## Current state

- `lib/sessions/core/types.ts` — shared session model. `SessionProviderId` already includes `"cursor" | "codex"`, but `CodexSession` only contains `provider: "codex"` today.
- `lib/sessions/core/provider.ts` — shared `SessionProvider` contract: `reindex`, `list`, `get`, `getTranscript`, and `iterUserTurns`.
- `lib/sessions/core/evidence.ts` — `extractSessionEvidence` already consumes `AsyncIterable<UserTurn> | Iterable<UserTurn>`.
- `lib/sessions/core/analyze.ts` — `analyzeSessions` already accepts `SessionRecord[]` and `provider?: "cursor" | "codex" | "all"`.
- `lib/sessions/codex/provider.ts` — currently throws `new Error("Codex session provider not implemented")`.
- `bin/sessions.ts` — currently hardcodes Cursor for analyze and subcommands.
- `lib/sessions/core/cache.ts` — validates Codex row shape only minimally, but cache paths/meta are Cursor-specific.
- `test/sessions/cli.test.ts` — currently asserts `sessions analyze --provider codex` is rejected.

Important current excerpts:

```ts
// lib/sessions/core/types.ts:1
export type SessionProviderId = "cursor" | "codex";

// lib/sessions/core/types.ts:35
export type CodexSession = SessionBase & {
  provider: "codex";
};
```

```ts
// lib/sessions/core/provider.ts:11
export interface SessionProvider {
  readonly id: SessionProviderId;
  reindex(options?: ReindexOptions): Promise<IndexSnapshot>;
  list(filters?: SessionFilters): SessionRecord[];
  get(sessionId: string): SessionRecord | undefined;
  getTranscript(sessionId: string): Transcript;
  iterUserTurns(filters?: SessionFilters): AsyncIterable<UserTurn>;
}
```

```ts
// bin/sessions.ts:33
const ANALYZE_PROVIDERS = ["cursor"] as const;

// bin/sessions.ts:246
async function extractEvidenceForOptions(options: AnalyzeOptions): Promise<SessionEvidenceReport> {
  return await extractSessionEvidence(cursorProvider.iterUserTurns(toSessionFilters(options)), {
    provider: "cursor",
```

```ts
// lib/sessions/core/cache.ts:45
const CacheMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("cursor"),
```

Cursor provider pattern to mirror:

```ts
// lib/sessions/cursor/provider.ts:18
export function createCursorSessionProvider(
  overrides: Partial<SessionEnvironment> = {},
): SessionProvider {
  const env = defaultSessionEnvironment(overrides);
  return new CursorSessionProvider(env);
}

// lib/sessions/cursor/provider.ts:51
async *iterUserTurns(filters: SessionFilters = {}): AsyncIterable<UserTurn> {
  for (const session of this.list(filters)) {
    const transcript = this.readTranscript(session);
```

```ts
// lib/sessions/cursor/index.ts:10
export async function buildCursorIndex(env: SessionEnvironment): Promise<IndexSnapshot> {
  const files = globTranscriptFiles(env);
  const metaIndex = buildCursorMetaIndex(env);
```

Test helper pattern to extend:

```ts
// test/sessions/helpers.ts:10
export function makeSessionEnv(): SessionEnvironment {
  const root = mkdtempSync(join(tmpdir(), "harness-sessions-"));
  return {
    cursorHome: join(root, ".cursor"),
    cacheRoot: join(root, ".harness/session-index"),
    homeDir: root,
    harnessRoot: process.cwd(),
    now: () => new Date("2026-06-26T00:00:00.000Z"),
  };
}
```

External Codex storage reference:

- <https://github.com/jxnl/dots/blob/master/agents/skills/self-improve/SKILL.md>
- <https://github.com/jxnl/dots/blob/master/agents/skills/self-improve/scripts/self_improve.py>

Relevant observed behavior from that reference:

- Treat `~/.codex/state_5.sqlite` as the authoritative Codex session index.
- Use `threads.rollout_path` to load full rollout JSONL transcripts under `~/.codex/sessions` or `~/.codex/archived_sessions`.
- Treat `~/.codex/session_index.jsonl` as incomplete convenience data, not source of truth.
- Extract user messages from JSONL events shaped like `event.type == "event_msg"` and `payload.type == "user_message"`.
- Render assistant messages from `payload.type == "agent_message"`.

Local diagnosis on June 26, 2026 found two Codex DB paths:

- `~/.codex/state_5.sqlite`
- `~/.codex/sqlite/state_5.sqlite`

Use `~/.codex/state_5.sqlite` by default because the active Codex Desktop process had it open, its WAL was active, its schema version was newer, and it had more/recent rows. Use `~/.codex/sqlite/state_5.sqlite` only as a fallback when the root DB is missing. Do not merge both and do not auto-select "newer" when root exists.

Repo conventions to match:

- TypeScript runs directly under Node type stripping. Use `.ts` import extensions and `import type` for type-only imports.
- Prefer small provider-specific modules that mirror existing `lib/sessions/cursor/*` layout.
- Keep `cursor/` and `codex/` isolated. They may both import from `core/`, but must not cross-import each other's implementation modules except for a deliberate shared `core/classify.ts` extraction described below.
- Use Zod at cache/input boundaries, with `.strict()` schemas like `lib/sessions/core/cache.ts`.
- Tests use Vitest and fixture temp directories. Do not read live `~/.codex` or `~/.cursor` in tests.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install` | exit 0 |
| Format | `pnpm run format` | exit 0; source formatted |
| Format check | `pnpm run format:check` | exit 0 |
| Lint | `pnpm run lint` | exit 0, no lint errors |
| Typecheck | `pnpm run typecheck` | exit 0, no TypeScript errors |
| Focused sessions tests | `pnpm vitest run test/sessions` | exit 0, all session tests pass |
| Full test suite | `pnpm test` | exit 0, all tests pass |
| Full local gate | `pnpm run check` | exit 0; format, lint, typecheck, tests, dist smoke pass |

## Suggested executor toolkit

| Skill | Use for |
| --- | --- |
| `implement-plan` | Execute this plan phase-by-phase; update this plan's checkboxes/status if the repo convention expects it. |
| `node` | Node TypeScript type-stripping compatibility, `node:sqlite`, async parsing, and error handling choices. |
| `typescript-refactor` | Type-safe provider wiring, discriminated unions, and avoiding unsafe casts in `CodexSession`/cache parsing. |
| `vitest` | New fixture-heavy tests under `test/sessions/**`. |
| `zod` | Cache/schema changes in `lib/sessions/core/cache.ts`. |
| `change-review-workflow` | Run review after implementation and fixes, with this plan passed as `--plan`. |

Reference docs and files to read before coding:

- This plan.
- `AGENTS.md`.
- `lib/sessions/cursor/provider.ts`, `lib/sessions/cursor/index.ts`, `lib/sessions/cursor/transcript.ts`, `lib/sessions/cursor/stats.ts`.
- `lib/sessions/core/types.ts`, `lib/sessions/core/provider.ts`, `lib/sessions/core/cache.ts`, `lib/sessions/core/evidence.ts`, `lib/sessions/core/analyze.ts`.
- `test/sessions/helpers.ts` and `test/sessions/cli.test.ts`.
- The external Codex extraction references linked in "Current state" for storage shape only. Do not copy their self-improvement proposal logic.

## Scope

**In scope** (the only areas you should modify):

- `lib/sessions/core/types.ts`
- `lib/sessions/core/env.ts`
- `lib/sessions/core/factory.ts`
- `lib/sessions/core/cache.ts`
- `lib/sessions/core/classify.ts` (create only if sharing automation markers cleanly)
- `lib/sessions/cursor/classify.ts` (only to re-export/use shared automation markers if `core/classify.ts` is created)
- `lib/sessions/cursor/stats.ts` (only if cache meta paths become provider-specific)
- `lib/sessions/codex/paths.ts` (create)
- `lib/sessions/codex/rollout.ts` (create)
- `lib/sessions/codex/classify.ts` (create)
- `lib/sessions/codex/index.ts` (create)
- `lib/sessions/codex/provider.ts`
- `lib/sessions/codex/stats.ts` (create)
- `bin/sessions.ts`
- `test/sessions/**`
- `test/fixtures/sessions/**`
- `README.md`
- `skills/session-evidence/SKILL.md`
- `dev/plans/README.md`
- This plan file, if status updates are needed during execution.

**Out of scope** (do NOT touch):

- `providers/codex/**` — this is harness reviewer runtime, not local session history extraction.
- `providers/cursor/**` — unrelated to session indexing.
- `workflows/**` and `automations/**`.
- Self-improvement proposal generation, skill mining, workflow mining, clustering, or model-driven recommendations.
- `sessions analyze --provider all` unless explicitly approved later.
- Reading live `~/.codex` in tests.
- Writing to any Codex DB, rollout file, memory file, or `AGENTS.md` outside this repo.

## Data contract decisions

### Codex source of truth

Add Codex environment support:

- `SessionEnvironment.codexHome`, default `join(homeDir, ".codex")`.
- Prefer `join(env.codexHome, "state_5.sqlite")`.
- Fallback to `join(env.codexHome, "sqlite", "state_5.sqlite")` only when the root DB does not exist.
- Add an override if needed for tests, preferably `codexStateDbPath?: string`.

Do not merge both DBs. Do not choose the newer DB dynamically.

### Codex session fields

Extend `CodexSession` minimally:

```ts
export type CodexSession = SessionBase & {
  provider: "codex";
  threadId: string;
  rolloutPath: string;
  stateDbPath?: string;
  source?: string;
  threadSource?: string;
  parentThreadId?: string;
  agentRole?: string;
  agentNickname?: string;
};
```

Keep optional fields only when they are useful for debugging, classification, or stale-cache errors. Do not copy every Codex DB column into the public cache row.

### Workspace mapping

Map Codex `threads.cwd` to:

- `workspacePath`: DB `cwd` if non-empty, otherwise `env.homeDir`.
- `workspaceKey`: a stable sanitized absolute path key. Use the same spirit as Cursor project keys: strip a leading slash, replace path separators with `-`, preserve readable path segments, and use a deterministic fallback such as `"home"` for empty paths. Add tests for paths with spaces and nested repo paths.
- `workspacePathConfidence`: `"explicit"` when `cwd` exists, `"decoded"` when falling back to `env.homeDir`.
- `workspacePathSource`: `"store-db"` for SQLite metadata.

Do not introduce a new `WorkspacePathSource` value unless code reality forces it. Existing analyzer/rendering expects `"transcript" | "store-db" | "project-key"`.

### Classification

`isSubagent` should be structural:

- true if the thread id appears as `thread_spawn_edges.child_thread_id`;
- true if parsed `threads.source` JSON contains a Codex subagent spawn marker;
- true for a known subagent `thread_source`/role value if tests confirm it;
- do not treat arbitrary `agent_role` or `agent_nickname` alone as sufficient unless the role is known to mean spawned child.

`isAutomation` should be conservative:

- true if title starts with `Automation:`;
- true if an explicit automation source/thread_source exists;
- true if the first user message contains shared automation-worker markers.

Move shared automation marker constants out of `lib/sessions/cursor/classify.ts` into `lib/sessions/core/classify.ts` only if both providers need them. Keep Cursor behavior unchanged.

### Rollout parsing

Create a Codex parser that maps rollout JSONL to shared `Turn[]`:

- `event_msg` + `payload.type === "user_message"` -> `{ role: "user", text, rawText }`
- `event_msg` + `payload.type === "agent_message"` -> `{ role: "assistant", text, rawText }`
- `response_item` + function/tool payloads -> `{ role: "tool", ... }` when a readable summary exists, otherwise skip or `unknown`
- developer/system instruction messages are not user turns and should not feed evidence extraction

The parser must tolerate unknown event/payload types by skipping them. Bad JSON lines should make that transcript unparseable during reindex, matching Cursor's skip behavior.

## Steps

### Step 1: Add Codex environment and path resolution

Update `SessionEnvironment` in `lib/sessions/core/env.ts`:

- add `codexHome: string`;
- optionally add `codexStateDbPath?: string` if it makes tests cleaner;
- default `codexHome` to `join(homeDir, ".codex")`;
- update `test/sessions/helpers.ts` `makeSessionEnv()` to include `codexHome`.

Create `lib/sessions/codex/paths.ts`:

- `codexStateDbPath(env: SessionEnvironment): string`;
- `resolveCodexRolloutPath(env, rolloutPath): string`;
- `workspaceKeyForCodexPath(path: string): string`;
- root DB wins; fallback only if root missing.

**Verify**: `pnpm run typecheck` -> exit 0.

### Step 2: Add Codex rollout parser

Create `lib/sessions/codex/rollout.ts`.

Recommended exports:

```ts
export class CodexRolloutParseError extends Error {}

export type ParsedCodexRollout = {
  turns: Turn[];
  firstUserQuery?: string;
};

export function parseCodexRolloutFile(path: string): ParsedCodexRollout;
```

Rules:

- read JSONL line by line;
- skip blank lines;
- throw `CodexRolloutParseError` on invalid JSON;
- extract user and assistant text as described in "Rollout parsing";
- `firstUserQuery` is the first non-empty user message.

Add tests under `test/sessions/codex/rollout.test.ts` with fixture JSONL files:

- normal multi-turn rollout;
- unknown event types are skipped;
- invalid JSON line throws `CodexRolloutParseError`;
- assistant messages render as assistant turns;
- developer/system `response_item` messages do not become user turns.

**Verify**: `pnpm vitest run test/sessions/codex/rollout.test.ts` -> exit 0.

### Step 3: Add Codex classification

Create `lib/sessions/codex/classify.ts`.

Recommended exports:

```ts
export type CodexThreadClassificationInput = {
  threadId: string;
  title: string;
  source: string;
  threadSource?: string;
  firstUserQuery?: string;
  isSpawnChild: boolean;
  parentThreadId?: string;
  agentRole?: string;
  agentNickname?: string;
};

export function isCodexSubagent(input: CodexThreadClassificationInput): boolean;
export function isCodexAutomation(input: CodexThreadClassificationInput): boolean;
```

Also add a small helper to parse `source` JSON safely. It should return `undefined` on non-JSON or unexpected shapes.

The indexer must compute `isSpawnChild` from `thread_spawn_edges.child_thread_id`
before calling `isCodexSubagent`. Do not make the classifier query SQLite or
reach into indexer state. `parentThreadId` is useful for debugging/cache rows,
but `isSpawnChild` is the child-side classification signal.

If sharing automation markers, create `lib/sessions/core/classify.ts`:

```ts
export const AUTOMATION_WORKER_MARKER = "You are running as an automated worker";
export const AUTOMATION_MARKERS = [
  AUTOMATION_WORKER_MARKER,
  "Hard requirements for your FINAL answer",
] as const;

export function hasAutomationMarker(value = ""): boolean {
  return AUTOMATION_MARKERS.some((marker) => value.includes(marker));
}
```

Then update `lib/sessions/cursor/classify.ts` to preserve exact current behavior using those shared constants.

Add tests under `test/sessions/codex/classify.test.ts`:

- `isSpawnChild: true` from spawn-edge child id -> subagent true;
- source JSON with `subagent.thread_spawn` -> subagent true;
- normal `source: "cli"` and `source: "vscode"` -> subagent false;
- bare `agentRole: "explorer"` without structural subagent evidence -> subagent false, unless implementation chooses a documented known-role exception;
- automation-worker first user message -> automation true;
- title `Automation: example` -> automation true;
- normal CLI/VSC thread -> automation false.

**Verify**: `pnpm vitest run test/sessions/codex/classify.test.ts test/sessions/cursor/classify.test.ts` -> exit 0.

### Step 4: Add provider-aware cache functions

Update `lib/sessions/core/cache.ts` without a broad framework.

Minimum target:

- keep Cursor APIs working;
- add `readCachedSessions(env, provider?)` or separate `readProviderCachedSessions(env, provider)`;
- add `writeCodexCache(env, snapshot)`;
- add `codexCachePath(env): string` returning `join(env.cacheRoot, "codex.jsonl")`;
- make cache meta provider-aware. Prefer either `meta-cursor.json` / `meta-codex.json` or a provider argument to `metaPath(env, provider)`. Avoid one shared `meta.json` that one provider overwrites for the other.
- extend `CodexSessionRecordSchema` with new Codex fields.
- update `lib/sessions/cursor/stats.ts` and `writeCursorCache` callers if meta paths change.
- keep backward compatibility for existing Cursor `meta.json`: either read it as a fallback for Cursor stats until the next Cursor reindex writes provider-specific meta, or migrate it on write. Document the chosen behavior in tests.

Compatibility requirement:

- existing Cursor tests must keep passing;
- any existing call to `readCachedSessions(env)` should still read Cursor cache unless deliberately migrated.

Add tests under `test/sessions/cache.test.ts` or an existing cache test file:

- writes and reads Cursor cache as before;
- writes and reads Codex cache with `rolloutPath`;
- invalid Codex row fails with a useful error;
- Cursor and Codex cache files do not overwrite each other's meta.

**Verify**: `pnpm vitest run test/sessions/core/cache.test.ts test/sessions/cli.test.ts` -> exit 0.

### Step 5: Implement Codex indexer and stats

Create `lib/sessions/codex/index.ts`.

Recommended behavior:

- open the resolved Codex state DB read-only;
- read `threads` rows needed for cache fields:
  - `id`, `rollout_path`, `created_at`, `updated_at`, `created_at_ms`, `updated_at_ms`, `cwd`, `title`, `source`, `thread_source`, `first_user_message`, `agent_role`, `agent_nickname`, `archived`;
- read `thread_spawn_edges` once into a `Map<childThreadId, parentThreadId>`;
- resolve each rollout path;
- parse each rollout file during reindex to compute `turnCount` and `userTurnCount`;
- use `threads.first_user_message` as the preferred metadata value for `firstUserQuery`, stripping known leading injected Codex preambles when present; fall back to the cleaned first rollout user turn only when the DB field has no usable text. Rollout content remains the raw transcript source for `show` and `export`.
- if rollout is missing or unparseable, skip the session and increment `skippedUnparseable`;
- sort sessions by `updatedAtMs` descending then `sessionId`.
- define `transcriptsFound` as DB rows with a non-empty `rollout_path` that the indexer attempts. Missing or unreadable rollout files count toward `transcriptsFound`, do not become indexed sessions, and increment `skippedUnparseable`; `skipped` remains `transcriptsFound - indexedSessions`.

Use `node:sqlite` `DatabaseSync` because the repo already uses it in tests. Open the DB in read-only mode if supported by the current Node API. If read-only open is awkward, do not write to the DB and document the limitation in a code comment.

Create `lib/sessions/codex/stats.ts` parallel to Cursor stats:

- cache meta / last reindex;
- transcripts found from DB row count;
- indexed sessions from Codex cache;
- skipped / skippedUnparseable;
- with user query;
- automation, subagent, real-user;
- workspace count;
- oldest/newest session timestamps.

Add tests under `test/sessions/codex/index.test.ts` and `test/sessions/codex/stats.test.ts`.

Fixtures:

- build SQLite fixtures in temp dirs from helpers, not checked-in binary DBs unless that proves much simpler;
- create a helper such as `writeCodexStateDb(env, options)` using `DatabaseSync`;
- create rollout JSONL fixtures in `test/fixtures/sessions/`.

**Verify**: `pnpm vitest run test/sessions/codex/index.test.ts test/sessions/codex/stats.test.ts` -> exit 0.

### Step 6: Implement Codex provider

Replace `lib/sessions/codex/provider.ts` stub with a real provider that mirrors `CursorSessionProvider`.

Required behavior:

- `createCodexSessionProvider(overrides?: Partial<SessionEnvironment>): SessionProvider`
- constructor uses `defaultSessionEnvironment(overrides)`
- `reindex()` calls `buildCodexIndex(env)`
- `list()` reads Codex cache and applies `applySessionFilters`
- `get()` finds by `sessionId`
- `getTranscript()` parses `session.rolloutPath`
- `iterUserTurns()` yields only `role === "user"` turns with correct `turnIndex` and `isFirstUserTurn`
- missing rollout error should say `Transcript missing for session <id>; run sessions codex reindex`
- unparseable rollout error should say `Transcript unreadable for session <id>; run sessions codex reindex`

Update `lib/sessions/core/factory.ts` so `"codex"` calls `createCodexSessionProvider(env)`.

Add tests under `test/sessions/codex/provider.test.ts`:

- `list()` excludes subagents by default;
- `list({ excludeSubagent: false })` includes subagents;
- `getTranscript()` returns parsed turns;
- `iterUserTurns()` yields only user turns and preserves session metadata;
- missing rollout produces Codex-specific reindex guidance.

**Verify**: `pnpm vitest run test/sessions/codex/provider.test.ts` -> exit 0.

### Step 7: Make CLI provider-neutral enough for parity

Update `bin/sessions.ts`.

Required command behavior:

- `sessions codex reindex`
- `sessions codex list`
- `sessions codex show <sessionId>`
- `sessions codex export <sessionId>`
- `sessions codex stats`
- `sessions analyze --provider codex`

Implementation guidance:

- Replace the global `cursorProvider` with a small provider getter:

```ts
function providerFor(id: AnalyzeProvider): SessionProvider {
  return createSessionProvider(id, sessionEnv);
}
```

- Register provider command groups with a helper to avoid duplicating `list/show/export` logic:

```ts
registerProviderCommands(program, "cursor", "Cursor", getCursorIndexStats);
registerProviderCommands(program, "codex", "Codex", getCodexIndexStats);
```

- Keep `sessions analyze --provider cursor` full output behavior including Cursor-specific samples.
- For `sessions analyze --provider codex`, use `analyzeSessions(readCachedSessions(sessionEnv, "codex"), { provider: "codex", limit })` or equivalent. Do not force Codex into `analyzeCursorSessions`.
- Split analysis result typing and rendering:
  - full mode should allow `SessionAnalysis | CursorSessionAnalysis`;
  - table rendering should have a neutral base section for both providers;
  - Cursor-only samples and index-improvement sections should render only when the result has Cursor-specific analysis;
  - Codex table output must not read `analysis.cursor`.
- Make the empty list message provider-aware. It currently says `Run sessions cursor reindex`; Codex empty lists should say `Run sessions codex reindex`.
- `--include-turns`, `--extract-only`, `--turn-query`, `--days`, `--workspace`, `--query`, and `--include-automation` must work for both providers.
- Do not add `--provider all`.
- `extractSessionEvidence` must receive `provider: options.provider`, not a hardcoded `"cursor"`.

Add/update CLI tests in `test/sessions/cli.test.ts`:

- replace the current `codex` rejection test with parity tests;
- keep `all` rejection test;
- `sessions codex reindex --force` builds Codex cache from fixture env;
- `sessions codex list` shows Codex fixture rows;
- `sessions codex show` renders transcript markdown;
- `sessions codex export --format json` emits parseable JSON;
- `sessions codex stats --format json` emits parseable stats;
- `sessions analyze --provider codex --format json` emits provider `"codex"` and neutral analysis;
- `sessions analyze --provider codex` in table mode exits 0 and renders neutral sections without Cursor samples;
- `sessions analyze --provider codex --include-turns --extract-only --turn-query "verify" --format json` scans Codex user turns and returns matches.

**Verify**: `pnpm vitest run test/sessions/cli.test.ts` -> exit 0.

### Step 8: Update docs and skill guidance

Update `README.md` session-evidence section and `skills/session-evidence/SKILL.md`:

- document `--provider cursor|codex`;
- document `sessions codex reindex/list/show/export/stats`;
- state that Codex uses `~/.codex/state_5.sqlite` as source of truth and falls back only if missing;
- remind users that transcripts can contain secrets and `show/export` should not be pasted into public artifacts.

Update `dev/plans/README.md` row for this plan to `in_progress` or `done` according to actual implementation status.

**Verify**: `rg -n "provider codex|sessions codex|state_5.sqlite" README.md skills/session-evidence/SKILL.md` -> output contains the new Codex usage and source-of-truth guidance.

### Step 9: Run full verification and review

Run:

```bash
pnpm run check
```

Expected result: exit 0.

Then run the harness change review workflow with this plan. Compose a short
handoff per `change-review-workflow` before running. If the implementation is
not committed yet, create a temporary review ref or commit object and pass that
as `--head`; reviewing `HEAD` alone excludes uncommitted changes.

```bash
printf '%s\n' "<self-contained handoff>" | node bin/harness.ts run change-review --workspace /Users/frueda/dev/harness --base main --head <review-head> --plan dev/plans/260626-codex-session-provider.md --handoff-stdin
```

Expected result: review run completes. Triage every finding. Fix accepted findings. Re-run focused tests and, after material fixes, re-run review up to the cycle count requested by the user.

## Test plan

New/updated tests:

- `test/sessions/codex/paths.test.ts`
  - root DB preferred;
  - fallback DB only used when root missing;
  - rollout paths resolve from absolute, `sessions`, and `archived_sessions` locations.
  - workspace key derivation is stable and works with `--workspace` filters.
- `test/sessions/codex/rollout.test.ts`
  - event parsing and invalid JSON behavior.
- `test/sessions/codex/classify.test.ts`
  - subagent and automation rules.
- `test/sessions/codex/index.test.ts`
  - builds Codex cache from SQLite + JSONL fixtures.
- `test/sessions/codex/provider.test.ts`
  - provider contract behavior and user-turn iteration.
- `test/sessions/codex/stats.test.ts`
  - stats from Codex cache/meta.
- `test/sessions/cli.test.ts`
  - CLI parity and analyzer provider selection.
  - Codex table analysis does not try to render Cursor-only sample sections.
- Existing Cursor tests
  - must still pass unchanged, especially cache, provider, index, stats, and CLI analyze behavior.

Fixtures:

- Prefer programmatic SQLite fixture creation using `DatabaseSync` helpers in `test/sessions/helpers.ts`.
- Add JSONL rollout fixtures under `test/fixtures/sessions/` only.
- Do not commit copied live Codex DBs or transcripts.

Verification:

- `pnpm vitest run test/sessions` -> all session tests pass.
- `pnpm run typecheck` -> exit 0.
- `pnpm run check` -> exit 0.

## Done criteria

ALL must hold:

- [x] `sessions codex reindex` creates `codex.jsonl` cache from fixture and live environments.
- [x] `sessions codex list/show/export/stats` exist and work in tests.
- [x] `sessions analyze --provider codex` exists.
- [x] `sessions analyze --provider codex` table output exits 0 and does not render Cursor-only sections.
- [x] `sessions analyze --provider codex --include-turns --extract-only --turn-query <text>` returns Codex evidence using the shared `extractSessionEvidence` path.
- [x] `sessions analyze --provider all` is still rejected.
- [x] Cursor command behavior and tests remain unchanged.
- [x] No tests read live `~/.codex`.
- [x] `pnpm vitest run test/sessions` exits 0.
- [x] `pnpm run check` exits 0.
- [x] `README.md`, `skills/session-evidence/SKILL.md`, and `dev/plans/README.md` are updated.

## STOP conditions

Stop and report back if:

- Current code no longer has the provider/cache/CLI shapes cited in "Current state".
- Codex local state schema does not contain a `threads` table with `id`, `rollout_path`, timestamp, title, source, and cwd-like fields.
- Root `~/.codex/state_5.sqlite` exists but appears stale/corrupt while fallback is newer. Do not auto-switch; report the conflict.
- Implementing Codex requires changing `extractSessionEvidence` semantics or adding provider-specific evidence buckets.
- Implementing parity requires touching `providers/codex/**`, `workflows/**`, or `automations/**`.
- Tests would require live private Codex data instead of fixtures.
- `node:sqlite` cannot open fixture/live DBs in the repo's supported Node version.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Keep Codex and Cursor as provider adapters. If a third provider appears, consider a provider registry only then.
- Watch for Codex DB schema drift. The parser should fail with clear messages and tests should cover missing optional columns where practical.
- Reviewer focus should be:
  - source-of-truth DB selection;
  - no live home-dir reads in tests;
  - no provider-specific analyzer logic leaking into `core/evidence.ts`;
  - conservative automation classification;
  - Cursor behavior preserved.
- `--provider all` is deliberately deferred. It needs cache merge semantics and deduplication decisions that are not required for Codex parity.
