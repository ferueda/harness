# Plans & handoffs

## Active queue

| File | Status | Summary |
| ---- | ------ | ------- |
| [260629-cursor-display-titles.md](./260629-cursor-display-titles.md) | `in_review` | Sessions: derive Cursor display titles from first query |
| [260621-agent-harness-handoff.md](./260621-agent-harness-handoff.md) | `in_progress` | Roadmap: `steps.json`, graders, triggers, Inngest |

**Build next:** handoff Phase 0.6 (`steps.json`).

Parse-resilience remainder (retry, structured-output spike): [todo](../todo/260627-reviewer-json-parse-resilience.md).

Skill trees are intentionally not instruction-memory cleanup targets: `skills/` packaged installable skills; `.agents/skills/` repo-local dev skills. **Deferred:** `.agents/skills/{typescript-refactor,vitest,zod}/AGENTS.md` duplicate skill summaries — fix only in a separate skill-structure plan with explicit scope for skill trees.

---

## Shipped (git history only)

Completed plans are **removed from the tree** after land. Use merged PRs and `git log -- dev/plans/` for history — do not re-run old executor steps.

| Phase | Work | PR |
| ----- | ---- | -- |
| A | Rightmost JSON + schema-aware parse | [#33](https://github.com/ferueda/harness/pull/33) |
| B | SDK stream JSONL + `streamArtifacts` | [#34](https://github.com/ferueda/harness/pull/34) |
| C | `events.jsonl` + `--verbose` | [#34](https://github.com/ferueda/harness/pull/34) |
| D | Provider `AbortSignal` | [#36](https://github.com/ferueda/harness/pull/36) |
| E | SDK-only reviews; `cursor-cli` skill launcher | [#37](https://github.com/ferueda/harness/pull/37) |
| — | Shared review JSON parse | [#38](https://github.com/ferueda/harness/pull/38) |
| F | Review-output schema ↔ Zod sync tests | [#39](https://github.com/ferueda/harness/pull/39) |
| G | Review-runtime hardening | [#40](https://github.com/ferueda/harness/pull/40) |
| H | Sessions skill colocation | [#42](https://github.com/ferueda/harness/pull/42) |
| — | Instruction memory prune | [#43](https://github.com/ferueda/harness/pull/43) |

---

## Dependency notes

- Verification baseline and review runtime hardening shipped (`PR #39`, `PR #40`).
- Instruction/memory prune shipped — trimmed `AGENTS.md` and active roadmap; finished plans deleted (git history only).
- Handoff `steps.json` / graders are unblocked; build next per active queue.

---

**New plans:** `YYMMDD-short-slug.md` in this directory — reconcile here before adding. **When done:** remove the plan file and update this README shipped table; do not keep an `archive/` copy.
