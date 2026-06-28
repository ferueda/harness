# Plans & handoffs

## Active queue

| File | Status | Summary |
| ---- | ------ | ------- |
| [260628-harness-verification-baseline.md](./260628-harness-verification-baseline.md) | `ready` | Review-output schema sync test |
| [260628-review-runtime-hardening.md](./260628-review-runtime-hardening.md) | `ready` | Review-guard, agent-invoke, registry, CLI abort |
| [260621-agent-harness-handoff.md](./260621-agent-harness-handoff.md) | `in_progress` | Roadmap: `steps.json`, graders, triggers, Inngest |

**Build next:** [verification baseline](./260628-harness-verification-baseline.md) → [review runtime hardening](./260628-review-runtime-hardening.md) → handoff Phase 0.6 (`steps.json`).

Parse-resilience remainder (retry, structured-output spike): [todo](../todo/260627-reviewer-json-parse-resilience.md).

---

## Archive

Shipped and superseded plans live in [`archive/`](./archive/README.md). Do not re-run archived executor steps.

| Phase | Plan | Status |
| ----- | ---- | ------ |
| A | [json-extract-rightmost-object](./archive/260626-json-extract-rightmost-object.md) | ✅ PR #33 |
| B | [sdk-agent-stream-logs](./archive/260627-sdk-agent-stream-logs.md) | ✅ PR #34 |
| C | [workflow-step-events](./archive/260626-workflow-step-events.md) | ✅ PR #34 |
| D | [agent-abort-signal](./archive/260626-agent-abort-signal.md) | ✅ PR #36 |
| E | [remove-cursor-cli-review-runtime](./archive/260627-remove-cursor-cli-review-runtime.md) | ✅ PR #37 |
| — | [shared-review-json-parse](./archive/260628-shared-review-json-parse.md) | ✅ shipped |
| F | [harness-verification-baseline](./260628-harness-verification-baseline.md) | 📋 ready |
| G | [review-runtime-hardening](./260628-review-runtime-hardening.md) | 📋 ready |

---

## Dependency notes

- `260628-review-runtime-hardening` depends on `260628-harness-verification-baseline` (`done` hard gate).
- Handoff `steps.json` / graders follow Phase G.

---

**New plans:** `YYMMDD-short-slug.md` in this directory — reconcile here before adding. Move to `archive/` when done.
