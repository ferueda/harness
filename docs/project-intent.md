# Project intent

## What this repo is

`harness` is a personal agent workflow harness. It keeps reusable skills,
callable review and planning workflows, runner code, provider adapters,
automations, plans, schemas, scripts, and review artifact conventions in one
repository.

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
- Runtime schemas and exported schemas must stay aligned when either side
  changes.

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
