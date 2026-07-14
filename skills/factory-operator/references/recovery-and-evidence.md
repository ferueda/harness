# Recovery and evidence

Read this reference for failure, replay, projection repair, interrupted
publication, incompatible state, or deeper verification than the normal action
checkpoint requires.

## Evidence order

Start at the `runDir` reported by the command; do not assume the run lives in
the target workspace.

1. Read `summary.md` and `meta.json` for navigation and the terminal boundary.
2. Read `context/phase-run.json` for immutable work-item, workspace, store,
   phase, role, and phase-run identity.
3. Follow the terminal event to its content-addressed action directory.
4. Verify `action-result.json`, referenced evidence, hashes, candidate or review
   identity, and provider/reviewer result.
5. Compare the durable next reaction with command output and current Git facts.

Canonical lifecycle JSONL lives under the durable store's
`factory/events/*.jsonl`. `factory/state/*.json` is a rebuildable cache. Action
directories live under the Factory run root and are keyed by attempt, handler,
and action identity. Treat all of them as user data: inspect, never edit.

## Progress versus completion

An action-started record identifies the phase run, handler, attempt, and run
directory. Heartbeats show liveness. Neither proves success. Only process exit
plus durable terminal evidence closes the action boundary.

If output transport is ambiguous, inspect the durable action identity before
retrying. A published action result may mean the work completed even when the
caller missed terminal output.

## Recovery rules

- Reuse the same phase, handler, attempt, and causation identity on retry.
- Prefer a valid staged or published result over a second provider invocation.
- Revalidate immutable work-item, candidate, review, session, workspace, index,
  and action-owned Git authority before appending a recovered event or promoting
  a candidate.
- Allow only the action's documented Git transitions. Ambient refs in a shared
  repository are diagnostic; current branch and current phase refs remain hard
  authority boundaries.
- Repair Linear and GitHub projections from durable terminal evidence. Do not
  recreate the underlying provider or review work.
- Preserve create-only candidate refs and exact compare-and-swap promotion.
  Never move a branch to a merely plausible candidate.
- For `needs_changes`, preserve the candidate, complete blocking findings,
  review round, and effective producer session until an explicit continuation
  selects revision or re-review.
- On publication retry, find or reuse the pull request bound to the exact
  reviewed head. Publication cannot merge.

## Store incompatibility

Harness marks the durable store format and rejects incompatible, differently
versioned, or unmarked non-empty state. It must not silently migrate or delete
that data.

When this occurs:

1. Stop before running a phase action.
2. Report the exact resolved store and marker error.
3. Leave the store untouched.
4. Ask the owner to archive/reconcile it, or request explicit authority for a
   fresh isolated store identity.
5. Explain that a fresh store starts a separate lifecycle; it is not recovery
   of the rejected history.

## Failure checkpoint

Report:

- exact command, exit, controller commit, target commit, branch, and status;
- store root/project ID, phase run, handler, attempt, causation, and event;
- whether provider/reviewer work started or a prior result was recovered;
- evidence paths and hashes inspected;
- current candidate/ref/tree/session and workspace/index facts when relevant;
- external projections attempted and whether repair is safe;
- smallest supported next action, plus any authority it requires.

Do not clean up runs, refs, stashes, stores, or external records merely to make
the next invocation easier. Preserve evidence until the owner authorizes a
bounded cleanup.
