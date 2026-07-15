---
name: factory-operator
description: Operate one manually stepped Harness Factory work item from intake through triage, planning, implementation, continuation, publication, and merge acknowledgement. Use when asked to run, resume, inspect, or recover Factory; interpret its next reaction or durable evidence; or apply guarded Linear projections.
---

# Factory Operator

Run Factory as a manual, durable state machine. Execute one selected action,
inspect its persisted result, report the boundary, and return control to the
caller. Never turn the CLI into an automatic loop.

## Operating contract

- Operate one work item at a time.
- Treat the durable Factory event log as machine truth. Treat Linear and GitHub
  as retryable human-facing projections.
- Use one fixed Harness controller checkout for every command in an active
  phase. When dogfooding Harness, pass a separate mutable checkout through
  `--workspace`; do not run a CLI that changes underneath the phase.
- Run only the exact action selected by durable state. One invocation executes
  at most one handler, persists its result, prints the next reaction, and exits.
- Wait for process exit. Action-started output and heartbeats mean progress, not
  completion. Do not poll with competing commands while an action is running.
- Stop after every action boundary. Report the result and exact printed next
  command; let the caller decide when to invoke it.
- Never infer a Factory transition from a Linear status, a comment, an agent
  message, or mutable workspace state.
- Require explicit authority for each external mutation: Linear `--apply`, plan
  publication, implementation publication, and merge acknowledgement. Opening
  a pull request never authorizes merge.
- Do not invent a review-round ceiling. When the caller supplies one, compare it
  with durable `reviewRound` before recording another continuation. Count
  completed review rounds, not retries or revisions.

## Load detail only when needed

- For Linear intake, `--apply`, role selection, or store overrides, read
  [Linear and configuration](references/linear-and-config.md).
- For a failed action, replay, projection repair, incompatible store, or deep
  evidence inspection, read
  [Recovery and evidence](references/recovery-and-evidence.md).
- For exact commands and flags, run `harness factory --help` and the relevant
  subcommand help. Generated help owns the current command surface.

## Preflight

1. Confirm the fixed controller checkout and mutable target workspace.
2. Record the target branch or detached state, exact `HEAD`, worktree status,
   and expected base. Stop on unexplained drift.
3. Run read-only `factory status`. When resolving one item, also run `factory
inspect`. Use the same store overrides planned for later actions.
4. Fetch the live tracker issue when it is the input source. Reconcile its
   scope with the delegated authority and durable Factory state.
5. Confirm which mutations are authorized: Linear projections, branch push,
   pull-request publication, and merge acknowledgement. Treat merge itself as
   unauthorized unless the user explicitly says otherwise.
6. Stop if the task direction conflicts with the persisted phase, reaction, or
   immutable work item. Do not rewrite durable artifacts to force a route.

## Run one action

1. Invoke one phase command with the same workspace and store identity used in
   preflight.
2. Wait synchronously for exit. Do not start another Factory command for that
   work item while the action is active.
3. Read terminal stdout, then `summary.md` and `meta.json`. Follow referenced
   action results and evidence when the boundary needs verification.
4. Verify the executed handler, attempt, causation, terminal event, route, and
   next reaction. A wait reaction has no runnable action.
5. Send one concise checkpoint containing:
   - command and exit status;
   - work item, phase run, handler, attempt, and terminal event;
   - durable outcome, route, and exact next command or wait reason;
   - evidence inspected, Git state, and external mutations;
   - findings, blockers, and any decision required from the caller.
6. Pause. Invoke the next command only after caller authority. Do not wait in a
   polling loop for the caller.

## Triage

- Run live triage for classification. Use `--dry-run` only to check wiring and
  artifact layout; it does not produce an authoritative route.
- Expect one of four durable routes: direct implementation, planning, needs
  information, or park/wait.
- Stop on an unexpected route and report the triager rationale. Do not fabricate
  a planning phase or manually edit the route.
