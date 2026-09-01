---
name: review-spec
description: Review a spec document against codebase reality, identifying gaps and ensuring sound, robust implementations.
---

Review the given spec and referenced codebase. Keep the review read-only.

## Executable Path

For implementation plans where durable artifacts, provider selection, events, or
reruns matter, prefer:

```bash
harness run plan-review --plan <path>
```

Use this direct skill when Harness is unavailable or a lightweight chat review
is enough.

## Authority

Apply this order:

1. Repository hard invariants and documented project intent.
2. The original source request and accepted task decisions: the goal,
   requirements, acceptance criteria, explicit boundaries, and decisions marked
   accepted, current, locked, or superseding. Apply the same authority to
   equivalent content within an artifact or handoff section clearly labeled as
   task or work-item authority.
3. Verified facts from the current repository and directly affected contracts.
4. Reviewer preferences and improvement opportunities.

Within an authority section, treat unmarked proposals, comments, and metadata as
context. Other handoff content and summaries are also context, never authority.

## Process

1. Read the plan, authority sources, and repository guidance.
2. Inspect the named files, symbols, contracts, and matching executor skills.
3. Trace each proposed change and test to acceptance, a hard invariant, or a
   verified risk.
4. Check every material design choice against current code and proportionality.
5. Return only material, evidence-backed findings.

**Done when:** every proposed change and major design choice has been checked
against authority, code, and proportionality.

## Plan Contract

Plans are decision records for capable, context-limited executors with repository
access. `Goal`, `Changes`, `Verify`, and optional `Boundaries` are the default
shape; equivalent headings are valid. Review content, not template completeness.
Request detail only when it changes an executor decision or proves an acceptance
criterion, hard invariant, or verified regression risk.

Trace every proposed change and test to acceptance, a hard invariant, or a
verified risk. Unsupported work already proposed by the plan is a scope defect.
Challenge unsupported assumptions, follow compatible existing patterns, and
prefer the smaller equivalent plan.

Check these decisions only when the proposed change makes them material:

- When it replaces, redirects, splits, deprecates, or removes behavior, require
  the post-change owner, exact removals and cutover order, and required
  compatibility.
- When it changes failure handling, state or data flow, privacy, or security,
  require the intended behavior beside the affected change.

### Primitive Fit

When a plan adds, duplicates, extends, replaces, or moves a primitive or its
owner, apply **primitive fit** at the relevant layer. Treat a primitive as an
owned building block or contract at the relevant product, workflow, or system
layer. Verify the current owner, source of truth, directly affected contracts
and consumers, lifecycle, dependency direction, and relevant existing
primitives. Evaluate in order:

1. **Reuse:** an existing primitive already owns and satisfies the accepted need
   without weakening or crossing its boundary.
2. **Extend:** the behavior belongs to the same owner and lifecycle, and the
   extension keeps its contract coherent for current consumers while preserving
   source-of-truth and dependency boundaries.
3. **Add:** neither option fits; the plan introduces the smallest primitive at
   the correct boundary for a verified current need.

Complete primitive fit when repository evidence supports the selected option
and why earlier options do not fit. Require the plan to record that decision
only when it changes an executor choice or locks a contract or boundary. Let
accepted requirements and verified consumers bound a new primitive's surface;
treat future reuse as a benefit, not authority for broader scope.

### Delivery Shape

- For multi-unit work, prefer vertical slices where each unit completes one
  coherent, observable behavior across the boundaries it needs and can be
  verified when it lands. Prefer units that separate agents can own with limited
  overlap, that can proceed in parallel after the minimum shared setup, and that
  can be reviewed, landed, or rolled back independently.
- Challenge needlessly horizontal phases such as completing all persistence,
  then all services, then all interfaces when useful behavior could land end to
  end. Keep shared setup to the minimum required by the first slice and expand
  it only when a later slice proves the need.
- Accept a horizontal step when the plan gives a short, evidence-backed reason
  vertical delivery is impractical or unsafe, such as an indivisible migration,
  a cross-cutting safety fix, or the smallest shared prerequisite.
