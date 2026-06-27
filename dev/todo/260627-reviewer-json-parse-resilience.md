# Reviewer JSON parse resilience

**Status:** `open` (todo — not an active plan)

**Context:** Change-review run `20260627-191750-f2a819` — implementation and quality passed; simplify failed to parse. Re-run `20260627-192257-5214fe` passed (flaky model output, not harness logic).

**Incident:** Simplify reviewer returned JSON-shaped text with a **literal newline** inside a finding `issue` string (position ~1273). `JSON.parse` fails with `Bad control character in string literal`. Rightmost extraction then grabbed a nested finding object; diagnostic error reported `missing required property "verdict"` instead of the syntax error.

**Related (done):** `dev/plans/260626-json-extract-rightmost-object.md` — rightmost + schema-aware `accepts` fixes **wrong-object selection** when prose or draft objects precede the real payload. This todo covers the **adjacent** failure class: syntactically invalid top-level JSON where nested fragments still parse.

---

## Failure classes

| Class | Symptom | Example | Status |
| ----- | ------- | ------- | ------ |
| **Selection** | Valid fragments; wrong blob chosen | Prose `{draft}` before final `{verdict,...}` | Addressed in PR #33 |
| **Syntax** | Top-level JSON invalid | Unescaped newline in string field | Open — this doc |

---

## Options

### 1. Prompt hardening (`wrapPrompt`)

Add to hard requirements in `providers/cursor/lib/schema.ts`:

- String values must be single-line; escape newlines as `\n` (no literal line breaks inside quotes).
- Re-emit compact JSON if the first attempt would be invalid.

| Pros | Cons |
| ---- | ---- |
| Zero runtime cost | Does not guarantee model compliance |

### 2. Better parse diagnostics (`parseStructuredOutput`)

When full-document `JSON.parse` fails on cleaned text, **surface that error first** before rightmost nested-object fallback in `schemaValidationError` / failure paths.

| Pros | Cons |
| ---- | ---- |
| Operators see real cause (`Bad control character at N`) | No recovery; clarity only |
| Small, behavior-neutral change on success path | |

### 3. Workflow retry on parse failure

In `change-review` (or provider): one retry with feedback — *"Your final answer was not valid JSON: … Return ONLY valid JSON conforming to the schema."*

| Pros | Cons |
| ---- | ---- |
| High fix rate for flaky syntax (re-run passed) | Extra latency + token cost per failure |

### 4. JSON repair pass

Optional pre-parse repair (e.g. escape control chars inside strings, `jsonrepair`-style).

| Pros | Cons |
| ---- | ---- |
| May recover without re-invoking agent | Risk of silently mutating meaning; hard to test all edge cases |

### 5. Provider structured output

See **option 9** for detail and priority. Short form: use Cursor SDK native schema/structured-output support if available, and keep Codex `outputSchema` on reviewer calls.

### 6. Regression tests

- Invalid newline inside finding → expect `Bad control character`, not `missing required property "verdict"`.
- Keep existing prose-prefix / nested-finding tests from `schema.test.ts`.

| Pros | Cons |
| ---- | ---- |
| Locks diagnostic quality | Tests only; no runtime fix |

### 7. Two-phase parse

1. `parseAgentJson(text, accepts=schemaValid)` — schema-aware rightmost extraction
2. If null → `parseAgentJson(text)` without accepts → run full schema validation on result

Today harness `schemaValidationError` already does an unfiltered extract for diagnostics, but the **error message** can still be a nested-object schema miss instead of the original syntax failure. Align steps 1–2 so phase-2 failures read like `findings[1].issue: expected string` or `verdict is required`, not a spurious nested fragment.

| Pros | Cons |
| ---- | ---- |
| Clearer errors when something parses but is wrong shape | Does not fix invalid syntax with no parseable top-level object |
| Matches the existing parser direction | Small refactor of `parseStructuredOutput` failure paths |

### 8. Parse-failure debug sample

