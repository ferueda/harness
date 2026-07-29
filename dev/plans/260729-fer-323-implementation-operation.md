# Add the provider-neutral implementation operation

## Goal

Deliver FER-323 as one standalone `lib/implementation` operation that applies
exactly one trusted source in an already-prepared writable workspace. The
operation must follow project intent by owning prompt policy, structured result
validation, plan integrity, provenance, and the author session while leaving
Linear, Inngest, repository inspection/checkpoints, review, and publication to
their existing owners.

The operation accepts either the canonical merged `dev/plans/<ISSUE>.md` or a
complete normalized work item, never both as agent authority. It returns an
`implemented` or `needs-input` decision with structured proof, or a typed
failure. A successful implementation requires a resumable author session.

## Changes

1. `lib/work-item/schema.ts:createWorkItemContextSchemas` and
   `lib/linear-automation/work-item.ts:toLinearWorkItemContext` — export the
   existing source-neutral work-item context/reference types and make the
   Linear mapper return that shared shape. Preserve all existing normalized
   fields and filtering; do not add a work-item framework or Linear knowledge
   to the shared module.

2. `lib/implementation/source.ts` and focused tests — implement the locked
   public branches exactly:
   `plan { issueReference, path: dev/plans/${string}.md }` and
   `linear { workItem: WorkItemContext }`. Expose a resolver that receives the
   complete normalized work item, promotes it to the canonical
   `dev/plans/<ISSUE>.md` plan source when that regular file exists, and returns
   the Linear source otherwise. Parse the shared work-item shape and reject a
   Linear source before prompting when any completeness flag is true. An
   explicit plan source has no fallback: reject a malformed reference, missing
   or empty canonical file, noncanonical path, symlink, or workspace escape as
   typed `invalid-source`. Snapshot selected plan contents and SHA-256 so the
   operation can return typed `source-integrity` failure when the plan changes
   during the provider run, without importing Git or repository primitives.

3. `lib/implementation/schema.ts`,
   `schemas/implementation-result.schema.json`, and schema alignment tests —
   add a strict provider-visible schema discriminated by `outcome`, with
   `IMPLEMENTATION_RESULT_SCHEMA_VERSION = "1"` recorded in provenance rather
   than returned by the model. Both branches require `outcome`, nonblank
   `summary`, `proof`, `remainingUncertainty`, and `questions`.
   `implemented` requires at least one proof record with nonblank `action`,
   `passed | failed | skipped` status, and nonblank `observedResult`, requires
   no questions, and permits failed or skipped proof only when
   `remainingUncertainty` is nonempty. `needs-input` requires empty proof and
   uncertainty arrays plus at least one focused question; its summary is the
   evidence-backed blocking rationale. Keep provider-visible JSON and Zod
   structurally aligned, with these branch relationships enforced in Zod where
   JSON Schema cannot express them cleanly. Apply the Zod skill's strict-object,
   early-parse, and inferred-type guidance.

4. `lib/implementation/prompt.ts` and focused tests — render the implementation
   policy from exactly one parsed source. Require repository guidance and
   project intent, current-code reconciliation, the smallest coherent change,
   focused behavioral proof plus the canonical gate, and explicit skipped
   checks/uncertainty. Reserve `needs-input` for a material human decision.
   Forbid Linear mutation, Git commits, pushes, pull requests, and edits to a
   selected plan. Tests must prove plan prompts contain no Linear context and
   Linear prompts contain no plan content.

5. `lib/implementation/implementation.ts` and focused fake-agent tests — call
   the existing `Agent` with `workspace-write`, no interactive approval,
   workspace-guard recording, explicit execution settings, cancellation, log
   path, and the exported result schema. Validate provider output, require and
   normalize a matching nonblank author session for `implemented`, record
   versioned prompt/schema/source provenance, and verify the selected plan
   snapshot again after every provider outcome. `needs-input` may leave partial
   workspace edits for its caller to discard, performs no cleanup itself, and
   returns no resumable author session even when the provider supplied one.
   Return typed provider, timeout, cancellation, invalid-output,
   invalid-session, invalid-source, source-integrity, and workspace-guard
   failures. Treat schema-file read failures as typed provider failures rather
   than rejected promises.

6. `.oxlintrc.json` and `test/import-boundaries.test.ts` — add
   `lib/implementation/**/*.ts` to the existing domain-operation import
   restriction and prove the directory rejects Inngest, Linear SDK,
   repository, GitHub, concrete-provider, and child-process imports while
   permitting the shared Agent and work-item contracts. Extend the existing
   reverse guards for `lib/linear`, `lib/agent`, `lib/review`, and `providers`
   so those lower-level owners also cannot import `lib/implementation`, with
   focused fixtures proving both directions.

7. `docs/contributing/architecture.md` — add the new current
   `lib/implementation` owner to the source map and domain-operation boundary.
   Document only what FER-323 lands: source selection, prompt/result policy,
   plan integrity, provenance, and author-session ownership. Keep the
   still-planned Linear/Inngest consumer, review cycle, checkpoints, and
   publication explicitly outside this operation.

## Verify

- Run the focused `lib/implementation` and
  `lib/linear-automation/work-item` tests. Expected evidence: both source modes,
  authority isolation, both decisions, proof validation, session normalization,
  every typed failure boundary, and before/after plan integrity pass without
  invoking Linear, Git, Inngest, review, or publication code.
- Run the exported-schema alignment test. Expected evidence: the JSON Schema is
  Codex-strict; shared structural cases agree across JSON Schema and Zod; and
  implemented proof/question rules and needs-input cardinality are rejected by
  Zod at the operation boundary when cross-field-invalid.
- Run the focused import-boundary test. Expected evidence:
  `lib/implementation` accepts its shared contracts and statically rejects
  delivery, service, repository, publication, concrete-provider, and Git
  command dependencies.
- Run `make check`. Expected evidence: the repository's canonical gate passes.

## Boundaries

- No review/revision cycle, Linear projection, Inngest wiring, Git inspection,
  checkpoint, PR presentation, or publication.
- No generic command runner or duplicated repository abstraction.
- Do not change Triage or Spec behavior while removing the Linear mapper's
  Triage-only return type.
