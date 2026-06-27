# Plan 260626-json-extract-rightmost-object: Prefer rightmost JSON object when parsing reviewer output

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Source**: reviewer parse failure follow-up
- **Revised**: 2026-06-26 — round 2: schema path bypasses `extractJsonFromText`; reuse `balancedJsonEnd`; envelope integration fixture

## Why this matters

Harness reviewers are instructed to return JSON only, but models often prepend analysis or wrap output in fences. Today `extractJsonFromText` in `providers/cursor/lib/schema.ts` scans **left-to-right** and returns the **first** parseable JSON value (`firstParseableJsonValue`). When prose contains an earlier `{...}` fragment or the model emits a draft object before the final review payload, harness can parse the wrong object and fail schema validation or accept a spurious verdict.

**Critical edge case (review-spec):** Rightmost `{` scan **without** schema acceptance can grab a **nested finding object** inside a valid review when the model prepends prose. A payload with non-empty `findings` ends with a finding `{...}` — naive rightmost scan may extract that nested object instead of the top-level review. Schema-aware `accepts` is **required**, not optional.

The target direction is rightmost extraction with optional schema acceptance. Regression coverage should include prose before JSON, multiple objects, nested braces in strings, and nested review findings.

**Primary caller context:** Another AI agent invokes `harness run change-review`, then reads `structuredOutput`, `*-review.json`, and `failedReviews`. Parse failures surface as failed reviewers — this plan reduces false failures.

## Current state

- `providers/cursor/lib/schema.ts` — `extractJsonFromText` → `firstParseableJsonValue` (left-to-right, lines 43–65); also supports `[` array roots via `balancedJsonEnd`
- `parseStructuredOutput` (line 98) calls `extractJsonFromText` then `JSON.parse` + `validateJsonSchema`
- Consumers: `providers/cursor/cursor-agent.ts`, `providers/cursor/cursor-sdk-agent.ts`, `lib/workflow-context.ts` (via provider)
- Codex: separate parser in `providers/codex/codex-agent.ts` — out of scope

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `npm run typecheck` | exit 0 |
| Schema tests | `npm test -- providers/cursor/lib/schema.test.ts` | all pass |
| Provider tests | `npm test -- providers/cursor/cursor-agent.test.ts` | all pass |
| Full suite | `npm test` | exit 0 |
| Lint | `npm run lint` | exit 0 |

## Suggested executor toolkit

| Skill / doc | Use for |
|-------------|---------|
| `implement-plan` | Phase execution |
| `.agents/skills/typescript-refactor` | Balanced-brace parsing |
| `.agents/skills/vitest` | Test structure |

## Scope

**In scope:**
- `providers/cursor/lib/schema.ts`
- `providers/cursor/lib/schema.test.ts` — **create**
- `providers/cursor/cursor-agent.test.ts` — add one prose+findings envelope test
- `dev/plans/README.md` — status row update

**Out of scope:**
- `providers/codex/codex-agent.ts`
- `wrapPrompt` wording changes
- `schemas/review-output.schema.json` content changes

## Steps

### Step 1: Add extraction helpers (objects + arrays)

In `providers/cursor/lib/schema.ts`:

1. `stripJsonFences(text)` — remove surrounding JSON fences
2. `tryExtractBalancedValue(text, start)` — delegate to existing `balancedJsonEnd` (```67:96:providers/cursor/lib/schema.ts```) + `JSON.parse` check for `{` or `[` roots
3. `tryExtractBalancedObject(text, start)` — thin wrapper: `{`-only via `tryExtractBalancedValue`
4. `extractLastJsonObject(text, accepts?)` — rightmost `{` scan
5. `extractLastJsonValue(text, accepts?)` — rightmost `{` or `[` for array schemas

Do **not** duplicate brace walkers — reuse `balancedJsonEnd` for string/escape handling.

**Verify**: `npm run typecheck` → exit 0

### Step 2: Wire `parseStructuredOutput` with required schema-aware acceptance

**Critical:** When `schema` is provided, `parseStructuredOutput` must **not** call `extractJsonFromText` for extraction. Implement this pipeline:

```typescript
const accepts = (value: unknown) => !validateJsonSchema(value, schema, "$");
```

