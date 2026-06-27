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

_See **option 9** for gnhf-aligned detail and priority. Short form: use Cursor SDK / API native JSON-schema or structured-output mode when available for reviewer calls.

### 6. Regression tests

- Invalid newline inside finding → expect `Bad control character`, not `missing required property "verdict"`.
- Keep existing prose-prefix / nested-finding tests from `schema.test.ts`.

| Pros | Cons |
| ---- | ---- |
| Locks diagnostic quality | Tests only; no runtime fix |

### 7. Two-phase parse (gnhf `parseOpenCodeOutput` pattern)

Mirror rovodev/opencode/copilot in gnhf (`../gnhf/src/core/agents/opencode.ts`):

1. `parseAgentJson(text, accepts=schemaValid)` — schema-aware rightmost extraction
2. If null → `parseAgentJson(text)` without accepts → run full schema validation on result

Today harness `schemaValidationError` already does an unfiltered extract for diagnostics, but the **error message** can still be a nested-object schema miss instead of the original syntax failure. Align steps 1–2 with gnhf so phase-2 failures read like `findings[1].issue: expected string` or `verdict is required`, not a spurious nested fragment.

| Pros | Cons |
| ---- | ---- |
| Clearer errors when something parses but is wrong shape | Does not fix invalid syntax with no parseable top-level object |
| Matches proven gnhf integration pattern | Small refactor of `parseStructuredOutput` failure paths |

### 8. Parse-failure debug sample (gnhf `rovodev:output:parse-error`)

On `parseStructuredOutput` failure, attach to review artifact / meta:

- `parseError` (primary message)
- `resultTextLength`
- `resultTextSample` (first ~512 chars, same as gnhf)

Harness already persists SDK `raw.result` on failure; surfacing a sample in workflow meta (or `*.review.json` error field) avoids digging into `.raw.json` during triage.

| Pros | Cons |
| ---- | ---- |
| Fast incident diagnosis | Slightly larger review artifacts |

### 9. Provider-native structured output (gnhf primary path)

gnhf treats text extraction as **fallback only**. Primary paths:

| gnhf agent | Mechanism |
| ---------- | --------- |
| Claude | `--json-schema` → `structured_output` on result event |
| Codex | `--output-schema` file |
| OpenCode | API `json_schema` + `retryCount: 1`; prefer SSE `structured` over text |

Harness spike: Cursor SDK / CLI equivalents for reviewer calls so `parseStructuredOutput` is rarely exercised in production. OpenCode-style **`retryCount: 1` at the provider** is the closest analogue to harness option 3 without a full change-review re-run.

| Pros | Cons |
| ---- | ---- |
| Eliminates prose, fences, and most syntax errors at source | API support varies by runtime; CLI may stay text-only |

### 10. Runtime capability matrix (document + enforce)

Document per provider whether reviewers use **native structured output** or **text + `parseStructuredOutput`**. Fail fast or warn when a runtime is text-only and reviewers depend on strict JSON (gnhf effectively does this by agent-specific code paths).

| Pros | Cons |
| ---- | ---- |
| Sets expectations; guides SDK-default policy | Docs + small config surface |

---

## GNHF reference (what they do / what we skip)

**Adopt or align**

- `json-extract.ts` rightmost + `accepts` — already in harness `schema.ts` (PR #33).
- Two-phase parse + validation errors (option 7).
- Parse-failure log sample (option 8).
- Native structured output as primary path (option 9).
- Provider-level retry before workflow retry (OpenCode `retryCount: 1`).

**Skip or defer (different shape)**

- **ACP `lastOutputMessage` vs `outputBuf`** — gnhf splits streaming assistant messages at tool-call boundaries before parsing. Harness reviewers are one-shot final-text calls; only relevant if we add incremental/stream parsing for review steps.
- **`toStringArray` post-parse tolerance** — gnhf normalizes `key_learnings` when the model returns a JSON string instead of an array. Review output uses Zod/`ReviewOutputSchema`; type coercion belongs there if needed, not in JSON extraction.
- **Orchestrator iteration retry** — gnhf re-runs the whole agent iteration on throw. Harness `change-review` should use a **single targeted re-prompt** on parse failure (option 3), not a full workflow restart.

---

## Recommendations (priority order)

1. **Spike — structured output (option 9):** Highest leverage per gnhf; text extraction stays as fallback. Check Cursor SDK + CLI for JSON-schema-enforced final answers on reviewer invocations.
2. **Do first — diagnostics (option 2):** Report full-text `JSON.parse` failure before nested extraction. Low risk, immediate debug value.
3. **Do first — prompt (option 1):** One line in `wrapPrompt` about escaped newlines. Cheap hedge (gnhf prompt says JSON-only but does not mention control chars either).
4. **Do next — two-phase parse (option 7):** Port gnhf's explicit phase-1/phase-2 error semantics into `parseStructuredOutput`.
5. **Do next — tests (option 6):** Regression for malformed finding strings + misleading error message.
6. **Do next — debug sample (option 8):** Expose `resultTextSample` on parse failure in review meta.
7. **Consider — retry (option 3):** Provider-level first (`retryCount: 1` style), then change-review step retry on syntax error only. Good ROI (manual re-run already passed).
8. **Document — runtime matrix (option 10):** Which paths are native vs text-parse.
9. **Defer — repair (option 4):** gnhf does not repair invalid JSON either; only consider if structured output + retries are insufficient.

---

## Evidence

- Failed raw: `.harness/runs/reviews/20260627-191750-f2a819/simplify-review.raw.json` — newline at index 1273 in `result`.
- Passed re-run: `.harness/runs/reviews/20260627-192257-5214fe/simplify-review.json`.

---

## Out of scope

- Changing rightmost / schema-aware extraction semantics (already shipped).
- CLI parallel spawn failures (~2s empty `resultText`) — separate issue; mitigated by SDK default runtime.
