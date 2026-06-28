# Plan 260628-harness-verification-baseline: Lock review-output schemas (vitest lib gate already shipped)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `dev/plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 63b01fc..HEAD -- vitest.config.ts lib/structured-output.test.ts schemas/review-output.schema.json lib/schemas.ts lib/schema-validation.ts test/`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Status**: `done`
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `63b01fc`, 2026-06-28
- **Revised**: 2026-06-28 — post `review-spec` (pass 2); Step 1 already landed at baseline

## Why this matters

`lib/structured-output.test.ts` holds 18 regression tests for review JSON extraction. At plan baseline (`63b01fc`), Vitest **already** includes `lib/**/*.test.ts` — that gate is shipped. The remaining gap is drift between two hand-maintained review-output definitions: `schemas/review-output.schema.json` (agent boundary) and `lib/schemas.ts` `ReviewOutputSchema` (post-parse Zod). `lib/schema-validation.ts` is a generic subset validator engine, not a third copy of the shape. A sync test ensures enum/strictness changes fail CI until both definitions are updated together.

## Current state

- `vitest.config.ts:7-12` — **already** includes `"lib/**/*.test.ts"` at baseline (shipped in `63b01fc`).
- `lib/structured-output.test.ts` — 18 `test()` blocks for `parseStructuredOutput`. Colocated; runs in default suite today.
- `schemas/review-output.schema.json` — JSON Schema sent to agents (Cursor `wrapPrompt`, Codex `outputSchema`).
- `lib/schemas.ts:49-67` — `ReviewOutputSchema` Zod used in `parseReviewerOutput` (`lib/workflow-context.ts:469-479`).
- `lib/schema-validation.ts` — runtime engine; `schemaAccepts` used during extraction in `lib/structured-output.ts`.

Excerpt — vitest include at baseline:

```ts
// vitest.config.ts:7-12
include: [
  "test/**/*.test.ts",
  "lib/**/*.test.ts",
  "providers/**/*.test.ts",
  "skills/cursor-cli/**/*.test.ts",
],
```

File-load pattern to reuse (from `lib/structured-output.test.ts:1-9`):

```ts
const REVIEW_SCHEMA_PATH = join(MODULE_ROOT, "../schemas/review-output.schema.json");
const REVIEW_SCHEMA = JSON.parse(readFileSync(REVIEW_SCHEMA_PATH, "utf8")) as JsonSchema;
```

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Tests     | `pnpm test` | exit 0 |
| List lib tests | `pnpm exec vitest list lib/structured-output.test.ts` | lists 18 tests |
| Typecheck | `pnpm typecheck` | exit 0 |
| Full gate | `pnpm check` | exit 0 |

## Suggested executor toolkit

| Skill / resource | Use for |
|------------------|---------|
| `vitest` (`.agents/skills/vitest/SKILL.md`) | Colocated tests, fixture parity |
| `zod` (`.agents/skills/zod/SKILL.md`) | `ReviewOutputSchema.safeParse` — prefer fixtures over Zod introspection |

## Scope

**In scope**:
- `test/review-output-schema-sync.test.ts` (create)
- `dev/plans/README.md` (status row only)

**Out of scope**:
- `vitest.config.ts` — already correct at baseline; verify only in Step 1
- `schemas/review-output.schema.json` / `lib/schemas.ts` content changes (unless sync test reveals real drift — then STOP)
- JSON Schema → Zod codegen (deferred until review output shape changes for graders)
- `skills/cursor-cli/lib/schema.test.ts` consolidation
- Provider or workflow code

## Git workflow

- Branch: `feat/harness-verification-baseline` (or repo convention)
- One commit per file (repo `AGENTS.md` convention)
- Conventional commits: `test: ...`, `chore: ...`
- Do NOT push or open a PR unless the operator asks

## Steps

### Step 1: Verify lib tests already in Vitest (no config edit expected)

Confirm `vitest.config.ts` includes `"lib/**/*.test.ts"`. **Do not edit** if already present.

**Verify**:
```bash
pnpm exec vitest list lib/structured-output.test.ts | head -5
```
→ lists tests (not empty).

```bash
pnpm test
```
→ exit 0; `lib/structured-output.test.ts` runs.

