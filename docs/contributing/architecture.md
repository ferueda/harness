# Architecture

## Purpose and audience

This is the navigation map for contributors changing Harness. It explains the
runtime paths, boundaries, subsystem locations, and durable artifacts needed to
find the right code.

Use [Script and command surface](./script-command-surface.md) for public
commands and mutability, and [Setup manifest](./setup-manifest.md) for
requirements, authentication, and generated paths. Generated CLI help owns
current flags.

## Product surfaces

Packaged skills are self-contained guidance installed into an agent host or a
target repository. They may contain local references and scripts, but one skill
must not depend on an unverified sibling install. The catalogue in
`skills/README.md` routes by deliverable. The generic read-only `triage` skill
helps classify a work item without changing its tracker or repository.

Standalone reviews follow one shared runtime path:

```text
CLI
  -> workspace and config resolution
  -> immutable review context
  -> change-review or plan-review workflow
  -> shared agent contract
  -> Cursor or Codex provider adapter
  -> validated reviewer results and aggregate verdict
  -> local review artifacts
```

`change-review` can run implementation and code-quality roles.
`plan-review` runs the specification-review role against one plan. Both are
read-only with respect to the caller's source files. Change review also creates
and removes temporary Git worktree registrations; durable run artifacts stay
under `.harness/` or the explicitly selected run root.

## Dependency boundaries

| Layer            | Owns                                                                                   | Must not own                                                |
| ---------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Skills           | Agent process, completion bounds, and optional local references or scripts             | Hidden sibling-skill dependencies or target-specific policy |
| Workflows        | Review selection, role composition, scope, and verdict aggregation                     | Concrete provider SDK calls or provider authentication      |
| Review runtime   | Context capture, prompts, structured results, events, reports, and cleanup             | Provider construction or target-repo policy                 |
| Agent contract   | Provider-neutral invocation, structured output, cancellation, and workspace protection | Review semantics or provider SDK details                    |
| Provider adapter | Authentication, invocation streams, sandbox settings, and result translation           | Review, workflow, or skill policy                           |
| Configuration    | Target defaults and provider-specific options                                          | Secrets or generated run state                              |

The import checks enforce the important direction: agent code is independent of
reviews and providers; review code is independent of providers; providers are
independent of reviews and workflow policy. The CLI composition root connects
these layers.

## Directory ownership

| Path           | Ownership                                                                        |
| -------------- | -------------------------------------------------------------------------------- |
| `bin/`         | CLI composition, command parsing, generated help, and workspace resolution       |
| `lib/agent/`   | Provider-neutral invocation and workspace protection                             |
| `lib/config/`  | `harness.json` loading and validation                                            |
| `lib/review/`  | Review context, prompts, results, events, reports, and run cleanup               |
| `lib/skills/`  | Packaged skill installation                                                      |
| `providers/`   | Cursor and Codex adapters plus the model registry                                |
| `workflows/`   | Callable plan and change review definitions and shared review steps              |
| `skills/`      | Independently installable agent skills                                           |
| `automations/` | Generic background-task definitions                                              |
| `schemas/`     | Exported structured review result contract                                       |
| `scripts/`     | Build, distribution smoke, gate, classification, and provider-inspection helpers |
| `test/`        | Cross-module CLI, contract, import-boundary, and distribution tests              |
| `docs/`        | Project intent, contributor references, and interface principles                 |
| `dev/plans/`   | Active manual implementation plans and their lifecycle rules                     |

## Review runtime

The CLI resolves the workspace and base branch, loads `harness.json`, and asks
the selected workflow for its review roles. Review context records the exact
Git scope and any plan input before a provider runs. Every reviewer receives a
role-specific prompt and an output schema through the provider-neutral agent
contract.

The runtime validates each response and retains exact scope, validated outputs,
and provider failures in `ChangeReviewResult`. A completed review verdict is
`pass`, `needs_changes`, or `blocked`; run status distinguishes `completed`,
`failed`, and `dry_run`. Failed runs keep evidence from reviewers that completed.
Change-review refs are resolved to commit IDs once. Each selected reviewer runs
in its own temporary detached worktree at the captured head, not in the caller's
live checkout. Copied diff and plan references are absolute so they remain
readable from that worktree. The caller's dirty files and subsequent edits are
neither included nor modified. No stash, source commit, or branch switch is
performed in the caller's checkout.

Before accepting a successful reviewer result, the runtime verifies the
worktree root, head commit, and clean Git status. An unreadable or changed
review worktree fails that role, retaining its raw response and any successful
sibling. A provider timeout, abort, or workspace-guard failure keeps that
recorded cause instead of being rewritten as a revision mismatch. Each
role removes its owned worktree and Git registration in a `finally` block;
cleanup failure also fails the role. Dry runs and plan reviews do not create these worktrees.

Review worktrees contain committed files only. Ignored dependencies, environment
files, and uncommitted specialist guidance are not copied or linked; unavailable
checks remain explicit proof limits. Checkout hooks are disabled during creation.
This is revision isolation, not a security sandbox: Codex defaults to read-only
execution, while the Cursor adapter does not provide the same hard sandbox
policy. Provider workspace guards remain defense in depth.

The change-review workflow selects implementation, quality, or both roles. The
plan-review workflow binds one plan artifact and uses the specification-review
prompt. Shared execution belongs in `workflows/review-steps.ts`; role policy
belongs in the workflow or its prompt.

## Provider boundary

Cursor and Codex implement the same `Agent` interface. Each adapter owns its SDK
request, authentication, stream translation, timeout and cancellation handling,
and provider-specific model options. Every review invocation is independent,
and workflows do not depend on provider response shapes.

Each adapter validates supported execution options before invoking its SDK.
The agent contract owns the supported model catalogue exposed by `harness models`; the provider registry
constructs only the adapter selected by configuration.

## Configuration

A target repository's `harness.json` contains:

- `base`, the default comparison branch;
- `defaultAgent`, the default `cursor` or `codex` provider;
- `agents.cursor.model`, an optional Cursor model override;
- `agents.codex` options for model, executable, sandbox mode, approval policy,
  and model reasoning effort.

Secrets stay in the environment. Configuration loading rejects unsupported
top-level keys so retired or misspelled settings cannot silently remain active.

## Artifact lifecycle

| Path                                          | Meaning                                                        |
| --------------------------------------------- | -------------------------------------------------------------- |
| `harness.json`                                | Target-repo review and provider defaults                       |
| `.harness/bin/harness`                        | Ignored target-repo shim created by `harness init`             |
| `.harness/runs/reviews/<run-id>/context/`     | Immutable scope and plan inputs                                |
| `.harness/runs/reviews/<run-id>/*-review.*`   | Prompts, streams, raw responses, and validated reviewer output |
| `.harness/runs/reviews/<run-id>/events.jsonl` | Append-only local run events                                   |
| `.harness/runs/reviews/<run-id>/summary.md`   | Human-readable result                                          |
| `.harness/runs/reviews/<run-id>/meta.json`    | Machine-readable run metadata                                  |

The default run root is `.harness/runs/reviews/` in the selected workspace;
`--runs-dir` may choose another local root. `harness runs prune` removes old
review runs from the selected root. A target repository decides whether
installed skills under `.agents/skills/` are committed.

## Harness repo and target repo

The Harness repo owns reusable runtime code, providers, workflows, packaged
skills, docs, and release checks. A target repository owns its source, project
instructions, tests, gates, `harness.json`, installed skill copies, and local
review artifacts. Workflows read target content through explicit context; they
do not copy target policy back into Harness.
