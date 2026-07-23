# Architecture

## Purpose and audience

This is the navigation map for contributors changing Harness. It explains the
runtime paths, ownership boundaries, subsystem locations, and durable artifacts
needed to find the right code.

Use [Script and command surface](./script-command-surface.md) for public
commands and mutability, [Setup manifest](./setup-manifest.md) for requirements,
auth, and generated paths, and [Linear automation](./linear-automation.md) for
the self-hosted worker. Generated CLI help owns current flags.

## Runtime flows

Standalone reviews:

```text
CLI
  -> workspace and config resolution
  -> review context and immutable input artifacts
  -> workflow definition and review steps
  -> provider adapters
  -> structured results and aggregate verdict
  -> workspace-local review artifacts
```

Linear triage automation:

```text
self-hosted Inngest cron
  -> poll configured Linear Backlog revisions
  -> reload complete current issue context
  -> deterministic readiness policy
  -> provider-neutral triage request
  -> triage operation through the configured agent
  -> guarded Linear comment, label, and status writes
```

These paths share provider and configuration primitives, but not lifecycle
state. Reviews are explicit CLI runs. Linear is the issue queue and source of
truth for automation; Inngest owns delivery, retries, scheduling, and traces.

## Automation model

Automation is built from small operations with one-way dependencies:

```text
delivery and retries
  -> domain operation and policy
  -> standalone service and provider primitives
```

The delivery layer coordinates when work runs. A domain operation owns its
decision and structured result. Service modules communicate with an external
system without knowing which operation or delivery host called them. Adding a
new operation does not require adding a station to a shared lifecycle.

The current worker registers three independent functions: polling, readiness
routing, and triage. Spec and implementation requests are typed but remain
disabled until they have their own consumers.

### Automation construction contract

Build a new automation capability from the smallest set of these parts that its
first real flow needs:

| Part                         | Owns                                                                                        | Must not own                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Service primitive            | One external system's auth, SDK quirks, pagination, errors, and plain JSON-safe data        | Prompts, providers, Inngest, or domain workflow policy            |
| Domain operation             | Prompt or decision policy, normalized input, strict result validation, and provenance       | Tracker lifecycle, delivery retries, or concrete provider wiring  |
| Repository/compute primitive | Isolated execution, resumable workspace handles, change inspection, publication, cleanup    | Linear, Inngest, Spec, implementation, or other domain policy     |
| Projection adapter           | Guarded mapping from one domain result to external-system writes                            | Prompt policy, delivery scheduling, or a shared lifecycle engine  |
| Execution consumer           | Triggering, fresh reads, claims, durable steps, retries, ordering, coordination, and traces | SDK pagination, prompt rendering, Git commands, or domain choices |
| Event contract               | Minimal typed identifiers and stable work identity                                          | A cached replacement for current external truth                   |

Dependencies point inward from the execution consumer:

```text
execution consumer
  -> domain operation -> provider interface
  -> projection adapter -> service primitive
  -> repository/compute primitive
```

Concrete provider adapters, delivery hosts, and external SDK objects stay at
the edges. Inputs, outputs, event payloads, and resumable handles crossing a
durable step must be serializable.

An Inngest function is thin when its code reads as temporal coordination:

```text
receive identity
  -> reload current truth
  -> validate and claim
  -> call one domain operation
  -> validate and publish artifacts
  -> project the result
  -> emit the next event or end
```

Thin does not mean no branching. Delivery code may branch on a validated
operation result, retry side effects, serialize by work ID, and stop stale work.
It should not decide what a good Spec is, render a prompt, traverse an SDK, run
Git directly, or inline status and label policy. A projection adapter may start
co-located with one consumer, but keep its mapping explicit and Inngest-free so
it can move behind a small interface when another consumer needs it.

Human handoffs end a run. Linear later produces a new readiness snapshot when a
human returns the issue to an actionable state; a function does not wait for a
human inside one long-lived execution. Add shared abstractions only after two
real consumers expose the same stable contract.

## Ownership boundaries

| Owner             | Owns                                                                                                      | Does not own                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Harness checkout  | CLI, config and schemas, workflows, operations, providers, packaged skills, scripts, and contributor docs | Target product decisions, source, tests, or CI policy    |
| Target repository | `harness.json`, shim, optional installed skills, source, tests, project docs, and local review runs       | Harness provider internals or Inngest delivery state     |
| Linear            | Issue content, workflow status, labels, comments, blockers, and the durable work queue                    | Agent execution or delivery retries                      |
| Inngest           | Function delivery, retries, scheduling, concurrency, traces, and local event history                      | Triage policy or a second issue lifecycle                |
| Provider adapter  | Authentication, invocation, streams, sessions, sandbox settings, and provider result translation          | Domain routing, Linear projection, or target-repo policy |
| Git               | Committed plans and code                                                                                  | Linear issue state or Inngest delivery state             |

## Source map