On `parseStructuredOutput` failure, attach to review artifact / meta:

- `parseError` (primary message)
- `resultTextLength`
- `resultTextSample` (first ~512 chars)

Harness already persists SDK `raw.result` on failure; surfacing a sample in workflow meta (or `*.review.json` error field) avoids digging into `.raw.json` during triage.

| Pros | Cons |
| ---- | ---- |
| Fast incident diagnosis | Slightly larger review artifacts |

### 9. Provider-native structured output

Treat text extraction as **fallback only** where SDK support allows.

| Provider | Target mechanism |
| ---------- | --------- |
| Cursor SDK | Prefer native JSON-schema / structured output if exposed by the installed SDK; otherwise keep prompt wrapping + parser fallback |
| Codex SDK | Keep `outputSchema`; after stream logging, preserve it on `runStreamed()` turn options |

Harness spike: Cursor SDK equivalent for reviewer calls so `parseStructuredOutput` is rarely exercised in production. A provider-level **single retry** on schema/syntax failure is the closest analogue to harness option 3 without a full change-review re-run.

| Pros | Cons |
| ---- | ---- |
| Eliminates prose, fences, and most syntax errors at source | Cursor SDK support must be verified; text fallback may remain necessary |

### 10. Runtime capability matrix (document + enforce)

Document the SDK provider parse path:

- Cursor SDK: native structured-output spike vs `parseStructuredOutput` on `RunResult.result`.
- Codex SDK: `outputSchema` on turn options plus `finalResponse` parsing; stream events remain for forensics, not verdict extraction.

Fail fast or warn when a provider path is text-only and reviewers depend on strict JSON.

| Pros | Cons |
| ---- | ---- |
| Sets expectations; guides SDK-default policy | Docs + small config surface |

---

## Alignment notes

**Adopt or align**

- Two-phase parse + validation errors (option 7).
- Parse-failure log sample (option 8).
- Native structured output as primary path (option 9).
- Provider-level retry before workflow retry.

**Skip or defer (different shape)**

- Streaming assistant buffers as a parsing source — SDK stream logs are for forensics, not verdict extraction.
- Post-parse type coercion — review output uses Zod/`ReviewOutputSchema`; type coercion belongs there if needed, not in JSON extraction.
- Whole-workflow retry — harness `change-review` should use a **single targeted re-prompt** on parse failure (option 3), not a full workflow restart.

---

## Recommendations (priority order)

1. **Spike — structured output (option 9):** Highest leverage; text extraction stays as fallback. Check Cursor SDK for JSON-schema-enforced final answers on reviewer invocations; keep Codex `outputSchema`.
2. **Do first — diagnostics (option 2):** Report full-text `JSON.parse` failure before nested extraction. Low risk, immediate debug value.
3. **Do first — prompt (option 1):** One line in `wrapPrompt` about escaped newlines. Cheap hedge.
4. **Do next — two-phase parse (option 7):** Add explicit phase-1/phase-2 error semantics into `parseStructuredOutput`.
5. **Do next — tests (option 6):** Regression for malformed finding strings + misleading error message.
6. **Do next — debug sample (option 8):** Expose `resultTextSample` on parse failure in review meta.
7. **Consider — retry (option 3):** Provider-level first (`retryCount: 1` style), then change-review step retry on syntax error only. Good ROI (manual re-run already passed).
8. **Document — runtime matrix (option 10):** Which paths are native vs text-parse.
9. **Defer — repair (option 4):** Only consider if structured output + retries are insufficient.

---

## Evidence

- Failed raw: `.harness/runs/reviews/20260627-191750-f2a819/simplify-review.raw.json` — newline at index 1273 in `result`.
- Passed re-run: `.harness/runs/reviews/20260627-192257-5214fe/simplify-review.json`.

---

## Out of scope

- Changing rightmost / schema-aware extraction semantics (already shipped).
- Legacy Cursor CLI parallel spawn failures — separate issue; mitigated by SDK default runtime and future CLI review-runtime removal.
