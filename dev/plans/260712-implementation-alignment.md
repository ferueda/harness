# Align implementation with accepted task authority

## Goal

Keep intent intact from planning through implementation and change review. Plans
should name behavior ownership, removals, cutover order, and compatibility only
when a change actually replaces or retires an existing path. Normal and Factory
implementers should reconcile those accepted decisions with repository
invariants and current code before editing; implementation review and triage
should then verify the resulting diff without letting handoffs or reviewer
preferences redefine the task. Implementation completes only after relevant
non-destructive validation, or an exact account of checks that could not run.

Preserve the recent minimum-sufficient plan and prompt shape. This is one
process-quality PR: concise instruction changes plus focused contract tests, not
new orchestration.

## Changes

1. `skills/create-plan/references/plan-template.md:Default shape`,
   `skills/audit/references/plan-template.md`, and
   `lib/prompts/factory-planning.ts:PLANNING_RULES` — align the planning
   contracts around the same minimum-sufficient semantics. When work replaces,
   redirects, splits, deprecates, or removes an existing behavior, name its
   post-change owner, exact removals/cutover order, and required compatibility.
   When work materially changes failure handling, state/data flow, privacy, or
   security, state the required behavior beside the affected change. Keep both
   rules conditional; do not add a required section or restore removed planning
   ceremony. Bring the Factory prompt to the same draft-ready bar: verified
   commands/contracts, exact ownership, traceable changes/tests, no unresolved
   material choice, compact pruning, and no secrets. Preserve Factory-only
   scratch-draft and structured-response mechanics and audit-specific finding
   language. Extend the create-plan and audit template seams in
   `test/skills.test.ts` and the rendered Factory contract in
   `test/factory-planning-prompt.test.ts`.
2. `skills/planning-workflow/SKILL.md:4. Implement` — add a compact execution
   alignment before edits: repository guidance constrains the work, the
   original request or approved plan defines the intended outcome, and verified
   current code is the implementation baseline. Treat historical branches and
   superseded implementations as context only. Carry forward any named
   ownership/removal/cutover/compatibility decisions; return to planning or the
   user when a material conflict invalidates the approach. Before review or
   handoff, reconcile the resulting diff with those same decisions. Replace the
   process-based completion line with a checkable bar: accepted outcome
   implemented, relevant non-destructive validation completed or exact
   unavailable checks reported, and no unresolved material conflict or scope
   expansion. Make both checks in-session, not a new artifact, checklist, or
   plan rewrite. Cover the skill contract in `test/skills.test.ts`.
3. `skills/handoff-work/SKILL.md:Handoff Focus` — make handoffs explicitly
   subordinate to repository guidance and the original task/accepted plan.
   Point to inspectable sources and repeat only session-only or otherwise
   load-bearing constraints and decisions; do not duplicate the plan, diff, or
   an exhaustive inspectable file inventory, and do not create a second source
   of authority. Keep only status, authority/goal, current state, and
   verification as the stable core. Material adaptations, important files,
   next steps, and open items are conditional. Preserve the compact
   change-review handoff shape already enforced by `test/skills.test.ts`; add
   focused assertions there for the handoff-work authority, source, and
   non-duplication contract.
4. `lib/prompts/factory-implementation.ts:renderFactoryImplementationPrompt`
   — mirror the normal execution alignment with a compact, mode-aware authority
   rule: repository invariants and project intent first; then the approved plan
   for planned mode or resolved source request for direct mode; then verified
   repository facts. Require the implementer to check named ownership,
   removals, cutover, and compatibility before editing and report an unresolved
   material conflict rather than improvise. Add one mode-independent completion
   contract: accepted outcome complete, relevant non-destructive validation run
   or unavailable checks reported, and final diff reconciled with accepted
   decisions. Keep existing station ownership boundaries and generated
   review-handoff shape intact. Add planned- and direct-mode assertions to
   `test/factory-implementation-prompt.test.ts` using
   `renderFactoryImplementationPrompt`.
5. `lib/prompts/implementation-review.ts:IMPLEMENTATION_REVIEW_PROMPT` and
   `skills/review-implementation/SKILL.md:Review Focus` — give the manually
   invoked reviewer the executable prompt's authority order and acceptance-only
   blocker contract. Pre-existing debt, optional hardening, alternative
   architecture, nearby cleanup, and out-of-scope refactors remain advisory;
   material scope expansion or a new product decision yields an exact blocked
   question. When the authoritative task or plan names a post-change owner,
   removal, cutover, or compatibility commitment, verify it against the diff
   and directly affected paths. Keep the check conditional so the reviewer
   neither invents migration work nor turns a handoff into authority. Extend
   `test/review-prompts.test.ts:implementation review prompt keeps blockers tied
   to the original task` and the corresponding skill assertion in
   `test/skills.test.ts`.
6. `skills/change-review-workflow/SKILL.md:Triage` and the synchronized
   `.agents/skills/change-review-workflow/SKILL.md` copy — reconcile conflicts
   among findings, the task/plan, handoff context, and diff using the existing
   authority and scope rules. Require an evidence-backed disposition for each
   underlying issue; forbid blanket Implement/Adapt/Decline decisions for an
   entire reviewer, run, or finding set. Retain duplicate grouping and reviewer
   provenance. Extend the existing convergence assertions in
   `test/skills.test.ts`; its packaged/local sync test continues to protect both
   copies.
7. `lib/prompts/spec-review.ts:SPEC_REVIEW_PROMPT` and
   `skills/review-spec/SKILL.md` — align executable and direct plan review with
   the same authority order and acceptance-only blocker contract. Treat only
   the original source request plus explicit goals, requirements, criteria,
   boundaries, and marked accepted decisions inside labeled task/work-item
   authority as authoritative; other handoff content stays context. Check
   ownership/cutover and changed failure/state/data/privacy/security behavior
   only when material. Return
   `blocked` with the smallest exact missing evidence or human question instead
   of converting unavailable intent into a plan-edit request. Keep structured
   JSON schema-exact and direct Markdown findings explicit about must-fix status.
   Extend `test/review-prompts.test.ts` and `test/workflow-context.test.ts`
   without changing schemas or review runtime.

## Verify

- `pnpm test -- test/skills.test.ts test/review-prompts.test.ts test/factory-planning-prompt.test.ts test/factory-implementation-prompt.test.ts`
- `pnpm check`

## Boundaries

- No new skill, workflow, schema, reviewer, artifact, state transition, or
  runtime orchestration.
- Do not change `AGENTS.md`, `lib/prompts/quality-review.ts`, or
  `skills/code-quality-review/SKILL.md`.
- Do not make ownership/cutover sections mandatory, expand handoffs into work
  logs, or undo the recent plan/prompt simplification.
