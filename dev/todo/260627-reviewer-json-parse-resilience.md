# Reviewer JSON parse resilience

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

Use Cursor SDK / API native JSON-schema or structured-output mode when available for reviewer calls.

| Pros | Cons |
| ---- | ---- |
| Strongest guarantee | Depends on API surface; may not cover all runtimes |

### 6. Regression tests

- Invalid newline inside finding → expect `Bad control character`, not `missing required property "verdict"`.
- Keep existing prose-prefix / nested-finding tests from `schema.test.ts`.

| Pros | Cons |
| ---- | ---- |
| Locks diagnostic quality | Tests only; no runtime fix |

---

## Recommendations (priority order)

1. **Do first — diagnostics (option 2):** Report full-text `JSON.parse` failure before nested extraction. Low risk, immediate debug value.
2. **Do first — prompt (option 1):** One line in `wrapPrompt` about escaped newlines. Cheap hedge.
3. **Do next — tests (option 6):** Regression for malformed finding strings + misleading error message.
4. **Consider — retry (option 3):** Single retry in change-review when `parseStructuredOutput` returns a syntax error (not schema enum mismatch). Good ROI for parallel reviewer runs.
5. **Defer — repair (option 4):** Only if retries are insufficient; prefer not to mutate agent text silently.
6. **Track — structured output (option 5):** Spike when SDK documents schema-enforced final answers for harness reviewers.

---

## Evidence

- Failed raw: `.harness/runs/reviews/20260627-191750-f2a819/simplify-review.raw.json` — newline at index 1273 in `result`.
- Passed re-run: `.harness/runs/reviews/20260627-192257-5214fe/simplify-review.json`.

---

## Out of scope

- Changing rightmost / schema-aware extraction semantics (already shipped).
- CLI parallel spawn failures (~2s empty `resultText`) — separate issue; mitigated by SDK default runtime.
