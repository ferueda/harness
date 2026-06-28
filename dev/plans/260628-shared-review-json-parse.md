# Plan 260628-shared-review-json-parse: Shared review JSON parse stack in `lib/`

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise.

## Status

- **Status**: `done`
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (builds on shipped PR #33 parser in `providers/cursor/lib/schema.ts`)
- **Category**: tech-debt
- **Source**: planning session — harness-only parse consolidation; supersedes partial scope in `dev/todo/260627-reviewer-json-parse-resilience.md` for extraction + Codex wiring (todo remains for retry / structured-output spike)

## Why this matters

Harness reviewers share one contract (`schemas/review-output.schema.json`), but parsing is **provider-asymmetric** today:

- **Cursor SDK** (`providers/cursor/cursor-sdk-agent.ts`) uses `parseStructuredOutput` from `providers/cursor/lib/schema.ts` — fences, prose prefix, schema-aware rightmost extraction, validation.
- **Codex SDK** (`providers/codex/codex-agent.ts`) uses a local 15-line `JSON.parse(text)` on `turn.finalResponse` even though the turn already loads `outputSchema` from the same schema file.

Codex discards recovery logic the Cursor path already has. Models still prepend prose, wrap fences, or emit draft objects before the final review payload. That causes false parse failures on one provider but not the other for the same prompt contract.

This plan moves extraction + validation into `lib/` (harness infrastructure), wires Codex to the shared parser, then improves diagnostics for invalid top-level JSON — without mixing behavior changes into the mechanical move.

**Out of scope:** `skills/cursor-cli/` — standalone skill; not part of harness review runtime.

## Current state

| File | Role |
|------|------|
| `providers/cursor/lib/schema.ts` | ~300 LOC: extraction helpers, subset JSON Schema validator, `parseStructuredOutput`, `loadSchema`, `wrapPrompt` |
| `providers/cursor/lib/schema.test.ts` | 17 regression tests for `parseStructuredOutput` (prose, fences, nested findings, array roots) |
| `providers/cursor/cursor-sdk-agent.ts` | Imports `loadSchema`, `parseStructuredOutput`, `wrapPrompt` from `./lib/schema.ts`; parses `result.result` after `run.wait()` |
| `providers/codex/codex-agent.ts` | Loads schema for `outputSchema` (lines 57–61); parses `turn.finalResponse` with local `parseStructuredOutput` → `JSON.parse` only (lines 168–182) |
| `schemas/review-output.schema.json` | Review output contract |
| `dev/todo/260627-reviewer-json-parse-resilience.md` | Open follow-ups: syntax-error diagnostics, retry, structured-output spike |

**Critical invariant (PR #33):** Rightmost extraction must use a schema `accepts` predicate. Plain “last `{` object” can select a nested finding object inside a valid review. Do not regress this when moving code.

**Codex excerpt (naive parse — replace in Phase 2):**

```168:182:providers/codex/codex-agent.ts
function parseStructuredOutput(text: RunResult["finalResponse"]):
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: string;
    } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      error: `Codex final response was not valid JSON: ${errorMessage(error)}`,
    };
  }
}
```

**Repo conventions:**

- ESM with `.ts` import extensions (`import { x } from "./foo.ts"`).
- Vitest tests colocated with source (`lib/foo.test.ts` mirrors `providers/cursor/lib/schema.test.ts`).
- One atomic commit per file (user preference) — this plan uses **three logical phases** that may map to multiple file commits; group by phase, still one commit per file within a phase when practical.
- Format/lint: `npm run format`, `npm run lint`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Parse tests | `npm test -- lib/structured-output.test.ts` | all pass |
| Codex tests | `npm test -- providers/codex/codex-agent.test.ts` | all pass |
| Cursor provider tests | `npm test -- providers/cursor/cursor-sdk-agent.test.ts` | all pass |
| Full suite | `npm test` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Format check | `npm run format:check` | exit 0 |

## Skills for the executor

| Skill | Use for |
|-------|---------|
| `implement-plan` | Phase-by-phase execution |
| `.agents/skills/typescript-refactor` | Module extraction, explicit return types on exports |
| `.agents/skills/vitest` | Test moves and new Codex parse cases |

## Scope

**In scope:**

- `lib/json-extract.ts` (create)
- `lib/json-extract.test.ts` (create — extraction-only cases if split from orchestration tests)
- `lib/schema-validation.ts` (create) — **not** a general JSON Schema implementation; harness subset only
- `lib/schema-validation.test.ts` (create — validation-only cases, optional if kept in structured-output tests)
- `lib/structured-output.ts` (create) — `parseStructuredOutput`, `loadSchema` re-export or move `loadSchema` to schema-validation
- `lib/structured-output.test.ts` (create — port from `providers/cursor/lib/schema.test.ts`)
- `providers/cursor/lib/schema.ts` — thin: `wrapPrompt` + re-exports from `lib/` (Phase 1)
- `providers/cursor/cursor-sdk-agent.ts` — update imports if re-export path changes (Phase 1)
- `providers/codex/codex-agent.ts` — use shared `parseStructuredOutput` with schema (Phase 2)
- `providers/codex/codex-agent.test.ts` — prose/fence/nested-object cases (Phase 2)
- `dev/plans/README.md` — active queue row (this plan)

**Out of scope (do NOT touch):**

- `skills/cursor-cli/**` — separate product surface
- `schemas/review-output.schema.json` content
- `wrapPrompt` wording changes (prompt hardening deferred to todo)
- Provider retry on parse failure (todo option 3)
- Cursor SDK native structured-output spike (todo option 9)
- JSON repair / `jsonrepair` (todo option 4 — defer)

## Module layout

```
lib/
  json-extract.ts           # stripJsonFences, balancedJsonEnd, rightmost extract — no schema knowledge
  schema-validation.ts      # JsonSchema type, validateJsonSchema (harness subset), loadSchema
  structured-output.ts      # parseStructuredOutput orchestration

providers/cursor/lib/
  schema.ts                 # wrapPrompt only + re-exports (backward compat for cursor-sdk-agent imports)

providers/codex/
  codex-agent.ts            # import parseStructuredOutput from lib/structured-output.ts
```

**Naming note:** Use `lib/schema-validation.ts`, not `lib/json-schema.ts`. The validator is a small harness subset (type, enum, required, properties, additionalProperties, items) — document that in a file-level comment. It is not a standards-complete JSON Schema implementation.

## Steps

### Phase 1 — Move parser to `lib/` (preserve behavior)

**Goal:** Zero behavior change. Cursor path still works. Tests green.

#### Step 1.1: Create `lib/json-extract.ts`

Move from `providers/cursor/lib/schema.ts` (no logic changes):

- `stripJsonFences`
- `balancedJsonEnd`
- `tryExtractBalancedValue`
- `extractJsonText` (internal — export only if tests need it; prefer testing via `structured-output`)
- `extractRightmostParseableJson`
- `extractJsonFromText`

Add a brief module comment: pure text → JSON string extraction; no schema validation.

**Verify:** `npm run typecheck` → exit 0

#### Step 1.2: Create `lib/schema-validation.ts`

Move from `providers/cursor/lib/schema.ts`:

- `JsonSchema` type (export)
- `loadSchema`
- `validateJsonSchema` and helpers (`schemaAccepts`, `jsonTypeOf`) — keep private unless needed

Add file-level comment:

```ts
// Harness JSON Schema subset — not a full JSON Schema validator.
// Supports: type, enum, required, properties, additionalProperties, items.
```

**Verify:** `npm run typecheck` → exit 0

#### Step 1.3: Create `lib/structured-output.ts`

Move from `providers/cursor/lib/schema.ts`:

- `parseStructuredOutput`
- Wire imports from `./json-extract.ts` and `./schema-validation.ts`
- Keep exact success-path behavior from PR #33

**Verify:** `npm run typecheck` → exit 0

#### Step 1.4: Port tests to `lib/structured-output.test.ts`

Copy `providers/cursor/lib/schema.test.ts` → `lib/structured-output.test.ts`:

- Update imports to `./structured-output.ts` and `./schema-validation.ts` for `JsonSchema` type
- Keep `REVIEW_SCHEMA_PATH` pointing at `schemas/review-output.schema.json` (use `join` from `node:path` relative to test file — match existing pattern in `schema.test.ts`)

Delete or slim `providers/cursor/lib/schema.test.ts`:

- **Preferred:** delete `schema.test.ts` after port (single source of truth in `lib/`)
- If keeping a smoke test in cursor path, max 1–2 re-export tests only

**Verify:** `npm test -- lib/structured-output.test.ts` → all tests pass (same count as before)

#### Step 1.5: Thin `providers/cursor/lib/schema.ts`

Leave only:

- `wrapPrompt`
- Re-exports: `loadSchema`, `parseStructuredOutput`, `extractJsonFromText`, `JsonSchema` type from `lib/` paths

Remove duplicated implementation bodies.

Update `providers/cursor/cursor-sdk-agent.ts` imports only if you prefer direct `lib/` imports — either is fine if tests pass.

**Verify:**

- `npm test -- providers/cursor/cursor-sdk-agent.test.ts` → pass
- `npm test` → pass
- `npm run lint` → exit 0

**Phase 1 commit guidance:** One commit per new `lib/` file + one for `schema.ts` slim + one for test move/delete. Behavior must be identical — `git diff` on moved functions should be import-path only.

---

### Phase 2 — Wire Codex to shared parser

**Goal:** Codex uses `parseStructuredOutput(finalResponse, schema)` with the same schema object already loaded for `outputSchema`.

#### Step 2.1: Update `providers/codex/codex-agent.ts`

1. Import `parseStructuredOutput` from `../../lib/structured-output.ts` (adjust relative path).
2. Delete local `parseStructuredOutput` function (lines 168–182).
3. After turn completes (current line ~118), replace:

   ```ts
   const structuredOutput = parseStructuredOutput(turn.finalResponse);
   ```

   with:

   ```ts
   const parsed = parseStructuredOutput(turn.finalResponse, outputSchema);
   ```

4. Map `{ value, error }` shape to existing `AgentRunResult`:

   ```ts
   if (parsed.error) {
     return { ok: false, error: parsed.error, raw: turn, exitCode: 1 };
   }
   return { ok: true, structuredOutput: parsed.value, ... };
   ```

   Preserve existing error message prefixes where tests assert them — if shared parser messages differ slightly, update tests to match shared messages (prefer shared wording).

**Verify:** `npm run typecheck` → exit 0

#### Step 2.2: Add Codex parse recovery tests

In `providers/codex/codex-agent.test.ts`, add cases mirroring `lib/structured-output.test.ts` (use fake Codex with `finalResponse`):

| Test name | `finalResponse` shape | Expected |
|-----------|----------------------|----------|
| prose before valid review JSON | `"Here is my review:\n" + JSON.stringify(MINIMAL_REVIEW)` | `ok: true`, structured output matches |
| fenced JSON | `` ```json\n{...}\n``` `` | `ok: true` |
| nested finding objects in prose path | text from `structured-output.test.ts` "recovers top-level review when findings contain nested objects" | `ok: true`, top-level `verdict` present |
| invalid JSON only | `"not json"` | `ok: false`, error matches `/not valid JSON/i` |

Reuse `MINIMAL_REVIEW` fixture pattern from `lib/structured-output.test.ts` or inline equivalent minimal `{ verdict, findings }`.

**Verify:**

- `npm test -- providers/codex/codex-agent.test.ts` → all pass including new tests
- `npm test` → exit 0

**Phase 2 commit guidance:** `codex-agent.ts` in one commit; `codex-agent.test.ts` in one commit (per user atomic-commit preference).

---

### Phase 3 — Diagnostics for invalid top-level JSON

**Goal:** When full-document `JSON.parse` fails on cleaned text, surface that syntax error **before** rightmost nested-object fallback produces misleading messages like `missing required property "verdict"`.

Reference: `dev/todo/260627-reviewer-json-parse-resilience.md` options 2 + 7.

#### Step 3.1: Update failure paths in `lib/structured-output.ts`

In `parseStructuredOutput` when `schema` is provided:

1. After `extractStructuredJsonText` returns null, before `schemaValidationError`:
   - Run `stripJsonFences` + attempt `JSON.parse` on full cleaned text.
   - If parse throws, return `{ error: "Final answer was not valid JSON: <message>" }` immediately (use existing `parseJsonText` helper message format).

2. In `schemaValidationError`:
   - If unfiltered extract finds a nested fragment that fails schema with `missing required property "verdict"` but full-document parse already failed with a syntax error, prefer the syntax error (phase 1 check should short-circuit this — add test to confirm).

Do **not** change success-path extraction semantics from Phase 1.

**Verify:** `npm test -- lib/structured-output.test.ts` → pass

#### Step 3.2: Add regression test for misleading error

In `lib/structured-output.test.ts`:

```ts
test("parseStructuredOutput reports syntax error before nested-object schema miss", () => {
  // Payload with literal newline inside a string field (invalid JSON)
  // plus nested objects that could parse in isolation
  const text = '...'; // model from todo: unescaped newline in finding issue ~position 1273
  const result = parseStructuredOutput(text, REVIEW_SCHEMA);
  expect(result.error).toMatch(/not valid JSON|Bad control character/i);
  expect(result.error).not.toMatch(/missing required property "verdict"/);
});
```

Construct minimal invalid JSON: e.g. `{"verdict":"pass","findings":[{"issue":"line1\nline2"}]}` with a literal newline inside the quoted string.

**Verify:**

- `npm test -- lib/structured-output.test.ts` → new test passes
- `npm test` → exit 0
- `npm run format:check` → exit 0

**Phase 3 commit guidance:** `lib/structured-output.ts` one commit; `lib/structured-output.test.ts` one commit.

---

## Test plan

| File | Cases |
|------|-------|
| `lib/structured-output.test.ts` | Port all 17 existing cases from `schema.test.ts`; Phase 3 syntax-error regression |
| `lib/json-extract.test.ts` | Optional — only if extraction helpers are exported for direct unit test; otherwise covered by structured-output tests |
| `providers/codex/codex-agent.test.ts` | Phase 2: prose, fence, nested findings, invalid JSON |

**Pattern:** Model new Codex tests after existing `codex-agent.test.ts` fake factory (`createFakeCodex`).

**Verification:** `npm test` → exit 0; test count ≥ previous + 4 Codex + 1 diagnostic.

## Done criteria

ALL must hold:

- [ ] `lib/json-extract.ts`, `lib/schema-validation.ts`, `lib/structured-output.ts` exist; `providers/cursor/lib/schema.ts` contains only `wrapPrompt` + re-exports
- [ ] `providers/codex/codex-agent.ts` has no local `parseStructuredOutput`; uses shared parser with `outputSchema`
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run format:check` exits 0
- [ ] `rg 'function parseStructuredOutput' providers/codex` returns no matches
- [ ] `skills/cursor-cli` unchanged (`git diff --name-only` does not list it)
- [ ] `dev/plans/README.md` active queue updated; this plan status → `done` when merged

## STOP conditions

Stop and report back (do not improvise) if:

- `providers/cursor/lib/schema.ts` extraction logic differs from PR #33 behavior after Phase 1 move (run `lib/structured-output.test.ts` — any failure means move introduced a regression).
- Moving `loadSchema` breaks import paths in `cursor-sdk-agent.ts` or test schema loading.
- Shared `parseStructuredOutput` return shape `{ value?, error? }` cannot be mapped to Codex `AgentRunResult` without changing workflow contracts.
- Phase 3 diagnostic change alters any Phase 1 success-path test — revert diagnostic approach and report.
- You need to modify `skills/cursor-cli/` to complete this plan.

## Maintenance notes

- **Reviewer:** Phase 1 diff should be mostly file moves and import rewrites — scrutinize any logic change in extraction loops.
- **Future:** `dev/todo/260627-reviewer-json-parse-resilience.md` — retry, `wrapPrompt` newline line, `resultTextSample` on failure, Cursor SDK structured-output spike remain open; build on `lib/structured-output.ts`.
- **cursor-cli:** May continue duplicating parser logic independently; harness `lib/` is source of truth for `harness run change-review` only.
- **Validator growth:** If harness needs `$ref`, `oneOf`, etc., extend `lib/schema-validation.ts` explicitly or adopt a library — do not rename to imply full JSON Schema compliance.

## Follow-up (not this plan)

| Item | Where |
|------|-------|
| Provider retry on parse failure | todo option 3 |
| `wrapPrompt` escaped-newline line | todo option 1 |
| `resultTextSample` in review artifacts | todo option 8 |
| Cursor SDK native structured output | todo option 9 |
