# Plans & handoffs

## Active queue

| File                                                                               | Status        | Summary                                                   |
| ---------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------- |
| [260621-agent-harness-handoff.md](./260621-agent-harness-handoff.md)               | `in_progress` | Roadmap: `steps.json`, graders, triggers, Inngest         |
| [260704-factory-intake-routing.md](./260704-factory-intake-routing.md)             | `in_progress` | Factory intake triage, deterministic routing, local inbox |
| [260705-factory-operating-docs-smoke.md](./260705-factory-operating-docs-smoke.md) | `in_progress` | Factory operating docs, packaged skill, and smoke checks  |
| [260707-linear-planning-apply.md](./260707-linear-planning-apply.md)               | `approved`    | Linear write mode for the planning station                |

**Build after factory docs/smoke lands:** handoff Phase 0.6 (`steps.json`).

Parse-resilience remainder (retry, structured-output spike): [todo](../todo/260627-reviewer-json-parse-resilience.md).

Skill trees are intentionally not instruction-memory cleanup targets: `skills/` packaged installable skills; `.agents/skills/` repo-local dev skills. **Deferred:** `.agents/skills/{typescript-refactor,vitest,zod}/AGENTS.md` duplicate skill summaries — fix only in a separate skill-structure plan with explicit scope for skill trees.

---

## Shipped (git history only)

Completed plans are **removed from the tree** after land. Use merged PRs and `git log -- dev/plans/` for history — do not re-run old executor steps.

| Phase | Work                                          | PR                                                |
| ----- | --------------------------------------------- | ------------------------------------------------- |
| A     | Rightmost JSON + schema-aware parse           | [#33](https://github.com/ferueda/harness/pull/33) |
| B     | SDK stream JSONL + `streamArtifacts`          | [#34](https://github.com/ferueda/harness/pull/34) |
| C     | `events.jsonl` + `--verbose`                  | [#34](https://github.com/ferueda/harness/pull/34) |
| D     | Provider `AbortSignal`                        | [#36](https://github.com/ferueda/harness/pull/36) |
| E     | SDK-only reviews; `cursor-cli` skill launcher | [#37](https://github.com/ferueda/harness/pull/37) |
| —     | Shared review JSON parse                      | [#38](https://github.com/ferueda/harness/pull/38) |
| F     | Review-output schema ↔ Zod sync tests         | [#39](https://github.com/ferueda/harness/pull/39) |
| G     | Review-runtime hardening                      | [#40](https://github.com/ferueda/harness/pull/40) |
| H     | Sessions skill colocation                     | [#42](https://github.com/ferueda/harness/pull/42) |
| —     | Instruction memory prune                      | [#43](https://github.com/ferueda/harness/pull/43) |
| —     | Cursor display-title fallback                 | [#48](https://github.com/ferueda/harness/pull/48) |
| —     | Plan-review workflow                          | [#49](https://github.com/ferueda/harness/pull/49) |
| —     | Harness docs foundation                       | [#50](https://github.com/ferueda/harness/pull/50) |
| —     | Command/setup inventory                       | [#51](https://github.com/ferueda/harness/pull/51) |
| —     | Testing enforcement                           | [#52](https://github.com/ferueda/harness/pull/52) |
| —     | Project alignment rubric                      | [#54](https://github.com/ferueda/harness/pull/54) |
| —     | README slimdown                               | [#55](https://github.com/ferueda/harness/pull/55) |
| —     | Commit hygiene hooks                          | [#56](https://github.com/ferueda/harness/pull/56) |
| —     | Gate output runner                            | [#58](https://github.com/ferueda/harness/pull/58) |
| —     | Factory station API, sessions, and planning   | [#64](https://github.com/ferueda/harness/pull/64) |
| —     | Linear plan PR handoff                        | [#72](https://github.com/ferueda/harness/pull/72) |
| —     | Linear triage apply                           | [#74](https://github.com/ferueda/harness/pull/74) |
| —     | Linear planning input                         | [#75](https://github.com/ferueda/harness/pull/75) |

---

## Dependency notes

- Verification baseline and review runtime hardening shipped (`PR #39`, `PR #40`).
- Instruction/memory prune shipped — trimmed `AGENTS.md` and active roadmap; finished plans deleted (git history only).
- Handoff `steps.json` / graders are unblocked; build next per active queue.

---

**New plans:** `YYMMDD-short-slug.md` in this directory — reconcile here before adding. **When done:** remove the plan file and update this README shipped table; do not keep an `archive/` copy.
