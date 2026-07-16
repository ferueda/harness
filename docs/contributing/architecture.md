# Architecture

## Purpose and audience

This is the navigation map for contributors changing Harness. It explains the
runtime paths, ownership boundaries, subsystem locations, and durable artifacts
needed to find the right code without turning this page into command help or a
Factory runbook.

Use [Script and command surface](./script-command-surface.md) for exact public
commands and mutability, [Setup manifest](./setup-manifest.md) for requirements,
auth, and generated paths, and [Factory contributor guide](./factory.md) for the
Factory domain model. Generated CLI help owns current flags.

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

Factory phases:

```text
CLI
  -> durable work-item state and pure reaction
  -> one selected action handler
  -> producer or reviewer through provider/workflow boundaries
  -> immutable evidence and action result
  -> compare-and-append lifecycle event
  -> rebuildable state
  -> optional Linear or GitHub projection
```

Hosted operation delivery composes Factory with Grove without moving lifecycle policy:

```text
trusted project/work-item targets
  -> reconcile the canonical reaction
  -> identifier-only request or bounded wait/stale/attention result
identifier-only request + trusted project runtime
  -> authenticate phase, work item, action, and completed result
  -> recover, stale, or wait before Grove when possible
  -> derive lease intent from immutable phase Git identity
  -> Grove acquire or compatible reacquire
  -> repository-owned setup hook
  -> revalidate canonical Factory state
  -> one existing Factory action with the canonical workspace path
  -> authenticated receipt hint
```

Both paths resolve target-repo configuration and use provider adapters. They
differ in continuity: standalone review runs are independent workspace
artifacts; Factory owns a durable multi-phase lifecycle outside the target
workspace.

## Ownership boundaries

| Owner                 | Owns                                                                                                                                   | Does not own                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Harness checkout      | CLI, config/schema handling, workflows, Factory kernel and actions, providers, packaged skills, scripts, and contributor docs          | Target product decisions, source, tests, or CI policy                 |
| Target repository     | `harness.json`, shim, optional installed skills, source, tests, project docs, CI, plans/code, and workspace-local review runs          | Harness provider internals or durable Factory lifecycle               |
| Durable Factory store | Lifecycle JSONL, locks, rebuildable state, phase contexts, action evidence, provider/reviewer artifacts, and Factory-owned review runs | Target source or Git history                                          |
| Git                   | Reviewed plan/code commits, candidate refs, promoted branch history, and merge ancestry                                                | Factory lifecycle or human board status                               |
| Grove                 | Persistent pool capacity, stable lease paths, checkout, serialized setup hooks, process-safe reset/release, quarantine, and repair     | Factory lifecycle, reactions, Git promotion, or publication authority |
| Linear and GitHub     | Human-facing issue and pull-request projections                                                                                        | Factory transition truth                                              |
| Workspace caller      | Stable phase generation, authoritative base commit, setup command, and verified terminal-event authority                               | Lease internals or Factory state interpretation                       |

The target workspace remains the execution sandbox and Git materialization
point. The durable store remains Factory's continuity boundary. Linear and
GitHub mutations are explicit, retryable projections.

## Source map

| Area                                                                     | Responsibility                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `bin/`                                                                   | CLI entrypoints, generated help, manual Factory commands, and action output                                           |
| `lib/config.ts`, `lib/context.ts`, `lib/workflow-context.ts`             | Workspace/config resolution, review scope, immutable context, provider wiring, aggregation, and standalone run export |
| `lib/factory-lifecycle-*.ts`, `lib/factory-state-machine.ts`             | Factory event schemas, compare-and-append kernel, state reduction, and pure reactions                                 |
| `lib/factory-*-action.ts`, phase input/context modules                   | Triage, planning, and implementation action boundaries and immutable evidence                                         |
| `lib/factory-store.ts`, `lib/factory-locks.ts`, `lib/factory-inspect.ts` | Durable paths, lock ownership, store provenance, and read-only lifecycle inspection                                   |
| `lib/factory-grove-workspace.ts`                                         | Deterministic Grove lease intent, ensure/reopen, terminal release, and bounded repair                                 |
| `lib/factory-hosted-operation.ts`, `lib/factory-operation.ts`            | Identifier-only hosted delivery, authenticated resolution/execution, and reconstructable receipts                     |
| `lib/factory-operation-reconciliation.ts`                                | Bounded caller-supplied log-to-delivery repair with per-target failure isolation                                      |
| `lib/factory-inngest-adapter.ts`                                         | Deterministic Factory event IDs, direct sends, chained sends, and hosted function controls                            |
| `lib/factory-linear-*.ts`                                                | Linear import, listing, intake creation, guarded status/comment projections, and handoffs                             |
| `lib/factory-*-publication*.ts`, `lib/factory-pull-request-publisher.ts` | Reviewed-commit validation and bounded GitHub publication                                                             |
| `providers/`                                                             | Cursor and Codex invocation, auth, streaming, sessions, sandboxing, and provider result translation                   |
| `workflows/`, `lib/prompts/`                                             | Provider-agnostic workflow definitions, shared review execution, and prompt contracts                                 |
| `skills/`                                                                | Packaged skills installed into target repositories                                                                    |
| `.agents/skills/`                                                        | Development-only skills for this Harness checkout                                                                     |
| `schemas/`                                                               | Exported JSON schemas that must stay aligned with runtime Zod schemas                                                 |
| `scripts/`                                                               | Build/distribution utilities and gate infrastructure, including `scripts/run-gate-step.ts`                            |
| `automations/`                                                           | Background task definitions, not Factory lifecycle state                                                              |
| `dev/plans/`                                                             | Active implementation plans and their index; not current architecture truth                                           |

