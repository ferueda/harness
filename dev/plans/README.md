# Plans & handoffs

## Active queue

| File | Status | Summary |
| ---- | ------ | ------- |
| [260628-instruction-memory-prune.md](./260628-instruction-memory-prune.md) | `todo` | Prune always-loaded instructions, stale handoff memory, and ignored review run records without editing skill trees |
| [260621-agent-harness-handoff.md](./260621-agent-harness-handoff.md) | `in_progress` | Roadmap: `steps.json`, graders, triggers, Inngest |

**Build next:** instruction/memory prune, then handoff Phase 0.6 (`steps.json`).

Parse-resilience remainder (retry, structured-output spike): [todo](../todo/260627-reviewer-json-parse-resilience.md).

Skill trees are intentionally not cleanup targets here: `skills/` contains
packaged installable skills for target repos, while `.agents/skills/` contains
repo-local development skills for working on harness.

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
| F | [harness-verification-baseline](./archive/260628-harness-verification-baseline.md) | ✅ PR #39 |
| G | [review-runtime-hardening](./archive/260628-review-runtime-hardening.md) | ✅ PR #40 |
| H | [sessions-skill-colocation](./archive/260628-sessions-skill-colocation.md) | ✅ shipped |

---

## Dependency notes

- Verification baseline and review runtime hardening are archived (`PR #39`, `PR #40`).
- Instruction/memory prune has no dependency and should land before more
  planning work so future agents load less stale steering.
- Handoff `steps.json` / graders are unblocked; build after instruction cleanup.

---

**New plans:** `YYMMDD-short-slug.md` in this directory — reconcile here before adding. Move to `archive/` when done.
