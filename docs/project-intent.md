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
  not depend on orchestration hosts, agent providers, prompts, or domain
  workflow policy.
- Durable delivery systems may retry, schedule, and observe work, but domain
  policy belongs in the independent operation that makes the decision.
- Repository and compute primitives own isolated execution and cleanup.
  Publication primitives own authenticated materialization into external
  source-control systems. Both return serializable handles and must not own
  tracker lifecycle or domain policy.
- External systems that already own queue or lifecycle state remain the source
  of truth. Harness must not mirror that state in a second lifecycle store.
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

Durable functions stay thin by owning temporal coordination only: reload
current truth, validate or claim work, call an operation, publish its artifact,
project the result, and emit the next event or end. They may branch, retry, and
serialize work, but they must not hide prompt policy, SDK pagination, Git
commands, or tracker mappings inside the function body.

Resume work at meaningful side-effect boundaries. Provider sessions,
repository runs, and publication identities should be serializable and stable
when a retry needs to reconstruct them. Scratch state may be replaced; durable
work and review artifacts may not.

Standalone operations may be connected when a real workflow needs it, but they
should not require an artificial shared state machine.

Start each operation with its own concrete input and result contract. Extract a
shared automation framework only after multiple real consumers prove the same
abstraction. Do not introduce station registries, generic operation engines, or
a central lifecycle to prepare for hypothetical work.

The current Linear automation follows this shape directly: a self-hosted
Inngest poller emits revision-scoped events, a readiness operation reloads
Linear truth and chooses a route, and an independent triage consumer projects
its decision through the standalone Linear module. Linear Backlog remains the
durable work queue; the delivery layer keeps no second cursor or lifecycle
store.

Target repositories remain execution sandboxes and Git materialization points:
they own `harness.json`, the harness shim, source, tests, local skill installs,
and committed plans and code. Standalone review artifacts keep their target-repo
`.harness/runs/reviews` defaults. Linear owns issue state, while Git remains the
source of truth for committed plans and code.

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
