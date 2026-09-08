# Harness Engineering

Durable guidance for changing Harness itself. Read
[Project intent](../project-intent.md) for product scope,
[Architecture](./architecture.md) for boundaries, and [Testing](./testing.md)
for proof selection.

## Change shape

Prefer the smallest coherent change that proves a current need. Put behavior in
the narrowest owning layer:

- agent invocation and workspace-effect checks in `lib/agent/`;
- review context, prompts, artifacts, and results in `lib/review/`;
- review composition and role policy in `workflows/`;
- SDK and authentication translation in `providers/`;
- independently installable agent process guidance in `skills/`;
- CLI parsing and layer construction in `bin/`.

Keep the dependency direction visible in imports. Agent code stays independent
of reviews and providers. Review code stays independent of providers. Provider
adapters stay independent of reviews and workflow policy. The CLI composition
root may connect all three.

Do not add a shared framework for hypothetical consumers. Extract a common
contract after multiple real callers demonstrate the same stable need.

## Skills and workflows

A skill is a package of agent instructions. It owns invocation cues, process,
completion criteria, and only the references or scripts that package needs.
One installed skill cannot assume its siblings are present.

A callable review workflow is runtime code. It owns selected reviewer roles,
scope, and verdict aggregation. Prompts in `lib/review/prompts/` define what a
reviewer assesses; provider adapters only deliver that request and translate its
result.

When guidance and executable reviews cover related work, keep each entrypoint
complete. A user may install a review skill without running Harness, or run a
workflow without installing its companion skill.

## Errors and structured results

Validate configuration and provider capability before starting expensive work.
Return structured results that preserve exact review scope, validated reviewer
outputs, and failures. Error messages should name the failed layer and give the
next useful action without exposing credentials or full private prompts.

Cancellation and timeouts flow through the shared `AbortSignal`. Provider
adapters translate native cancellation and retain bounded diagnostic streams.
Review aggregation distinguishes a review finding from an invocation error.

## Artifact discipline

Write run evidence under the resolved workspace's
`.harness/runs/reviews/<run-id>/`. Context captured before provider execution is
immutable. Reviewer prompts, streams, validated outputs, events, summary, and
metadata remain inspectable after a failure.

Keep tracked source and local run state separate. Tests use temporary target
repositories and clean them on success. Diagnostic failure paths may retain one
bounded artifact with an explicit path.

## Gate output contract

Long local gates use `scripts/run-gate-step.ts` through Make's `RUN` wrapper.
The wrapper keeps success quiet and makes failures useful:

- success prints one `PASS` line with the step name and duration;
- failure prints one `FAIL` line, then `Log:` with the retained log path;
- the visible diagnostic tail begins with `--- last` and remains bounded;
- the final `Rerun with full logs:` line gives the exact verbose rerun hint.

`VERBOSE=1` streams the full child command and does not print a retained-log
summary. Default runs delete successful temporary logs. Failed runs retain the
log path; `KEEP_GATE_LOGS=1` retains successful logs too. `GATE_LOG_DIR` lets a
caller choose the diagnostic directory.

Add Make-owned checks through the wrapper when their output is long enough to
hide the real result. Keep fast setup, formatting, and help commands direct.

## Documentation and contracts

Generated help, schemas, configuration code, and package scripts are source
truth. Contributor docs explain ownership, reasons, and safe use; avoid copying
large discoverable inventories that can drift.

Use generic target-repo examples. Keep private paths, credentials, fixture
names, and downstream policy out of docs and test messages. When a behavior is
removed, delete its guidance and obsolete tombstone assertions rather than
preserving a historical compatibility surface.

## Completion

Use the highest stable seam that proves the change, then run `make check` before
handoff. Approved plan-only changes use `make check-plan`. If formatting or lint
fails, run the matching fix target, inspect the diff, and rerun the gate.

Assess independent review once at a coherent completion point. Select it for
material behavior or structural risk, and skip it for routine low-risk work.
Record the selection and any consequential findings in the handoff.
