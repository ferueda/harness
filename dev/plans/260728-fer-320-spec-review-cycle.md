# Run a bounded Spec review and revision cycle

## Goal

Cut the current one-shot `work/spec.requested` consumer over to one bounded,
durable author → review → revision cycle. The function coordinates existing
domain and service primitives; it does not become a workflow framework.

The automated success path publishes only an approved exact checkpoint. After
three reviews and at most two revisions, unresolved findings produce one
clearly unapproved human-review pull request from the latest exact checkpoint.
Every terminal path has an explicit Linear outcome and attempts to clean the
repository run.

## Changes

1. `lib/linear-automation/spec-cycle.ts` and focused tests — add the small pure
   policy boundary used by the consumer. Keep the repository run and branch
   tied to the original work request. Bind every checkpoint-dependent review,
   revision, child checkpoint, comment, and publication identity to that root,
   its fixed round number, and a stable digest of the exact reviewed checkpoint
   revision. Assert collision resistance between different checkpoints at the
   same round and convergence when the same checkpoint replays. Map trusted
   Spec provenance, normalized author continuations, review findings, and
   revision dispositions without persisting provider raw session data. Lock
   exactly three reviews and two revisions; only an `updated` revision advances
   the checkpoint.

   Durable load and authority steps return only bounded eligibility/authority
   status, stable issue identity, and the source fingerprint. Fetch and consume
   complete Linear context inside the author or revision step that needs it;
   do not return issue bodies, comments, relations, links, or full work-item
   context from a durable step. Every author, review, and revision agent step
   fetches and consumes the complete current Linear context inside that same
   step, then returns only its bounded validated operation result. Assert this
   serialized boundary and replay behavior directly.

2. `lib/spec/presentation.ts` and focused tests — add the guards and bounded
   presentation needed by the cycle. Initial authoring still allows only the
   new `dev/plans/FER-XYZ.md` artifact and optional plan-index update. An
   `updated` revision may modify only that existing Spec artifact;
   `unchanged` and `needs-input` require a clean workspace. Render distinct
   approved, exhausted-unapproved, needs-input, stale, and operational-failure
   handoffs without pasting the full Spec. Preserve finding IDs and a bounded
   summary of each unresolved finding, and replace the old retained-workspace
   failure wording with manual requeue and cleanup semantics.