1. Fence-strip input text
2. **Fast path:** whole string → `JSON.parse` → if `accepts(parsed)` return value; if parse succeeds but `!accepts(parsed)`, **fall through** (do not return error yet)
3. **Fallback:** `extractLastJsonObject(text, accepts)` then `extractLastJsonValue(text, accepts)` for array-root schemas
4. `JSON.parse` winning candidate → existing `validateJsonSchema` (should already pass if `accepts` used)

When `schema` is **undefined** (free-form CLI JSON): update `extractJsonFromText` to use rightmost logic (not `firstParseableJsonValue`) for the no-schema path only.

**Do not ship** rightmost scan without schema-aware `accepts` when schema is present.

**Verify**: `npm test -- providers/cursor/cursor-agent.test.ts` → all pass

### Step 3: Unit regression tests

Create `providers/cursor/lib/schema.test.ts`. Include these cases:

| Case | Expected |
|------|----------|
| Pure JSON object | parses |
| Pure JSON array (array schema) | parses |
| Fenced JSON | parses |
| Prose before JSON (rovodev case) | top-level object |
| **Prose before review with `findings: [{...}]`** | **top-level review, not nested finding** |
| Multiple objects — draft then final | last valid per schema |
| Braces inside strings | correct extraction |
| Trailing prose after JSON `{"verdict":...}\n\nDone!` | top-level object |
| No JSON | error from `parseStructuredOutput` |

Load `schemas/review-output.schema.json` for review cases.

**Verify**: `npm test -- providers/cursor/lib/schema.test.ts` → all pass

### Step 4: Integration test — Cursor provider envelope

In `providers/cursor/cursor-agent.test.ts`, add test matching production path:

1. Fake `agent` emits **stream-json** NDJSON with `type: "result"` whose `result` text is **prose + full review JSON** with ≥1 finding in `findings[]`
2. Invoke wrapper with `--schema <repo>/schemas/review-output.schema.json` (same as `change-review`)
3. Assert envelope `status === "completed"` and `structuredOutput.verdict` is defined

Follow existing stream-json envelope test pattern (~lines 100–124 in `cursor-agent.test.ts`).

**SDK pivot note:** This step records the historical fixture used when the plan was implemented. Do not add new Cursor CLI coverage for this done plan. Future parser regressions should prefer `providers/cursor/cursor-sdk-agent.test.ts` unless the legacy CLI runtime is still explicitly supported.

**Verify**: `npm test -- providers/cursor/cursor-agent.test.ts` → pass

### Step 5: Full verification

**Verify**: `npm test` && `npm run lint` → exit 0

## Test plan

- `providers/cursor/lib/schema.test.ts` — ≥10 cases including nested-findings regression
- `providers/cursor/cursor-agent.test.ts` — existing + prose+findings envelope test
- No workflow test required in this plan (provider-layer fix; workflow unchanged)

## Workflow / CLI / agent impact

| Surface | Change |
|---------|--------|
| `harness run change-review` | Fewer false `failedReviews` from parse errors |
| Cursor provider schema parsing | Same extraction path; array schemas preserved |
| stdout / meta.json | No shape change |
| AI agent caller | Reads same artifacts; more successful `*-review.json` |

## Done criteria

- [x] `npm run typecheck` exits 0
- [x] `npm test` exits 0
- [x] `schema.test.ts` includes prose + non-empty `findings` regression
- [x] `parseStructuredOutput` uses schema-aware `accepts` when schema provided
- [x] Array-root extraction preserved for array schemas
- [x] `extractJsonFromText` no longer uses left-to-right `firstParseableJsonValue`
- [x] `dev/plans/README.md` status row updated

## STOP conditions

Stop and report if:

- Schema-aware acceptance cannot reject nested finding objects without breaking valid reviews.
- Fix requires changing `schemas/review-output.schema.json`.
- Codex path needs changes to keep suite green.

## Maintenance notes

- SDK stream logging keeps final verdict parsing on completed provider output, so final Cursor SDK text still flows through `parseStructuredOutput`.
- PR focus: nested-findings regression, string escapes, array-root backward compatibility.
