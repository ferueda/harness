---
name: review-spec
description: Review a spec document against codebase reality, identifying gaps and ensuring sound, robust implementations.
---

Review the given spec document by analyzing both the spec AND the referenced codebase.

## Executable Path

For implementation plans where durable artifacts, provider selection, events, or
reruns matter, prefer:

```bash
harness run plan-review --plan <path>
```

Use this direct `review-spec` skill when harness is unavailable or a lightweight
chat review is enough.

## Process

1. **Read the spec** — goals, phases, proposed changes
2. **Explore the codebase** — files and code the spec references
3. **Analyze patterns** — existing conventions and architecture
4. **Trace scope** — every proposed change serves an acceptance criterion, hard invariant, or verified regression risk
5. **Validate the plan** — proposals align with codebase reality
6. **Check proportionality** — scope, phases, and abstractions match the problem size
7. **Identify issues** — gaps, risks, and simplification opportunities

**Done when:** every proposed change and major design choice has been checked against intent, code, and proportionality.

## Plan Contract

Review plans as decision records for capable, context-limited executors with
repository access. `Goal`, `Changes`, `Verify`, and optional `Boundaries` are the
default shape, but equivalent headings are valid. Require added detail only when
it changes an executor decision or proves a distinct criterion, invariant, or
verified risk. Do not request metadata, copied source, skills tables, separate
test plans, done checklists, or maintenance notes for template completeness.

## Review Dimensions

Evaluate across these areas (focus on what's relevant):

- **Architecture**: Component boundaries, data flow, API contracts, separation of concerns
- **Feasibility**: Implementation complexity, technology trade-offs, effort estimation
- **Simplicity**: Overengineering, unnecessary phases, speculative abstractions, and smaller equivalent shapes. Trace every change and test to acceptance, an invariant, or a verified risk. Unsupported work is a scope defect. Flag one-call-site abstractions, single-use registries or workflows, mergeable phases, oversized patterns, and nice-to-haves without a named constraint.
- **Project Alignment**: Fit with documented intent, audience, non-goals, invariants, source-of-truth boundaries, and current-vs-planned behavior. Check `docs/project-intent.md`, root `VISION.md`, and intent docs linked from repo guidance. The gate below handles missing sources.
- **Reliability**: Error handling, retries, idempotency, graceful degradation
- **Performance**: Bottlenecks, caching, query patterns, scaling approach
- **Security**: Auth, data protection, input validation, audit logging
- **Edge Cases**: Null handling, limits, timeouts, race conditions, partial failures
- **Testing**: Prefer the highest existing stable seam proving acceptance. Require a lower seam only for a distinct invariant or failure mode unobservable there.

### Intent Source Gate

- Use a High `must_fix` finding when a plan makes product, architecture, boundary, public API, data/tenancy, provider, docs-architecture, or workflow-wide decisions without an intent source or confirmed substitute.
- Use a Medium finding when a known intent source exists but the plan does not inline the relevant constraints for the executor.
- Use a Low advisory finding when narrow work can proceed but the repo would benefit from adding an intent source later.
- For risky work without a source, require confirmed intent or a first step to create a minimal intent source.
- Narrow bug fixes and local refactors may proceed without an intent source when the plan notes that none was found and the work does not make project-level direction or boundary decisions.

## Output Format

`harness run plan-review` writes structured JSON matching
`schemas/review-output.schema.json`: `verdict`, `summary`, and `findings[]`
with `must_fix`. The markdown format below applies only to direct chat
`review-spec` use.

For structured review output:

- `pass` requires no `must_fix: true` findings; advisory findings are allowed.
- `needs_changes` requires at least one `must_fix: true` finding.
- `blocked` means evidence or a human decision is unavailable and is exempt from the `must_fix` relationship.

For each finding:

```
### [Finding Title]

**Category**: Architecture | Feasibility | Simplicity | Project Alignment | Reliability | Performance | Security | Edge Case | Testing
**Severity**: Critical | High | Medium | Low
**Section**: [Spec section or phase]

**Issue**: [Clear problem description]
**Recommendation**: [Specific, actionable change]
**Rationale**: [Technical justification]
```

## Guidelines

- **Verify against code** — Don't trust the spec blindly; check actual implementations
- **Follow existing patterns** — Recommendations should align with codebase conventions
- **Be specific** — Reference exact files, functions, and line numbers
- **Prioritize** — Order findings by severity and impact
- **Challenge assumptions** — Question decisions that lack justification
- **Prefer smaller plans** — When two approaches work, recommend the one with fewer moving parts unless constraints require more
- **Do not invent work** — Optional hardening, extra tests, docs, abstractions, and future-proofing need a named requirement, invariant, or demonstrated regression risk
- **Review decisions, not ceremony** — Do not request a section, table, excerpt, checklist, or command unless its absence makes execution unsafe or ambiguous
- **Keep advice advisory** — `must_fix: false` findings may record observations but should not ask for plan edits
