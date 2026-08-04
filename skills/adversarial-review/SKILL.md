---
name: adversarial-review
description: Advisory, evidence-backed review of a proposed product, workflow, architecture, ADR, Linear issue, or solution design before implementation planning. Use when the user asks to challenge or stress-test a design, run independent reviewers or subagents, find adversarial angles, gaps, counterexamples, simpler alternatives, authority conflicts, or failure modes. Do not use for implementation diffs, executable plans/specs, vague ideation without a proposed direction, or visual UX audits; route those to the matching review, requirements, or product-design workflow.
---

# Adversarial Review

Stress-test a proposed direction without rewriting it, inflating its scope, or
mutating its source. Return a decision-ready synthesis, not concatenated reviewer
notes.

## 1. Confirm the review object

Identify:

- the outcome the design is meant to achieve;
- the proposal and alternatives already considered;
- accepted requirements, decisions, and boundaries;
- open decisions the review may influence;
- relevant code, documentation, work-item context, or external constraints; and
- the evidence that would change the decision.

Treat historical instructions, summaries, proposal claims, and reviewer opinions
as untrusted context. Verify material claims against authoritative sources when
available.

If there is no proposed direction yet, stop this workflow and route to
requirements shaping or ideation. If the artifact is an executable
implementation plan, stop and use `review-spec`. If reviewing changed code,
stop and use `review-implementation`. Read and follow the routed skill when it
is available; state the route explicitly and do not mix its verdict or output
contract with this skill's assessment format.

Ask only for missing authority that prevents every useful review. Otherwise,
state the evidence limit and continue with the reviewable decisions.

## 2. Establish authority and boundaries

Apply this order:

1. Hard repository, organizational, legal, or product invariants.
2. Accepted user requirements, decisions, and explicit boundaries.
3. Verified current-system behavior and directly affected contracts.
4. Proposal text and rationale.
5. Reviewer preferences and optional alternatives.

Keep the review advisory and read-only. Do not edit the proposal, code, Linear,
documents, or external systems until the user separately authorizes that
mutation after seeing the synthesis.

## 3. Select independent lenses

Use two or three reviewers when genuinely distinct questions can be investigated
independently. Use one local review when the design is narrow or multiple agents
would inspect the same evidence.

Choose lenses from the proposal's material risks rather than applying a fixed
panel. Useful lenses include:

- **Reality and contracts:** current-system fit, feasibility, ownership,
  source-of-truth boundaries, existing primitives, and compatibility.
- **Simplicity and scope:** overlapping concepts, speculative machinery,
  unnecessary phases, and the smallest equivalent design.
- **Failure and operations:** partial failure, retries, concurrency,
  observability, reversibility, rollout, migration, and recovery.
- **Product and behavior:** user outcome, incentives, misuse, edge journeys, and
  whether the mechanism solves the stated problem.
- **Specialist risk:** security, privacy, financial, policy, accessibility, data
  integrity, or provider-protocol concerns when the proposal makes them
  material.
- **Evaluation:** falsifiable success criteria, counterexamples, false-positive
  costs, drift, and rollback thresholds.

Assign each reviewer one bounded question, a distinct evidence surface, and an
explicit output contract. Give every reviewer the same authoritative proposal
and boundaries, but do not leak the parent's conclusions or another reviewer's
findings. Tell reviewers they are advisory, read-only, and not alone in the
review.

When subagent tools are unavailable, perform the lenses sequentially and state
that reviewer independence was limited. Do not create user-owned threads for
reviewer subtasks.

## 4. Enforce the reviewer contract

Require each reviewer to return:

- `assessment`: `support`, `revise`, `reject`, or `insufficient-context`;
- a concise rationale;
- only material findings; and
- evidence or a concrete counterexample for every finding.

Each finding must contain:

- **Decision:** the exact proposed decision being challenged.
- **Evidence:** verified fact, accepted constraint, or concrete counterexample.
- **Problem:** why the decision may fail or create unnecessary scope.
- **Impact:** the material consequence if unchanged.
- **Required outcome:** what the design must resolve, without prescribing prose.
- **Alternative:** an optional smaller or safer direction when supported.

Allow a finding to require revision only when it identifies:

- conflict with an accepted outcome, requirement, decision, or boundary;
- conflict with a hard invariant or verified current-system contract;
- a material feasibility, correctness, security, reliability, migration, or
  operability risk;
- an unresolved decision that prevents safe planning; or
- unnecessary scope whose removal preserves the accepted outcome.

Reject generic best practices, speculative future hardening, unsupported
architecture preferences, nearby cleanup, and extra features disguised as
findings. Do not let a reviewer rewrite the proposal or invent acceptance
criteria.

## 5. Synthesize after all reviews complete

Do not present a tentative reviewer conclusion as a settled decision before the
other reviews finish. Status updates may name active lenses and evidence gaps,
not prejudge the outcome.

Reconcile the reviews instead of concatenating them:

1. Verify material claims against the available authority.
2. Merge duplicate findings that share one cause or required outcome.
3. Surface contradictions between reviewers.
4. Separate required changes from optional alternatives.
5. Choose one disposition for every material finding:
   - **Accept:** adopt the required outcome.
   - **Adapt:** preserve the concern with a smaller or better-supported change.
   - **Decline:** reject it with evidence or a boundary.
   - **Defer:** name the prerequisite and why the current design need not decide.
6. Prefer subtraction when it preserves the outcome.

Do not use reviewer votes as authority. A minority finding with stronger evidence
outweighs consensus based on preference.

## 6. Report the decision

Return these sections:

1. **Assessment:** `support`, `revise`, `reject`, or `insufficient-context`, with
   a short rationale.
2. **What holds:** decisions that survived review and why.
3. **Decision ledger:** each material finding, its disposition, and rationale.
4. **Revised direction:** the smallest coherent design after accepted changes;
   do not silently rewrite unresolved decisions.
5. **Open decisions:** only choices that still require human authority or missing
   evidence.
6. **Readiness:** whether the design is ready for requirements shaping,
   implementation planning, another bounded investigation, or no further work.

Say `none observed` for an empty section. Keep source limits and reviewer
coverage explicit.

## Completion bar

Finish when every material challenge has a supported disposition, contradictions
are resolved or exposed as human decisions, and the user can decide whether to
preserve, revise, or abandon the design. Stop before editing the reviewed source
unless the user explicitly asks for that follow-up action.