Prefer these ownership clusters over a file-by-file mental model. A new source
file should live with the subsystem whose contract it extends.

## Runtime boundaries

### Workflow and action boundary

Standalone `change-review` and `plan-review` use workflow context plus callable
workflow definitions. Factory uses its durable action kernel and may call the
same review machinery inside a phase action. A Factory implementation review is
therefore not a separate operator-run `change-review`; the action owns its
candidate, reviewer manifest, aggregate verdict, and lifecycle event.

### Provider boundary

Workflows and Factory actions depend on the shared provider interface. Provider
auth, SDK/CLI invocation, streaming, session continuation, model policy, and
sandbox details stay under `providers/` or provider-scoped config. Producers may
run in recorded workspace mode when Harness owns later validation; reviewers
remain mutation-guarded and read-only.

### State and projection boundary

Factory lifecycle JSONL is canonical; state JSON is rebuildable. Action evidence
is content-addressed. Git is authoritative for committed plan/code bytes. Linear
and GitHub may lag and be repaired, but they cannot select Factory transitions.
See [Factory contributor guide](./factory.md) for the full invariant set.

### Schema boundary

Runtime validation lives primarily in `lib/schemas.ts`,
`lib/factory-schemas.ts`, and phase-specific schemas. Exported schemas live in
`schemas/`. When a public structured contract changes, check both sides and the
provider prompt or workflow consuming it.

## Artifact map

| Root                                                                         | Purpose                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `.harness/runs/reviews/<run-id>/` in the target workspace                    | Standalone review context, prompts, structured results, streams, summaries, metadata, and events                   |
| `.harness/bin/harness`                                                       | Ignored target-repo shim pointing to the Harness checkout that initialized it                                      |
| `.harness/inbox/factory/`                                                    | Workspace-local intake files; current phase commands inspect or select one item rather than batch-moving the inbox |
| `.harness/factory-drafts/<run-id>/draft.md`                                  | Ignored planner scratch; transient and never recovery truth                                                        |
| `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/factory/` | Canonical Factory events, rebuildable state, locks, and store format marker                                        |
| `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/runs/`    | Factory phase evidence and Factory-owned review artifacts                                                          |

Artifact references in Factory events use store-relative paths and SHA-256
hashes. `summary.md` and `meta.json` are navigation aids; immutable referenced
evidence and lifecycle events own recovery. Generated local state is ignored or
user data and must not be committed.

## Current execution model

The CLI still manually steps phase start, continuation, Linear/GitHub
projections, publication, and merge acknowledgement. The callable hosted runner
accepts only project/work-item/operation identifiers; trusted runtime owns store
paths, repository identity, credentials, provider controls, and Grove config.

An external host may call `lib/factory-operation-reconciliation.ts` with a
bounded trusted target list. It returns `delivered`, `waiting`, `stale`, or
`attention` per target, isolates failures, and neither changes lifecycle state
nor discovers or schedules work.

`lib/factory-inngest-adapter.ts` owns deterministic event IDs and direct or
chained sends. IDs suppress transport duplicates; Factory action identity
prevents replay. The adapter keeps three retries and a 110-minute action limit.
The current integration assumes one persistent host and ships no production
worker or Harness scheduler.

For planned work, use `dev/plans/README.md`. Add future behavior here only after
it becomes a current repository relationship.