If `lib/**/*.test.ts` is **missing** from config (drift since baseline), add it and report drift in commit message.

### Step 2: Add review-output schema sync test

Create `test/review-output-schema-sync.test.ts`. Use the file-load pattern from `lib/structured-output.test.ts:1-9` (`readFileSync` + `JSON.parse` of `schemas/review-output.schema.json`). Import `ReviewOutputSchema` from `lib/schemas.ts` and `schemaAccepts` from `lib/schema-validation.ts`.

**JSON file assertions** (navigate via `schema.properties…` and `schema.properties.findings.items.properties…`):

- Root `required`: `verdict`, `summary`, `findings`
- Root `additionalProperties === false`
- `properties.verdict.enum`: `pass`, `needs_changes`, `blocked`
- Finding item `required` (exact set, order-independent): `title`, `severity`, `location`, `issue`, `recommendation`, `rationale`, `must_fix`
- Finding item `additionalProperties === false`
- `properties.findings.items.properties.severity.enum`: `Critical`, `High`, `Medium`, `Low`
- String finding fields and `must_fix` have `type: "string"` / `type: "boolean"` respectively in JSON (or cover via negative fixture below)

**Positive parity** — each payload must pass **both** `schemaAccepts(REVIEW_SCHEMA, payload)` and `ReviewOutputSchema.safeParse(payload)`:

| Fixture | Purpose |
|---------|---------|
| Minimal `pass` | `verdict: "pass"`, empty `findings` |
| `needs_changes` | non-default verdict |
| `blocked` | third verdict enum |
| One finding per severity | exercises all four severity enums |

**Strictness parity** — payload with extra top-level key **or** extra finding field must fail **both** validators.

**Negative parity** — at least four invalid payloads; for each assert `schemaAccepts(REVIEW_SCHEMA, payload) === false` **and** `ReviewOutputSchema.safeParse(payload).success === false`:

- Wrong `verdict` enum
- Missing `summary`
- `must_fix` as string (not boolean)
- Numeric `title` on a finding (type mismatch — catches JSON `type` drift Zod would reject)

Do **not** add a code generator or Zod `.shape` introspection — fixture parity only.

**Verify**:
```bash
pnpm test -- test/review-output-schema-sync.test.ts
```
→ exit 0.

```bash
pnpm exec vitest list test/review-output-schema-sync.test.ts | wc -l
```
→ exit 0; sync file should define ≥8 `test()` cases (structure, positives, strictness, negatives).

```bash
pnpm test
```
→ exit 0.

### Step 3: Update plans index

Mark this plan `done` in `dev/plans/README.md` when complete.

**Verify**: `grep 260628-harness-verification-baseline dev/plans/README.md` → row present with `done`.

## Test plan

- Existing: `lib/structured-output.test.ts` — 18 cases (already in CI).
- New: `test/review-output-schema-sync.test.ts` — JSON file structure, positive/negative parity, `additionalProperties` / `.strict()` alignment.

## Done criteria

- [x] `vitest.config.ts` includes `lib/**/*.test.ts` (verify; already true at baseline)
- [x] `pnpm exec vitest list lib/structured-output.test.ts` lists 18 tests
- [x] `test/review-output-schema-sync.test.ts` exists with positive, negative, and strictness parity cases
- [x] `pnpm test` exit 0
- [x] `pnpm typecheck` exit 0
- [x] `pnpm check` exit 0
- [x] `dev/plans/README.md` status `done`
- [x] No files outside scope modified

## STOP conditions

Stop and report if:

- Sync test reveals JSON Schema and Zod **actually diverged** on required fields/enums — report diff; do not silently edit schemas without operator approval.
- `lib/structured-output.test.ts` fails in CI — fix only within scope; if fix needs provider changes, STOP.
- Step verification fails twice after a reasonable fix attempt.

## Maintenance notes

- When review output shape changes (e.g. grader fields in Loop 2), update **both** `schemas/review-output.schema.json` and `ReviewOutputSchema`, and extend the sync test in the same PR.
- Full JSON Schema → Zod codegen deferred until the next schema shape change.
- `skills/cursor-cli/lib/schema.test.ts` duplicates much of `structured-output` tests — consolidation out of scope.
