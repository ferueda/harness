# Plans & handoffs

## Active queue

- [Add the Inngest Factory operation-delivery adapter](FER-97.md) — approved; awaiting plan merge. [Linear](https://linear.app/ferueda/issue/FER-97/add-the-inngest-factory-operation-delivery-adapter)
- [Compose the Grove-backed hosted Factory operation runner](FER-96.md) — approved; awaiting plan merge. [Linear](https://linear.app/ferueda/issue/FER-96/compose-the-grove-backed-hosted-factory-operation-runner)
- [Reconcile runnable Factory operations into delivery hints](FER-98.md) — approved; awaiting plan merge. [Linear](https://linear.app/ferueda/issue/FER-98/reconcile-runnable-factory-operations-into-delivery-hints)
- [Record hosted Factory phase and continuation authority before delivery](FER-99.md) — approved; awaiting plan merge. [Linear](https://linear.app/ferueda/issue/FER-99/record-hosted-factory-phase-and-continuation-authority-before-delivery)
- [Remove obsolete Factory cutover paths](FER-188.md) — approved; awaiting plan merge. [Linear](https://linear.app/ferueda/issue/FER-188/remove-obsolete-factory-cutover-paths)

The archived handoff roadmap is no longer executor authority. Standalone review resumability, deterministic graders, hosted triggers, and orchestration remain unplanned future directions in the contributor architecture; revalidate them and create scoped Linear work before writing a new plan.

---

## Shipped (git history only)

Completed plans are **removed from the tree** after land. Use merged PRs and `git log -- dev/plans/` for history — do not re-run old executor steps.

| Phase | Work                                          | PR                                                                                                       |
| ----- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A     | Rightmost JSON + schema-aware parse           | [#33](https://github.com/ferueda/harness/pull/33)                                                        |
| B     | SDK stream JSONL + `streamArtifacts`          | [#34](https://github.com/ferueda/harness/pull/34)                                                        |
| C     | `events.jsonl` + `--verbose`                  | [#34](https://github.com/ferueda/harness/pull/34)                                                        |
| D     | Provider `AbortSignal`                        | [#36](https://github.com/ferueda/harness/pull/36)                                                        |
| E     | SDK-only reviews; `cursor-cli` skill launcher | [#37](https://github.com/ferueda/harness/pull/37)                                                        |
| —     | Shared review JSON parse                      | [#38](https://github.com/ferueda/harness/pull/38)                                                        |
| F     | Review-output schema ↔ Zod sync tests         | [#39](https://github.com/ferueda/harness/pull/39)                                                        |
| G     | Review-runtime hardening                      | [#40](https://github.com/ferueda/harness/pull/40)                                                        |
| H     | Sessions skill colocation                     | [#42](https://github.com/ferueda/harness/pull/42)                                                        |
| —     | Instruction memory prune                      | [#43](https://github.com/ferueda/harness/pull/43)                                                        |
| —     | Cursor display-title fallback                 | [#48](https://github.com/ferueda/harness/pull/48)                                                        |
| —     | Plan-review workflow                          | [#49](https://github.com/ferueda/harness/pull/49)                                                        |
| —     | Harness docs foundation                       | [#50](https://github.com/ferueda/harness/pull/50)                                                        |
| —     | Command/setup inventory                       | [#51](https://github.com/ferueda/harness/pull/51)                                                        |
| —     | Testing enforcement                           | [#52](https://github.com/ferueda/harness/pull/52)                                                        |
| —     | Project alignment rubric                      | [#54](https://github.com/ferueda/harness/pull/54)                                                        |
| —     | README slimdown                               | [#55](https://github.com/ferueda/harness/pull/55)                                                        |
| —     | Commit hygiene hooks                          | [#56](https://github.com/ferueda/harness/pull/56)                                                        |
| —     | Gate output runner                            | [#58](https://github.com/ferueda/harness/pull/58)                                                        |
| —     | Factory intake and deterministic routing      | [#60](https://github.com/ferueda/harness/pull/60)                                                        |
| —     | Factory station API, sessions, and planning   | [#64](https://github.com/ferueda/harness/pull/64)                                                        |
| —     | Factory operator docs and smoke coverage      | [#68](https://github.com/ferueda/harness/pull/68)                                                        |
| —     | Linear plan PR handoff                        | [#72](https://github.com/ferueda/harness/pull/72)                                                        |
| —     | Linear triage apply                           | [#74](https://github.com/ferueda/harness/pull/74)                                                        |
| —     | Linear planning input                         | [#75](https://github.com/ferueda/harness/pull/75)                                                        |
| —     | Linear planning apply                         | [#78](https://github.com/ferueda/harness/pull/78)                                                        |
| —     | Linear planning publish handoff apply         | [#80](https://github.com/ferueda/harness/pull/80)                                                        |
| —     | Factory lifecycle event log and read model    | [#85](https://github.com/ferueda/harness/pull/85)                                                        |
| —     | Read-only Linear status listing               | [#86](https://github.com/ferueda/harness/pull/86)                                                        |
| —     | Factory implementation input resolver         | [#88](https://github.com/ferueda/harness/pull/88)                                                        |
| —     | Factory implementation dry-run shell          | [#92](https://github.com/ferueda/harness/pull/92)                                                        |
| —     | Live factory implementation station           | [#94](https://github.com/ferueda/harness/pull/94)                                                        |
| —     | Constrained factory Linear create             | [#99](https://github.com/ferueda/harness/pull/99)                                                        |
| —     | Native Linear PR linking docs                 | [#102](https://github.com/ferueda/harness/pull/102)                                                      |
| —     | Trim factory dry-run from operator docs       | [#103](https://github.com/ferueda/harness/pull/103)                                                      |
| —     | Durable factory store                         | [#108](https://github.com/ferueda/harness/pull/108)                                                      |
| —     | Lifecycle-authoritative triage rerun policy   | [#111](https://github.com/ferueda/harness/pull/111)                                                      |
| —     | Fail-closed Linear implementation projection  | [#116](https://github.com/ferueda/harness/pull/116)                                                      |
| —     | Minimum-sufficient Factory planning contract  | [#123](https://github.com/ferueda/harness/pull/123), [#125](https://github.com/ferueda/harness/pull/125) |
| —     | Factory action kernel and manual triage       | [#127](https://github.com/ferueda/harness/pull/127)                                                      |
| —     | Manually stepped Factory planning             | [#129](https://github.com/ferueda/harness/pull/129)                                                      |
| —     | Planning/implementation/review authority      | [#130](https://github.com/ferueda/harness/pull/130)                                                      |
| —     | Factory implementation candidate and review   | [#135](https://github.com/ferueda/harness/pull/135)                                                      |
| —     | Factory implementation revisions              | [#143](https://github.com/ferueda/harness/pull/143)                                                      |
| —     | Read-only Factory work-item inspection        | [#146](https://github.com/ferueda/harness/pull/146)                                                      |
| —     | Factory pull-request publication              | [#149](https://github.com/ferueda/harness/pull/149)                                                      |
| —     | Provider-neutral Factory Git authority        | [#152](https://github.com/ferueda/harness/pull/152)                                                      |
| —     | Factory store contract version 2              | [#154](https://github.com/ferueda/harness/pull/154)                                                      |
| —     | Explicit Factory review continuations         | [#160](https://github.com/ferueda/harness/pull/160)                                                      |
| —     | Deterministic full-chain Factory smoke        | [#167](https://github.com/ferueda/harness/pull/167)                                                      |
| —     | Failed-role-only Factory review recovery      | [#172](https://github.com/ferueda/harness/pull/172)                                                      |

---

**New plans:** `YYMMDD-short-slug.md` in this directory — reconcile here before adding. Todo-like backlog spikes live in Linear; this directory is for approved implementation plans and handoffs. **When done:** remove the plan file and update this README shipped table; do not keep an `archive/` copy.
