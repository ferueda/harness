# Expose complete change-review results to callers

## Goal

Make the existing `change-review` workflow return the complete validated
implementation and code-quality reviews to programmatic callers while
preserving its current reviewer execution, aggregation, artifacts, events, and
CLI JSON.

The result must retain a completed sibling review when the other reviewer
fails, expose typed reviewer failures, and keep the exact reviewed Git scope
already present in run metadata. This is an extension of the existing workflow,
not a second review operation or schema.

## Changes

1. `workflows/review-steps.ts:runReviewSteps` — return one internal execution
   result containing the unchanged exported metadata plus the successful
   `ReviewSection` values and typed `FailedReview` values already assembled in
   memory. Keep parallel execution, aggregation, and `ctx.export` /
   `ctx.exportFailed` artifact ownership unchanged.

2. `workflows/change-review.workflow.ts:run` — export an additive, discriminated
   `ChangeReviewResult` that preserves every existing top-level metadata field
   and adds these non-colliding programmatic fields:

   ```ts
   {
     runId: string;
     runDir: string;
     workspace: string;
     scope: {
       baseRef: string;
       headRef: string;
       mergeBase: string;
       headSha: string;
     };
     reviewOutputs: {
       implementation?: ReviewOutput;
       quality?: ReviewOutput;
     };
     reviewFailures: readonly FailedReview[];
   }
   ```

   Keep the existing summarized `reviews` metadata unchanged and retain the
   existing failed-run `failedReviews` field. A `completed` result has a typed
   aggregate verdict and no review failures. A `failed` result has no aggregate
   verdict, retains every completed sibling output, and has at least one typed
   review failure. The existing `dry_run` state has no aggregate verdict, no
   real review outputs, and no failures. Require the run identity and exact Git
   scope from the supplied workflow context before returning any state. Build
   review values only from `runReviewSteps`; do not reread files or create a
   second schema.

3. `workflows/plan-review.workflow.ts:run` and `bin/harness.ts:addReviewCommand`
   — keep unrelated public surfaces stable. Plan review continues returning its
   existing metadata object. The change-review CLI explicitly projects the
   callable result back to the existing metadata view: remove
   `reviewOutputs`/`reviewFailures`; retain `runDir` only for `dry_run`, where it
   already exists; and preserve the existing failed-run `failedReviews`. Its
   JSON, exit-code rules, summaries, events, and artifact files therefore do
   not gain the programmatic-only payload or a new completed/failed field.

4. `test/review-steps.test.ts` and `test/cli.test.ts` — extend the highest
   existing workflow seam to prove both-review success returns the exact
   in-memory objects, selected-step runs omit the unrequested review, and
   partial failure retains the completed sibling plus typed failure details.
   At the workflow-context seam, use a temporary Git repository and fake
   provider to assert completed and partial-failure results expose the context
   artifact directory and a `scope.headSha` equal to the exact reviewed Git
   `HEAD`. Directly assert a callable dry run has `status: "dry_run"`, no
   aggregate verdict, no real review outputs, and no reviewer failures despite
   the runtime's synthetic prompt-generation reviews. Assert the CLI output
   still omits the programmatic-only fields and preserves its existing
   state-specific `runDir`/`failedReviews` behavior. Keep the existing
   provider-factory assertions as proof that the shared reviewer profile does
   not change.

5. `docs/contributing/architecture.md` — update the review boundary to state
   that callable change-review results expose the validated reviews while
   durable metadata and CLI output retain their existing summarized shape.

## Verify

- `pnpm exec vitest run test/review-steps.test.ts test/workflow-context.test.ts test/cli.test.ts`
  → complete outputs, selected steps, partial failure, exact head/artifact
  identity, empty callable dry-run payload, provider configuration, and
  unchanged CLI metadata behavior pass at the existing workflow seams.
- `make check` → the repository's canonical gate passes.

## Boundaries

- No reviewer prompt, review schema, verdict, severity, or aggregation changes.
- No Inngest, Linear, implementation-revision, checkpoint, or publication
  policy.
- No implementation-agent injection, reviewer-specific profiles, artifact
  rereads, or duplicate review API.