- Use `--rerun` only for an intentional re-triage after reconciling prior
  history. Normal retries should recover the existing action or projection.

## Planning

- Invoke `planning run` once per runnable reaction. Candidate production and
  review are separate manual invocations.
- Before the first review, use `revise` when a human response requires changed
  plan bytes. After a non-pass review, record either:
  - `revise`: resume the saved planner session and create a new candidate;
  - `re-review`: keep the candidate and send accepted clarification or evidence
    back to reviewers.
- Put the response in an absolute, nonblank UTF-8 file no larger than 32 KiB.
  It may clarify the immutable work item; it may not expand or override it.
- Treat `planning continue` as a durable decision only. It invokes no handler;
  run the separately printed `planning run` command later.
- Publish only the exact reviewed plan after explicit authority. Stop and report
  the pull request. After a human merge, verify the recorded URL and merge
  commit, then run the explicit merge-acknowledgement command.

## Implementation

- Start from a clean attached target branch with durable direct readiness or an
  approved plan committed at `HEAD`.
- Invoke `implementation run` once to produce an immutable candidate. Harness
  must not move the branch or real index during production.
- Before invoking reviewers, inspect the implementer evidence and run the target
  repository's required final handoff gate from the target workspace. Provider
  claims, focused checks, and Git hooks do not replace a green final gate.
- If the gate finds a deterministic code failure, record a pre-review `revise`
  continuation with the exact command and failure evidence, then resume the
  saved implementer session. This does not consume a review round.
- If infrastructure prevents the gate from running, stop and report the blocker.
  Do not fabricate a revision or review finding for an environment failure.
- Invoke the printed command again to run Factory's implementation and quality
  reviewers against that candidate. Do not run a separate standalone
  `change-review` for the Factory candidate.
- On non-pass, record `revise` or `re-review` with the same response rules as
  planning. `revise` resumes the effective implementer session and carries the
  complete persisted findings into a distinct candidate. `re-review` invokes
  no producer and reviews the unchanged candidate with the accepted response.
- Treat `implementation continue` as a durable decision only; invoke the
  printed `implementation run` separately.
- On pass, verify that Factory promoted the exact reviewed commit and left the
  branch and index clean.
- Publish only after explicit authority. Stop at the recorded pull request and
  let the human decide whether to merge. After a human merge, verify the URL and
  merge commit before running merge acknowledgement.
- After Factory records the implementation PR merge, the orchestrator cleans up
  any ephemeral target worktree or Grove lease it created, using provider-native
  tooling. Retain it for earlier waits or failures; preserve Factory evidence.

## Retry and recovery rules

- Repeat an explicit `--apply` command to repair its failed Linear projection.
  Recovery must not append a duplicate phase request or rerun a completed
  provider action.
- Use `--rerun` only when the phase failed without a reusable candidate, or for
  explicitly authorized re-triage. Never use it to abandon a valid candidate.
- Preserve the original producer session across revisions. Reject missing,
  malformed, or wrong-provider session continuity rather than silently starting
  over.
- Preserve existing runs, immutable refs, results, and user data. Never edit or
  delete durable state to manufacture success.
- Follow the recovery reference before acting on store incompatibility,
  provider/reviewer mutation, interrupted publication, or ambiguous transport.

## Stop conditions

Stop and report before:

- any `wait` or human reaction;
- an unexpected route, handler, candidate, review verdict, or next command;
- conflicting or missing mutation authority;
- concurrent action ownership or a still-running command;
- controller, target branch, `HEAD`, index, workspace, candidate ref, or current
  phase-ref drift outside the action's documented authority;
- an incompatible or unmarked non-empty Factory store;
- unsupported mutation of Linear, GitHub, Jira, Inngest, or other systems;
- merge, unless the user explicitly authorizes it;
- committing generated `.harness/runs/*` or modifying durable Factory evidence;
- restoring a removed dispatcher, adding a CLI loop, or batch-moving inbox
  items.
