# Linear and configuration

Read this reference only when the operation uses Linear, changes external
projections, selects provider roles, or overrides the durable store.

## Configuration ownership

Read `harness.json` from the target workspace before running a live action.
Factory currently addresses providers by phase role:

- `factory.triage.roles.triager`
- `factory.planning.roles.planner`
- `factory.planning.roles.reviewer`
- `factory.implementation.roles.implementer`
- `factory.implementation.roles.reviewer`

Role settings may select the provider, model, executable, sandbox, approval
policy, and reasoning effort. Provider defaults remain under top-level
`agents`, with `defaultAgent` as the global fallback. Do not change role config
during an active phase and expect its snapshotted responsibilities to change.

Linear configuration lives under `factory.linear`:

- `teamKey` owns issue identifiers and board statuses;
- `projectId` scopes the repository when configured;
- `statuses` maps Factory's semantic states to the board's actual names.

Use the schema and generated errors for the required status keys. Do not copy a
sample status map into an operator command or infer transitions from display
names.

## Read-only intake

- Use `factory linear list` to discover lightweight issue summaries by
  configured status. It does not advance Factory.
- Use `factory linear fetch` to materialize one current issue as a
  `FactoryWorkItem`. It reads description, labels, recent comments, and tracker
  metadata but does not initialize lifecycle state.
- Use `factory inspect` to reconcile that item with durable Factory state. It is
  read-only.
- Use `factory linear create` only for constrained backlog intake when the
  target's configured team, project, and intake status are authoritative. It is
  not a Factory phase action.

Prefer generated subcommand help for current selectors and input flags. For
issue bodies, supply exactly one supported source and never expose credentials
in logs or checkpoints.

## Explicit projections

Without `--apply`, a Linear-backed phase command must not mutate Linear. With
`--apply`, that invocation receives authority only for its documented status
and marker/comment projection.

- Triage projects its start and terminal route.
- Planning remains in progress through candidate and review work; publication
  projects the plan-review wait.
- Implementation remains in progress through candidate, review, and
  continuation; publication projects the implementation PR-review wait.
- Merge acknowledgement projects completion only after the recorded merge has
  been verified.

Durable state is written before its external projection. If the projection
fails, retry the same command with explicit `--apply`; Harness should repair the
idempotent projection without repeating the provider action. Never overwrite
an intervening human status unless the documented adapter explicitly accepts
that state.

## Store identity

The default durable store is outside the target workspace under the Harness
data directory. Override it with the current CLI flags, environment variables,
or `factory.store` configuration shown by generated help and schema docs.

Keep the same resolved store root and project ID for every command in one
lifecycle. Record both in checkpoints. A separate isolated store is appropriate
only when explicitly authorized; it creates a separate lifecycle and does not
migrate or supersede existing history.
