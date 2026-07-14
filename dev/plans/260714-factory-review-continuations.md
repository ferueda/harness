# Preserve Factory candidates through review continuations

## Goal

Replace Factory's automatic `needs_changes -> producer` rule with an explicit,
durable continuation decision shared by planning and implementation. A
non-pass review, an operator correction before review, or an action failure
after a valid candidate must preserve that immutable candidate and wait. The
operator can then choose `revise` or `re-review` with a bounded response file;
the next normal `run` invocation performs at most one handler.

Acceptance:

- `revise` keeps the phase, prior candidate, original producer session, and
  original base, then produces a distinct candidate;
- `re-review` runs reviewers against the exact existing candidate without
  invoking the producer or requiring a new Git tree;
- the response file is copied into the durable store, hashed, tied to the exact
  candidate and optional review, and supplied to the selected handler;
- planning and implementation use the same continuation semantics;
- candidate identity survives human-required or terminal action failures when
  a prior immutable candidate is still valid;
- no review response automatically invokes another handler, and future Inngest
  scheduling consumes the same reaction contract;
- incompatible version-2 lifecycle state is rejected before parsing. No
  migration or compatibility path is added.

This corrects the verified failure in the current model: review findings have
only `must_fix`, while `lib/factory-state-machine.ts` treats every
`needs_changes` result as code work. Evidence-only findings therefore invoke a
producer that cannot satisfy them with a new tree; `--rerun` then abandons the
valid candidate and starts a fresh session.

## Changes

1. `lib/factory-store-format.ts`, `lib/factory-lifecycle-events.ts`,
   `lib/factory-state-machine.ts`, and `lib/factory-phase-run.ts` — make this one
   clean store-format version 3 cutover. Add one strict
   `factory.continuation.recorded` event containing phase, decision
   (`revise | re-review`), exact candidate event, optional review event, and a
   digested response artifact. Replace the overloaded phase `attempt` with
   explicit candidate attempt and review round in state and review events.
   Non-pass reviews and failures with a retained candidate project to
   `awaiting-continuation`; only the continuation event schedules another
   producer or reviewer. Retryable action failure retains its existing
   same-action behavior.

2. Remove `factory.<phase>.maxReviewIterations`, persisted `reviewCeiling`, and
   the automatic ceiling transitions from `lib/schemas.ts`, `lib/config.ts`,
   root `harness.json`, run contexts, events, commands, examples, and tests.
   Keep the tracked repository config parseable by the new strict schema.
   Manual continuation is the loop bound: without a new explicit response
   event, neither CLI nor a future scheduler has work to run. Do not replace the
   ceiling with another counter, policy engine, or hidden auto-loop.

3. Add a small shared continuation artifact module and `planning continue` /
   `implementation continue` command paths in `bin/factory-commands.ts`,
   `bin/factory-planning-cli.ts`, and `bin/factory-implementation-cli.ts`.
   Require an absolute, nonblank UTF-8 `--response-file` of at most 32 KiB and
   `--decision revise|re-review`. Validate live work-item/phase/candidate/review
   identity, copy the exact bytes durably, append one CAS-protected event, and
   print the next normal `run` command without invoking a provider or reviewer.
   A candidate merely awaiting its first review permits only pre-review
   `revise`. After a completed non-pass review, or after a non-retryable producer
   or reviewer failure that retains a prior valid candidate, permit `revise` or
   `re-review`; omit the review reference when no completed review exists.
   Retryable failures remain on their same-action path. Linear stays in Planning
   or Implementing; the continuation command makes no tracker projection.

4. `lib/factory-plan-candidate-action.ts`,
   `lib/factory-implementation-candidate-action.ts`, revision loaders, and
   producer prompts — resolve a `revise` reaction through the continuation to
   its exact candidate and optional review. Supply the complete blocking
   findings when present plus the accepted operator response, resume the saved
   same-provider session, and retain the existing immutable candidate,
   workspace, Git-authority, create-only ref, and no-same-tree checks. Remove
   restart-guidance fields, `--rerun-guidance-file`, and their replay logic;
   continuation supersedes that pre-review patch without abandoning work.

5. `lib/factory-plan-review-action.ts`,
   `lib/factory-implementation-review-action.ts`, review evidence, and review
   handoff prompts — resolve a `re-review` reaction to the unchanged candidate,
   increment only the review round, and include the exact prior review findings
   and accepted response. Preserve fixed read-only review coverage, immutable
   evidence, action-result recovery, implementation workspace/ref guards, and
   exact pass promotion. Remove the unused constant implementation
   `handoff.json`; the generated review handoff and continuation artifact own
   reviewer context.

6. Coordinator recovery in the planning and implementation CLIs — retain
   candidate/review identity when a later producer or reviewer action ends
   human-required or terminal. A reusable candidate must lead to
   `awaiting-continuation`, not a fresh-phase rerun suggestion. Fresh `--rerun`
   remains only for failures before any valid candidate exists and continues to
   require normal clean-start gates. Planning re-review reads the digested
   durable candidate directly, and planning revision recreates its transient
   scratch from that candidate; scratch loss or drift is not recovery state.
   Implementation never auto-restores an uncertain workspace and continues
   only when the live workspace tree exactly matches the immutable candidate.

7. Update `README.md`, `docs/contributing/factory.md`,
   `docs/contributing/harness-engineering.md`,
   `docs/contributing/architecture.md`,
   `docs/contributing/script-command-surface.md`, and
   `skills/factory-operator/SKILL.md` with the manual sequence and public
   command/mutability inventory:
   candidate -> review -> wait -> continue -> one later action. State that
   external/operator-only proof belongs in the response artifact, reviewers may
   accept that proof on an unchanged candidate, `--rerun` is not candidate
   continuation, and Inngest must wait for the same durable continuation event.

8. Extend the existing Factory state-machine, planning, implementation, CLI,
   recovery, schema/config, docs-contract, and smoke seams. Prove pre-review
   revise, review-driven same-session revise, evidence-only re-review with zero
   producer calls and unchanged candidate commit/tree, blocked review response,
   retained-candidate action failure, response tamper/replay rejection,
   concurrent CAS convergence, pass publication, and version-2 rejection.

## Verify

- Focused Factory lifecycle, planning-action, implementation-action, CLI,
  repository-config validation, and docs-contract tests.
- `pnpm check` and `git diff --check`.
- Live disposable manual smoke: implementation candidate -> non-pass review for
  missing external proof -> operator records proof -> unchanged candidate
  re-review passes -> exact candidate publishes; assert one producer session,
  two review rounds, no new candidate ref, and terminal replay invokes nothing.
- Equivalent compact planning smoke for a reviewer clarification that requires
  revision, proving the original planner session resumes.

## Cutover and FER-83

Do not import or migrate active version-2 runs. After this change is reviewed,
finish FER-83 from its already-preserved immutable candidate and passed live
smoke outside the obsolete lifecycle, then use a disposable version-3 item for
the end-to-end Factory smoke above. A permanent cross-version candidate importer
would add migration machinery for a one-time recovery and is explicitly out of
scope.

## Boundaries

- No handler registry, DAG, scheduler, generic workflow engine, evidence search,
  automatic finding classifier, or provider-specific branch.
- Do not ask reviewers to decide whether the producer should run; the operator
  continuation event owns that choice.
- Do not weaken candidate digests, session continuity, Git authority, workspace
  validation, action-result recovery, CAS append/promotion, or human PR merge
  authority.
- Do not preserve version-2 lifecycle compatibility or the restart-guidance
  feature it introduced.