| Area                     | Responsibility                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `bin/`                   | CLI entrypoint, generated help, and the persistent Linear worker command                                        |
| `lib/agent/`             | Provider-neutral Agent contract, invocation support, structured output, streams, sessions, and workspace guards |
| `lib/work-item/`         | Source-neutral normalized work-item, evidence, and portable-path schemas shared by proven operations            |
| `providers/`             | Cursor and Codex invocation, auth, streaming, sessions, sandboxing, and provider result translation             |
| `lib/config/`            | `harness.json` composition, workspace resolution, local initialization, and review option resolution            |
| `lib/review/`            | Review runtime, prompt context, aggregation, events, schemas, artifacts, handoffs, and run management           |
| `workflows/`             | Callable provider-neutral change-review and plan-review definitions                                             |
| `lib/linear/`            | Standalone, JSON-safe Linear read, write, pagination, and webhook primitives without domain or delivery policy  |
| `lib/triage/`            | Triage prompt, structured decision schema, and provider-independent operation                                   |
| `lib/spec/`              | Spec prompt, structured result schema, issue-key artifact validation, and provider-independent operation        |
| `lib/linear-automation/` | Linear readiness policy, application event contracts, Inngest functions, worker config, and process hosting     |
| `lib/skills/`            | Packaged-skill installation support                                                                             |
| `skills/`                | Packaged skills installed into target repositories                                                              |
| `.agents/skills/`        | Development-only skills for this Harness checkout                                                               |
| `schemas/`               | Exported JSON schemas that stay aligned with runtime validation                                                 |
| `scripts/`               | Build, distribution, smoke, and gate infrastructure                                                             |
| `automations/`           | Background task definitions                                                                                     |
| `dev/plans/`             | Active implementation plans and their index; not current architecture truth                                     |

Prefer these ownership clusters over a file-by-file mental model. A new source
file should live with the subsystem whose contract it extends.

## Runtime boundaries

### Review workflow boundary

`change-review` and `plan-review` use an immutable workflow context and callable
workflow definitions. Reviewers run through the shared provider interface and
write structured results beneath the run directory. Aggregation owns the final
verdict; provider adapters do not. Within `lib/review/`, `runtime.ts` composes a
run, `reviewer.ts` owns prompt and provider execution, and `run-report.ts` owns
durable summaries, metadata, stream records, and incomplete-run cleanup.

### Domain operation boundary

Domain operations accept plain serializable input and return validated
structured output. They own policy and prompt rendering, but they know nothing
about Inngest scheduling. Triage is read-only. Spec receives an isolated
writable workspace, writes one issue-keyed plan, and validates the claimed
artifact without publishing it. Both operations can be tested with a fake agent
without starting a worker.

### Service boundary

The Linear module resolves SDK relations, pagination, and failures behind a
small application interface. It returns plain data and does not import Inngest,
triage policy, prompts, or providers. Domain code owns route names and how a
decision maps to Linear status and labels. `client.ts` is the consumer facade,
`types.ts` is the public JSON-safe read contract, and issue context, revisions,
and lookups remain separate operations behind that facade.

### Provider boundary

Workflows and operations depend on the shared provider interface. Provider
auth, SDK or CLI invocation, streaming, session continuation, model policy, and
sandbox details stay under `providers/` or provider-scoped configuration.

### Delivery boundary

Inngest functions reload external truth before deciding or projecting. Event
payloads identify work; they do not replace current Linear issue context.
Revision-scoped event IDs and function concurrency make retries converge while
leaving Linear as the queue.

### Schema boundary

Runtime validation lives with its owner: operation schemas beside their
operation, review output under `lib/review/`, composed Harness configuration
under `lib/config/`, and feature configuration under the owning application.
Exported schemas live in `schemas/`. When a public structured contract changes,
check the runtime schema, exported schema, prompt, and consumer together.

## Artifact map

| Root                                             | Purpose                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `.harness/runs/reviews/<run-id>/`                | Review context, prompts, structured results, streams, summaries, metadata, and events |
| `.harness/bin/harness`                           | Ignored target-repo shim pointing to the Harness checkout that initialized it         |
| Self-hosted Inngest SQLite volume                | Local delivery history, retry state, function metadata, and traces                    |
| Protected worker environment file outside a repo | Linear, Inngest, and optional Codex credentials for one deployment                    |
| Dedicated worker Codex credential volume         | Optional unattended ChatGPT-backed Codex login, separate from the host account        |

Review artifacts are ignored workspace-local state. Self-hosted deployment
state and credentials are external user data. Neither belongs in Git.

## Current execution model

`harness linear worker` loads one `linearAutomation` configuration snapshot at
startup and registers the poller, readiness router, and triage consumer through
Inngest Connect. The worker caps total concurrency at one and exposes `/health`
plus Connect-backed `/ready` endpoints.

The one-minute poller lists revisions for one configured project's Backlog.
The readiness router reloads the complete issue context and emits a triage
request only when current Linear state requires it. Revision-bound request
identity lets a later Backlog revision request triage again without duplicating
work for an unchanged revision. The triage consumer invokes the configured
Codex profile and applies its rationale, Agent action label, and target status
through the standalone Linear service. Human handoffs use Needs Input and Needs
Review statuses; Spec and Implement labels only describe agent work.

For planned work, use `dev/plans/README.md`. Add future behavior here only after
it becomes a current repository relationship.
