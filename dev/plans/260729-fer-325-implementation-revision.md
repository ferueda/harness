# Add resumable implementation revision

## Goal

Add a provider-neutral operation that resumes the original implementation
author after a completed `change-review` requests material changes. The
operation must evaluate every actionable finding, update the existing workspace
when warranted, preserve the selected plan or Linear issue as task authority,
and return a normalized continuation session. It must not own review execution,
Git inspection or checkpoints, repository allocation, Linear, Inngest, GitHub,
or publication.

## Changes

1. `workflows/implementation-review-findings.ts` and
   `lib/implementation/finding-identity.ts` — add a small edge adapter that
   accepts both validated `change-review` outputs and the exact reviewed Git
   revision, selects only `must_fix: true` findings, and assigns deterministic
   IDs bound to the revision, reviewer kind, and canonical finding content.
   Keep the generic review-output dependency outside the implementation domain.
   Reject incomplete, invalid, duplicate, or non-actionable review input before
   it can become revision authority. Prove this at the adapter seam for both
   reviewers, advisory findings, stable identity, changed identity inputs, and
   invalid input.
2. `lib/implementation/revise-schema.ts`,
   `schemas/implementation-revision-result.schema.json`, and
   `lib/implementation/revise-prompt.ts` — define the strict trusted-review,
   author-session, evidence, response, and `updated | unchanged | needs-input`
   contracts plus the revision prompt. Require exactly one
   `accepted | adapted | declined` response per actionable finding; require
   evidence for adapted and declined findings; and keep the selected
   implementation source as authority. `updated` requires at least one accepted
   or adapted finding, no questions, and at least one focused proof record.
   `unchanged` requires every finding to be declined with evidence, no
   questions, and at least one proof record supporting the no-change decision.
   Either result records remaining uncertainty when proof failed or was
   skipped. `needs-input` requires focused prerequisite questions, no proof or
   remaining-uncertainty records, and evidence for every disposition because
   no workspace update is being accepted as proof. The resumed author may leave
   partial edits for this outcome, but the caller must not checkpoint or publish
   them and owns resetting the workspace. Tell the author to research,
   implement, and verify without running Git, reviewers, or external mutations.
   Keep exported JSON and Zod result schemas aligned.
3. `lib/implementation/revise.ts` — implement the independent revision
   operation using the existing provider-neutral `Agent` and implementation
   source primitives. Validate the trusted finding identities and original
   session before invocation, inspect and verify the plan or Linear source
   around the resumed run, enforce the workspace-write guard, validate the
   complete response set, require a normalized returned continuation session,
   and return prompt/schema/source/review provenance. Source or session
   integrity failures fail closed; the caller remains responsible for deciding
   whether repository changes match the declared outcome and for creating or
   rejecting any checkpoint. The operation does not inspect Git: `updated`
   declares that accepted changes were made, `unchanged` declares that no
   change is warranted, and `needs-input` ends without an accepted workspace
   effect even when partial edits remain.
4. Focused tests beside the new implementation files — prove both plan and
   complete Linear sources, exact session continuation, all dispositions and
   outcomes, missing/unknown/duplicate responses, stale or altered findings,
   source mutation, provider and workspace-guard failures, missing exported
   schema, prompt policy, and Zod/JSON-schema alignment. Use fake agents and
   temporary workspaces; these tests do not prove a live provider invocation.

## Verify

- Run
  `pnpm exec vitest run test/implementation-review-findings.test.ts lib/implementation/revise-schema.test.ts lib/implementation/revise-prompt.test.ts lib/implementation/revise.test.ts lib/implementation/revise-schema-failure.test.ts`
  → the adapter, prompt, Zod/JSON schemas, both source modes, source integrity,
  session continuation, all valid outcomes, workspace-effect declarations, and
  failure contracts pass at their stable operation seams.
- Run `make check` → formatting, lint, type checks, tests, and distribution
  smoke pass.
- Run
  `harness run change-review --plan dev/plans/260729-fer-325-implementation-revision.md`
  for the branch changes → the full implementation and code-quality reviewer
  set completes with no actionable findings.

## Boundaries

- Do not modify the generic `ReviewOutput` contract or make
  `lib/implementation` import the `change-review` workflow.
- `must_fix: false` findings remain advisory and do not require a disposition.
- Do not add the Inngest revision cycle, repository checkpoint handling, Linear
  projection, GitHub publication, or retry policy; FER-326 owns that
  coordination.
- No live provider smoke is required without separate authority.
