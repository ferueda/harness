# Harness engineering

## Core mindset

The model harness is the AI host around the model: model choice, tools,
permissions, sessions, browser or MCP surfaces, and execution environment.

The engineering harness is what this repository owns: docs, commands, checks,
tests, scripts, workflows, providers, artifacts, review loops, and maintenance
habits.

The model predicts. The engineering harness makes the correct path easy, the
wrong path visible, and repeated mistakes expensive to keep repeating.

## Source-of-truth boundaries

`AGENTS.md` is a routing map, not an encyclopedia. Keep it short enough to load
by default and link to focused docs for detail.

Use `README.md` for install, usage, workflows, skills, automations, and
development commands. Use `docs/contributing/` for contributor decisions and
agent-facing maintenance guidance.

Current command detail is intentionally high level here. The present final gate
is `pnpm check` / `make check`; command ownership and mutability live in
[Script and command surface](./script-command-surface.md).

Testing strategy, proof-layer selection, authoring guidance, and smoke policy
live in [Testing](./testing.md). Keep this guide focused on the broader
engineering loop rather than duplicating the testing taxonomy.

## Continuous improvement loop

Use the same loop for features, fixes, docs, and harness work:

1. Plan the intent, scope, and acceptance criteria.
2. Implement the smallest coherent change.
3. Verify with scoped checks while iterating and the final gate before handoff.
4. Review with humans or harness reviewers.
5. Encode durable learning in the repo.

When work teaches the repo something durable, capture it near the source of
truth before the session ends.

## Promote repeated guidance into enforcement

Repeated advice should escalate from docs -> tests/self-tests -> lint/static guardrails -> scripts/automation.

Start with docs when a rule needs explanation. Add tests when behavior can
regress. Add lint or structural checks when the mistake is static. Wrap
repeatable workflows in scripts only when the command makes the next correct
action clearer.

## Build an automation capability

Use the [automation construction contract](./architecture.md#automation-construction-contract)
before adding a new Linear or Inngest path.

Start with one vertical slice and only the primitives it calls. In order:

1. Normalize the external input through a standalone service primitive.
2. Define one operation-specific input, result, policy, and provenance contract.
3. Add an isolated repository or compute primitive only if the operation must
   write or execute an artifact.
4. Add a separate publication primitive only when approved workspace changes
   must become a commit, branch, pull request, or another external artifact.
5. Keep tracker projection separate from the operation.
6. Compose the flow with a short durable consumer whose steps match meaningful
   external side effects.

Before handoff, check the dependency direction:

- service primitives do not import domain operations, providers, or Inngest;
- domain operations depend on the provider interface, not a concrete adapter,
  and do not import Linear, Inngest, Git, or GitHub code;
- repository primitives do not import domain or tracker policy;
- publication primitives do not create workspaces or import domain, tracker, or
  delivery policy;
- projection code does not render prompts or schedule work;
- Inngest consumers reload current truth and coordinate the other parts rather
  than implementing them inline;
- event payloads carry identifiers and provenance, not copied lifecycle state;
- retryable sessions, workspaces, branches, comments, and publications have
  stable identities where duplication would matter;
- a human handoff ends the function and waits for a later external event.

Keep schemas local to the operation at first. Do not add a generic operation
base class, station registry, central route engine, or second work-state store
for future consumers. Once two real consumers repeat the same code, extract the
smallest proven shared boundary.

## Gate output contract

Repo gates are quiet on success by default. Wrapped Make steps print concise
progress and duration, for example `==> check-format` and
`PASS check-format (1.2s)`. Successful tool output is hidden by default; use
verbose mode when auditing warning drift or debugging a suspicious pass.

Failures are bounded and actionable. A failed wrapped step prints `FAIL`, a
local log path, the last configured log lines, and a verbose rerun hint. The log
path is authoritative; if the tail does not show the root cause, inspect the
saved log locally before rerunning blindly.

Failure output uses stable markers:

```text
==> test
FAIL test (12.7s)
Log: /tmp/harness-gate-abc123/test.log

--- last 120 lines ---
...

Rerun with full logs:
VERBOSE=1 make test
```

Failure flow:

1. Read the quiet gate failure output first: failed step, log path, bounded
   tail, and rerun hint.
2. Inspect the saved log if the tail is insufficient.
3. Rerun the printed verbose command.
4. For format or lint failures, run `make fix` when applicable.
5. Rerun the smallest failed gate, then run `pnpm check` before handoff.

Saved logs may contain local environment or provider details. Keep them local,
review before sharing, and do not paste full logs into chat or PRs unless they
have been checked for secrets.

## Working agreements

- Keep changes scoped and reviewable.
- Include verification commands in handoffs and PR descriptions.
- Update the closest source-of-truth doc when workflow behavior changes.
- Keep independent operations small. Delivery code should coordinate retries;
  domain code should own policy; service modules should only communicate with
  external systems.
- Make durable work state explicit in the system that owns it. Do not create a
  second lifecycle store when Linear or another service is already the queue.
- Avoid introducing new patterns without documenting when to use them.
- Prefer boring, explicit commands over hidden agent memory.
- Keep durable examples generic to this repo and target repositories.

## Maintenance cadence

Periodically remove stale guidance, tighten unclear instructions, and choose
one repeated review issue to encode mechanically. Keep command inventory docs
and drift tests current as command surfaces change.

Finished plans leave the active tree according to `dev/plans/README.md`; active
plans stay in `dev/plans/` until they land.