3. `lib/linear-automation/spec-consumer.ts` and its Inngest tests — evolve the
   existing consumer in place. Keep load/claim, base resolution, run
   preparation, agent calls, checkpoint operations, Linear writes, publication,
   and cleanup as durable steps with deterministic round IDs.

   Make the Open → In Progress claim and Agent Ready consumption separate
   durable steps. If the state claim succeeds but permission consumption
   exhausts, carry only that known partial-claim fact into recovery so it can
   guardedly reopen and remove Agent Ready. After permission consumption
   succeeds, a later human-restored Agent Ready label is authority drift and
   must be preserved.

   After initial authoring, branch before checkpoint creation. Initial
   `needs-input` requires a clean workspace, a fresh authority check, Needs
   Input projection, and cleanup. Only a validated `ready-for-review` result
   creates checkpoint 0. For reviews 0–2, reopen and verify the exact clean
   checkpoint before and after a fresh independent read-only review. Approval
   exits the loop. Requested changes before the final review refetch authority,
   resume only the normalized author continuation, run one revision, and
   refetch authority again before accepting its result. `updated` validates the
   modified Spec and creates one child checkpoint; `unchanged` requires a clean
   workspace, retains the checkpoint/session, counts the attempt, and
   continues; `needs-input` requires a clean workspace and terminates without
   publication.

   Recheck Linear authority after initial authoring, before and after each
   revision, and before publication/final projection. Publish an approved or
   explicitly exhausted checkpoint through
   `publishCheckpointPullRequest`; remove the consumer's create-and-commit
   publication path. Centralize post-prepare terminal handling so success,
   Needs Input, stale authority, exhaustion, and operational failure all
   attempt cleanup. On operational failure, add one marked diagnostic and
   guardedly reopen only the still-current `In Progress + Spec` claim, leaving
   `Agent Ready` absent. Preserve newer human lifecycle changes.

   Before every initial-author retry, require a clean repository run. Inside
   every revision attempt, reopen and verify the exact reviewed checkpoint
   before invoking the author. Inngest rolls back step results, not filesystem
   edits: if a failed attempt left partial changes, the next attempt must fail
   checkpoint verification and enter recovery rather than consuming or
   checkpointing those changes.

   Lock terminal Linear projection as follows:

   | Outcome                                          | Publish                                    | State                  | `Spec`                  | `Agent Ready`           |
   | ------------------------------------------------ | ------------------------------------------ | ---------------------- | ----------------------- | ----------------------- |
   | Approved                                         | exact approved checkpoint                  | Needs Review           | remove                  | absent                  |
   | Review exhausted                                 | exact latest checkpoint, marked unapproved | Needs Review           | remove                  | absent                  |
   | Needs Input                                      | none                                       | Needs Input            | remove                  | absent                  |
   | Stale, claim still current                       | none                                       | guarded return to Open | keep                    | absent                  |
   | Stale after human lifecycle change               | none                                       | preserve current state | preserve current labels | preserve current labels |
   | Operational failure, claim still current         | none                                       | guarded return to Open | keep                    | absent                  |
   | Operational failure after human lifecycle change | none                                       | preserve current state | preserve current labels | preserve current labels |

   In terminal projections, write the marked comment first, then guard the
   expected-state transition, then remove the relevant label only after that
   guard succeeds. Recovery comment, state, and label mutations are separate
   durable steps, so a partial retry resumes label cleanup from the memoized
   successful state guard without reclassifying an already reopened issue. A
   failed lifecycle guard must perform no label change.

   Keep `onFailure` as a bounded last-resort diagnostic for failures before
   normal recovery can finish; do not depend on it to recover a repository run
   because it cannot access the main run's durable results. Tests must prove
   first-review approval, one/two revisions, unchanged reuse, Needs Input,
   exhausted handoff, session/provider guards, reviewer mutation detection,
   authority drift during review/revision, stable replay, exact checkpoint
   publication, every row in the terminal projection table, guarded reopening,
   and cleanup attempts on every post-prepare terminal path.

   Add distinct failure tests at the provider/retry, checkpoint, GitHub, Linear,
   and cleanup durable boundaries. A cleanup failure after terminal projection
   records bounded operator evidence without rolling back the lifecycle
   outcome. The cleanup diagnostic itself remains retriable; if it exhausts,
   fail the function so `onFailure` gets the final best-effort attempt. Replays
   must not duplicate the claim, agent sessions, checkpoints, comments, branch,
   or pull request.

   Use Inngest's native step rollback contract: wrap each retriable
   `step.run()` boundary in `try`/`catch`. Inngest retries that step
   independently; only after its configured retries are exhausted does the SDK
   throw a `StepError` back into the function. Convert that exhausted error into
   the bounded operational-failure input for the shared recovery path, which
   still has the durable run/checkpoint handle. Permanent validated failures
   enter recovery directly without retrying. If recovery itself exhausts,
   allow the function to fail so `onFailure` can make its last best-effort
   diagnostic. Do not add a manual retry counter or provider retry loop.

4. `lib/linear-automation/worker.ts`, configuration tests, and GitHub
   publication types/tests — inject separate author and reviewer adapter
   instances while reusing the one configured Spec execution profile. Review
   receives no continuation; revision uses the author adapter and latest
   normalized continuation. Remove the obsolete
   `GitHubPublicationService.publishPullRequest` create-and-commit surface,
   publication-author settings, and worker environment requirements once no
   consumer uses them. Keep exact-checkpoint publication as the only GitHub
   write path.

5. `scripts/smoke-linear-automation.ts`, `harness.json`,
   `compose.linear-automation.yaml`, and contributor/operator docs — update
   only boundaries changed by the cutover. The local smoke should cover
   authoring, checkpoint 0, an independent approving review, exact checkpoint
   publication, final Linear projection, and cleanup with fakes. Remove stale
   Git-author configuration and document the bounded review/revision behavior
   and failure requeue semantics.

## Verify

- Run focused Vitest suites for cycle policy, Spec presentation, the durable
  consumer, worker/config composition, repository checkpoints, and GitHub
  checkpoint publication.
- Run `make smoke-linear-automation`.
- Run `make smoke-linear-automation-compose` because the worker environment and
  Compose boundary change.
- Run the existing repository and publication smokes when their public
  boundaries change.
- Run `make check`.
- A disposable live Spec review/revision smoke requires separate explicit
  authority because it calls a real model and external services.

## Boundaries

- No new lifecycle events, workflow engine, station registry, or workflow
  database.
- No implementation consumer, implementation reviewer, or GitHub
  review-webhook automation.
- No model-authored durable IDs, tracker writes, Git commands, or publication
  calls.
- No full issue, Spec body, diff, prompt, raw agent output, or provider raw
  session data in events or durable step outputs.
- Do not retain Grove runs automatically; cleanup failure produces bounded
  operator evidence instead.
