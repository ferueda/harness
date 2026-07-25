# Deliver the independent Linear Spec consumer

## Goal

Compose the existing Linear readiness, Spec, repository-run, and GitHub
publication primitives into the first durable `work/spec.requested` consumer.
An eligible `Open + Spec + Agent Ready` issue is claimed before its one-shot
permission is removed. A completed Spec is published once and handed to a human
in `Needs Review`; a true prerequisite question moves to `Needs Input` without a
pull request. Linear remains lifecycle authority, Inngest owns delivery and
retry state, and Git/GitHub own the review artifact.

The consumer must fail closed on stale or incomplete Linear context, invalid
agent output, an invalid Spec artifact, or any unrelated workspace change.
Stable work-request-derived run, branch, comment, commit, and pull-request
identities must make replay converge without a new workflow store.

## Changes

1. `lib/spec/presentation.ts` and focused tests — add pure, bounded formatters
   for the locked pull-request title/body and Linear outcome comments, plus
   outcome-specific workspace validation. Ready for review requires exactly one
   newly added or untracked `dev/plans/FER-XYZ.md`; it may also include an added
   or modified `dev/plans/README.md` when the repository requires plan-index
   reconciliation. Reject a modified pre-existing primary Spec, deletion,
   rename, copy, conflicts, unrelated files, and a missing primary artifact.
   Needs Input requires a completely clean workspace because the prompt must
   choose that outcome before writing.

   Derive all identities from
   `workRequestEventId("spec", event.data)`. Use that exact value as the
   repository run ID; use the first 12 hexadecimal characters of its existing
   digest in `harness/spec/FER-XYZ-<digest>`; commit as
   `docs: add FER-XYZ spec`; and mark comments as
   `<!-- harness:linear-spec:<work-id>:<ready-for-review|needs-input|failure> -->`.
   The PR title is `FER-XYZ: Spec for <Linear title>`, truncating only the
   Linear-title suffix to fit 240 characters. Its body is bounded to 20,000
   characters and contains the Linear link, artifact path, validated summary,
   every reviewer decision with its recommendation (or `None.`), and
   provider/model/policy provenance. Linear comments are bounded to 8,000
   characters and contain the outcome rationale, concise summary or every
   smallest prerequisite question, artifact/PR link when present, every
   reviewer decision and recommendation, provenance, and the hidden marker;
   they never paste the complete Spec. Formatters may truncate only descriptive
   summary/rationale/error prose to a 2,000-character field cap. They must
   preserve the marker, links, questions, decisions/recommendations, and
   provenance in full. If required content still exceeds its body limit, return
   a deterministic presentation-validation failure, publish/project nothing,
   and use the separately bounded failure comment; never slice the completed
   body. Before ready-for-review publication, preflight the complete Linear
   comment with a reserved canonical PR URL built from the validated GitHub
   owner/repository and a 20-digit pull-request number. The returned GitHub URL
   must fit that reservation before final formatting. A near-limit comment that
   fails this preflight must cause no commit, push, PR, final projection, or
   cleanup.

2. `lib/linear-automation/spec-consumer.ts` and
   `lib/linear-automation/spec-consumer.test.ts` — add the typed
   `work/spec.requested` Inngest function with
   `{ key: "event.data.issueId", limit: 1 }` concurrency. Refetch and verify the
   exact generation, complete context, scope, labels, state, and blockers; guard
   `Open → In Progress`; then remove only `Agent Ready`. A memoized retry resumes
   after its recorded claim step, while a fresh delivery that observes
   `In Progress` stops as already claimed. Test duplicate/overlapping deliveries
   so only one agent and repository run proceeds.

   Call `lib/spec` with normalized Linear context and the isolated workspace.
   After the agent and before either publication or Needs Input projection,
   refetch once and require complete context, the same issue/team/project and
   normalized source fields, `In Progress`, `Spec` retained, `Agent Ready`
   absent, no conflicting action, and the same blocker set and states. Ignore
   only the consumer's expected state/permission mutations and resulting
   `updatedAt`; any human cancellation, comment/title/description/link/relation
   change, label drift, or blocker drift stops without publication or final
   projection and retains the run.

   Resolve the mutable base ref in its own durable step and persist that exact
   `RepositoryBase`; prepare or resume the run in the following step using the
   frozen base SHA, even if the remote base advances during a retry. Keep
   provider execution, post-agent confirmation, diff inspection, publication,
   each Linear mutation, and cleanup in separate durable steps. For either
   successful outcome, use this exact cutover order: publish first only for
   ready-for-review; ensure the marked outcome comment; clear only `Spec`; guard
   `In Progress → Needs Review|Needs Input`; then clean the run. Deterministic
   validation failures add one marked diagnostic comment and retain the claimed
   run; provider, timeout, cancellation, GitHub, Linear, and repository
   transport failures use Inngest retries, with an exhaustion comment from
   `onFailure`. Use the Inngest setup/CLI guidance for retry-safe step boundaries
   and `@inngest/test` coverage. Prove replay from an existing claim, frozen
   base SHA after the remote advances, marked comment, publication commit/PR,
   partial comment/label/state projection, and cleanup response without
   duplicating any effect. Publication must return an open, unmerged pull
   request. If replay recovers an exact closed or merged PR, treat it as a
   deterministic conflict, add the failure evidence, retain the claimed run,
   and perform no final projection or cleanup.

