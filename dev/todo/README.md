# Todo backlog

Lightweight follow-ups and spikes — not full implementation plans. For scoped work with phases and acceptance criteria, use `dev/plans/`.

| File                                                                                             | Status            | Summary                                                                                 |
| ------------------------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------- |
| [260704-factory-github-inngest-architecture.md](./260704-factory-github-inngest-architecture.md) | `open`            | Future GitHub Issues tracker, Inngest orchestration, and event backend                  |
| [260704-factory-planner-station.md](./260704-factory-planner-station.md)                         | `shipped-context` | Planning station shipped; keep residual implementation-station context                  |
| [260704-factory-adapters-orchestration.md](./260704-factory-adapters-orchestration.md)           | `open`            | Linear shipped through plan handoff; remaining GitHub/Inngest/implementation boundaries |
| [260627-reviewer-json-parse-resilience.md](./260627-reviewer-json-parse-resilience.md)           | `open`            | Syntax-class parse failures; diagnostics, structured output spike, retry                |

**Shipped (plan/todo context):** Selection-class parse failures — PR [#33](https://github.com/ferueda/harness/pull/33) (`parseStructuredOutput` rightmost + schema-aware `accepts`).

**Shipped factory slices:** factory planning station [#64](https://github.com/ferueda/harness/pull/64), factory operator docs/smoke [#68](https://github.com/ferueda/harness/pull/68), Linear fetch/triage/planning through ready-to-implement [#70](https://github.com/ferueda/harness/pull/70), [#71](https://github.com/ferueda/harness/pull/71), [#74](https://github.com/ferueda/harness/pull/74), [#75](https://github.com/ferueda/harness/pull/75), [#78](https://github.com/ferueda/harness/pull/78), [#80](https://github.com/ferueda/harness/pull/80).

**Active plan queue:** [`dev/plans/README.md`](../plans/README.md). Next factory feature should start from a fresh implementation-station plan instead of replaying shipped planning slices.