- Treat delivery shape as judgment, not a ban. Request restructuring only when
  the horizontal breakdown needlessly delays observable proof, prevents focused
  review, or creates avoidable dependency or collision risk.

## Review Dimensions

Evaluate only relevant dimensions:

- **Architecture**: boundaries, data flow, API contracts, separation of concerns.
- **Feasibility**: complexity, technology trade-offs, effort, migration risk.
- **Simplicity**: overengineering, unnecessary phases, speculative abstractions,
  one-call-site abstractions, single-use workflows or registries, mergeable
  phases, and nice-to-haves without a named constraint.
- **Project Alignment**: documented audience, non-goals, invariants,
  source-of-truth boundaries, and current-versus-planned behavior.
- **Reliability**: error handling, retries, idempotency, degradation, partial
  failures.
- **Performance**: bottlenecks, caching, query patterns, scaling impact.
- **Security**: auth, data protection, validation, permissions, audit logging.
- **Edge Cases**: missing values or files, limits, timeouts, races, environment
  drift.
- **Testing**: prefer the highest existing stable seam proving acceptance;
  require the cheapest credible acceptance-level proof and add another seam only
  for a distinct boundary or failure mode.

### Outcome Proof

- Connect each material outcome or forbidden effect to an exact proof action and
  expected observable evidence. The canonical repository gate proves general
  health; it does not replace behavioral proof.
- Require material proof limits to be explicit. A mock, fake, intercepted
  request, or source-only check does not prove behavior beyond its seam.
- For asynchronous work, require the terminal state or downstream effect.
  Acceptance or enqueueing alone is insufficient.
- For live proof, require explicit authority, prerequisites, disposable data,
  assertions, stop conditions, redaction, cleanup, and remaining uncertainty.
- Accept focused proof plus the repository gate when it proves the outcome. Do
  not demand repeated layers without a distinct failure mode.
- Require unavailable material proof to be reported with its concrete blocker,
  and require handoff evidence to name observed results and skipped checks.

### Intent Source Gate

- When a known intent source or confirmed substitute exists, require the plan to
  preserve its material constraints.
- When product, architecture, boundary, public API, data or tenancy, provider,
  docs-architecture, or workflow-wide intent is unavailable, return `blocked`
  with the smallest exact human question needed to continue.
- Narrow bug fixes and local refactors may proceed without an intent source when
  the plan notes that none was found and makes no project-level direction or
  boundary decision.

## Finding Contract

A finding may be must-fix only for:

- an accepted goal, criterion, decision, or boundary the plan omits or
  contradicts;
- work in the plan that cannot be traced to acceptance, an invariant, or a
  verified risk and would materially expand execution scope;
- a repository hard invariant the plan would violate;
- a verified correctness, security, reliability, or compatibility risk the plan
  would introduce; or
- a material executor decision or behavioral proof required to implement the
  accepted change safely.

Reviewer-proposed optional hardening, alternative architectures, preferences,
nearby cleanup, and unrelated future work are outside this review and cannot
block. Advisory findings may record material observations but must not require
plan edits.

Use `pass` when there is no must-fix finding, `needs_changes` when a plan edit can
resolve at least one must-fix finding, and `blocked` when required evidence or
human intent is unavailable. For `blocked`, state the smallest exact missing
evidence or human question; do not turn the uncertainty into a plan-edit request.

## Output Format

`harness run plan-review` writes structured JSON matching
`schemas/review-output.schema.json`: `verdict`, `summary`, and `findings[]` with
`title`, `severity`, `location`, `issue`, `recommendation`, `rationale`, and
`must_fix`. Return no extra fields.

For direct chat use, return each Markdown finding as:

```markdown
### [Finding Title]

**Severity**: Critical | High | Medium | Low
**Location**: [Plan section, file, or path:line]
**Must fix**: Yes | No

**Issue**: [Clear problem description]
**Recommendation**: [Specific, actionable change]
**Rationale**: [Technical justification]
```

End with `**Verdict**: Pass | Needs changes | Blocked`. For `Blocked`, include
the smallest exact missing evidence or human question.