3. `lib/linear-automation/work-item.ts` and existing triage coverage — extract
   the already-proven Linear-to-work-item normalization from the triage
   consumer so Spec can reuse it without coupling either operation to the
   other. Continue hiding `Agent Ready` from agent context while preserving
   action and unrelated labels.

4. `lib/linear-automation/config-schema.ts`,
   `lib/linear-automation/config.ts`, `lib/linear-automation/worker.ts`,
   `lib/linear-automation/worker.test.ts`, and `test/config.test.ts` — add an
   optional fixed Codex `linearAutomation.spec` profile whose presence is the
   enablement signal. When absent, keep `spec: false`, do not register the
   consumer or observe `Open`, and keep triage-only configurations valid without
   repository or GitHub settings. When present, compose the Spec consumer
   atomically with its repository and GitHub services. Require an absolute
   `HARNESS_REPOSITORY_ROOT`, `repositoryRuns`, `GITHUB_TOKEN`,
   `GIT_AUTHOR_NAME`, and `GIT_AUTHOR_EMAIL` before enabling the route. Derive
   deterministic controller/pool paths from the configured remote, use the
   top-level base ref, register the consumer, and only then observe `Open`.
   Parse `repositoryRuns.remote` as a credential-free github.com SSH or HTTPS
   remote before consumer registration; invalid or credential-bearing remotes
   fail startup. Test disabled startup plus enabled missing-config, invalid
   remote, and valid construction. Lock Spec execution to `gpt-5.6-sol`, high
   reasoning, and
   `maxRuntimeMs: 1_800_000`; keep the worker's 35-minute shutdown grace period
   longer than the largest enabled 30-minute agent run.
   Keep GitHub, Linear, and Inngest credentials out of the Codex environment.
   Apply the Node and Zod guidance to startup validation and immutable settings.

5. `harness.json`, `compose.linear-automation.yaml`,
   `scripts/smoke-linear-automation.ts`, `bin/linear-worker-command.ts`,
   `test/cli.test.ts`, and contributor docs — activate the controlled
   `gpt-5.6-sol`/high Spec route in the same change, pass required worker-only
   environment values through Compose, and extend the offline Linear journey
   through claim, Spec publication, final projection, and cleanup using fake
   provider/repository/GitHub boundaries. Update the public worker command help
   and its focused assertion, plus only current operator and architecture
   descriptions that otherwise misstate the registered functions, observed
   states, required secrets, or lifecycle.

## Verify

- Run focused Vitest suites for Spec presentation/validation, the durable Spec
  consumer, worker composition, and config parsing. Consumer tests must prove
  incomplete initial context causes no claim or agent run; representative
  post-agent source, label, and blocker drift causes no publication or final
  projection and retains the run; and representative invalid output/artifact
  or workspace changes produce one marked diagnostic comment with no
  publication or cleanup. Directly exercise the registered or extracted
  `onFailure` handler because `@inngest/test` does not invoke it automatically:
  a representative exhausted failure must derive the marker from the original
  work request, keep the comment bounded, converge to one comment on replay,
  and perform no final projection or cleanup.
- Run `make smoke-linear-automation` for the local self-hosted Inngest journey.
- Run `make smoke-linear-automation-compose` when the Compose boundary changes.
- Run `make check`.

## Boundaries

- Do not add implementation, Spec review, or Spec revision consumers.
- Do not add a lifecycle database, generic station/claim engine, reusable
  workflow framework, automatic re-triage, or failure labels/statuses.
- Do not expose the shared `/workspace` as writable or give the agent direct
  Linear, GitHub, or Inngest access.
- Do not run live Linear, GitHub, or model traffic without separate explicit
  authority; the required handoff proof is local and disposable.
