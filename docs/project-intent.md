# Project intent

## What this repo is

`harness` is a personal toolkit for agent-assisted software work. It keeps
packaged skills, callable review workflows, provider adapters, configuration,
scripts, and review artifact conventions in one repository.

The repo is both a tool and its own reference target: Harness can run against
external target repositories, and this checkout dogfoods the same reviews and
skills.

## Who this is for

This repo serves humans and agents who maintain Harness, install packaged
skills, or run review workflows against a repository.

Humans steer scope and judgment. Agents should be able to find the relevant
source-of-truth docs, run the right commands, and leave durable improvements in
the repo instead of relying on chat memory.

## What this repo is not

This repo is not a target application template, an issue tracker, or a general
automation service. Durable docs use generic target-repo examples such as
`/path/to/repo`, `harness.json`, and `.harness/runs/reviews/<run-id>/`.

## Hard invariants

- Durable docs stay generic and standalone.
- Review artifacts use the selected local run root, which defaults under the
  active workspace's `.harness/`.
- `AGENTS.md` stays a short routing map; detailed guidance belongs in focused
  docs.
- Current behavior and planned work are clearly separated.
- Review workflows depend on the shared agent contract, not concrete provider
  adapters.
- Providers translate the shared agent contract without owning review or skill
  policy.
- Skills are independent packages. Each install copies only the named package
  and its local references.
- Runtime schemas and exported schemas stay aligned when either side changes.

## Product shape

Harness has two complementary surfaces:

1. Packaged skills guide agents through planning, diagnosis, implementation,
   triage, review, handoff, and related engineering work.
2. Callable `change-review` and `plan-review` workflows run independent reviewers
   through Cursor or Codex and preserve structured local evidence.

The workflows are explicit commands. They gather immutable context, call the
configured review roles, validate structured results, aggregate a verdict, and
write inspectable artifacts. They do not edit the reviewed workspace.

Target repositories own their project docs, source, tests, gates,
`harness.json`, installed skills, and generated review artifacts. The Harness
repo owns reusable workflow machinery and packaged guidance.

## Documentation guidance

Write durable docs as present-tense source of truth. Label planned features as
planned work and point to an active plan. Use `dev/plans/README.md` to find the
active queue and the [contributor index](contributing/index.md) to place docs.

Explicitly approved changes may supersede current intent; explain the decision
and update affected sources. Keep private local paths, source-reference
examples, and downstream assumptions out of durable docs.
