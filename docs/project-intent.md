# Project intent

## What this repo is

`harness` is a personal agent workflow harness. It keeps reusable skills,
callable review and planning workflows, standalone service primitives, runner
code, provider adapters, automations, plans, schemas, scripts, and review
artifact conventions in one repository.

The repo is both a tool and its own reference target: harness can run against
external target repositories, and this checkout dogfoods the same workflows for
its own plans and reviews.

## Who this is for

This repo serves humans and agents who maintain the harness, install packaged
skills, run review workflows, or use the runner against target repositories.

Humans steer scope and judgment. Agents should be able to find the relevant
source-of-truth docs, run the right commands, and leave durable improvements in
the repo instead of relying on chat memory.

## What this repo is not

This repo is not a fake starter app, a target application template, or a place
for examples tied to private downstream repositories.

Durable docs should explain harness concepts with generic target-repo examples
such as `/path/to/repo`, `harness.json`, and `.harness/runs/reviews/<run-id>/`.

## Hard invariants

- Durable docs must stay generic and standalone.
- Harness code may run against target repos, but durable examples should use
  target-repo wording or generic paths.
- Generated review artifacts belong under target-repo `.harness/`.
- `AGENTS.md` stays a short routing map; detailed guidance belongs under focused
  docs.
- Current behavior and planned work must be clearly separated.
- Provider-specific details belong behind provider adapters; workflows should
  stay provider-agnostic.
- Reusable service primitives own connection and communication only. They must
  not depend on Factory, orchestration hosts, agent providers, prompts, or
  domain workflow policy.
- Factory owns lifecycle truth and transition rules for Factory-managed work.
  Execution hosts such as Inngest may deliver, retry, schedule, and observe
  that work, but they must not keep a second Factory lifecycle state machine.
- Runtime schemas and exported schemas must stay aligned when either side
  changes.

## Automation shape

New automation capabilities should be small, independent operations rather than
new stations in a fixed lifecycle. Compose them in one direction:

```text
delivery and retries
  -> domain operation and policy
  -> standalone service and provider primitives
```

The delivery layer coordinates durable execution. Domain operations own their
decisions and structured results. Service and provider primitives communicate
with external systems without knowing which operation or delivery host called
them.

Factory remains one workflow model in the repo, not the required boundary for
all new automation. Standalone operations may be connected when a real workflow
needs it, but they should not require an artificial shared state machine.

The current Linear automation follows this shape directly: a self-hosted
Inngest poller emits revision-scoped events, a readiness operation reloads
Linear truth and chooses a route, and an independent triage consumer projects
its decision through the standalone Linear module. Linear Backlog remains the
durable work queue; the delivery layer keeps no second cursor or lifecycle
store.

## Durable factory-store boundary

Factory lifecycle evidence and factory-owned run evidence live in the durable
factory store by default:
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/` by
default.

Target repositories remain execution sandboxes and Git materialization points:
they own `harness.json`, the harness shim, inbox files, source, tests, local
skill installs, and committed plans and code. Standalone review artifacts keep their target-repo
`.harness/runs/reviews` defaults. Linear and GitHub will remain human/project
projections, while Git remains the source of truth for committed plans and
code. Events for Factory-managed work enter Factory as verified durable facts
before they can enable more Factory work. Independent automations verify their
own ingress and do not acquire a Factory lifecycle only for durability.

Factory planning keeps planner scratch separate from Harness evidence. The
planner writes only the retained, ignored workspace-local
`.harness/factory-drafts/<run-id>/draft.md`; Harness validates that draft and
publishes canonical and immutable snapshots into the external durable store.
Scratch is transient, non-authoritative, and never recovery state.

## Harness-repo vs target-repo boundary

The harness repo owns reusable workflow machinery and repo-local planning
artifacts. Target repositories own their project docs, source, tests, gates,
configuration, generated `.harness/` artifacts, and local skill installs. See
the [architecture map](contributing/architecture.md) for the directory-level
ownership map.

Harness-owned directories include `bin/`, `lib/`, `providers/`, `workflows/`,
`skills/`, `.agents/skills/`, `automations/`, `schemas/`, `scripts/`, and
`dev/plans/`.

## Documentation guidance

Write durable docs as present-tense source of truth. If a feature is planned,
label it as planned work and point to the active plan instead of describing it
as current behavior. Use `dev/plans/README.md` to find active plans.

Use the [contributor index](contributing/index.md) for doc-placement decisions.

## Agent guidance

Read this file before making product-level, architecture, or documentation
decisions for this repo.

Do not import source-reference examples, private local paths, or downstream
repo-specific assumptions into durable docs. Use the
[harness-engineering guide](contributing/harness-engineering.md) when repeated
guidance needs to become durable enforcement.
