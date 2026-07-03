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
4. **Validate the plan** — proposals align with codebase reality
5. **Check proportionality** — scope, phases, and abstractions match the problem size
6. **Identify issues** — gaps, risks, and improvement opportunities

**Done when:** every phase and major design choice has been checked against code and proportionality.

## Review Dimensions

Evaluate across these areas (focus on what's relevant):

- **Architecture**: Component boundaries, data flow, API contracts, separation of concerns
- **Feasibility**: Implementation complexity, technology trade-offs, effort estimation
- **Simplicity**: Overengineering, unnecessary phases, speculative abstractions, simpler equivalent shapes. Ask: does phase count and abstraction count match the problem? Any YAGNI (registry, plugin layer, future-proof hook without a current caller)? Could existing code do this with less surface? Phases that only defer thinking without a deliverable? Flag when: one-call-site abstractions, workflow/registry for a single use case, mergeable phases, patterns oversized for this repo, nice-to-haves without a named constraint.
- **Project Alignment**: Fit with the target repo's documented intent source, audience, non-goals, hard invariants, source-of-truth boundaries, and current-vs-planned behavior. Look first for `docs/project-intent.md`, then root `VISION.md`, then explicit intent docs named from `AGENTS.md`, `README.md`, or contributor docs. If no intent source exists, narrow bug fixes and local refactors may proceed with a note; plans that make product, architecture, docs-architecture, data/tenancy, provider, public API, or workflow-wide decisions should include confirmed intent or a first step to create a minimal intent source.
- **Reliability**: Error handling, retries, idempotency, graceful degradation
- **Performance**: Bottlenecks, caching, query patterns, scaling approach
- **Security**: Auth, data protection, input validation, audit logging
- **Edge Cases**: Null handling, limits, timeouts, race conditions, partial failures
- **Testing**: Testability, integration strategy, rollback considerations

### Intent Source Gate

- Use a High `must_fix` finding when a plan makes product, architecture, boundary, public API, data/tenancy, provider, docs-architecture, or workflow-wide decisions without an intent source or confirmed substitute.
- Use a Medium finding when a known intent source exists but the plan does not inline the relevant constraints for the executor.
- Use a Low advisory finding when narrow work can proceed but the repo would benefit from adding an intent source later.
- Narrow bug fixes and local refactors may proceed without an intent source when the plan notes that none was found and the work does not make project-level direction or boundary decisions.

## Output Format

`harness run plan-review` writes structured JSON matching
`schemas/review-output.schema.json`: `verdict`, `summary`, and `findings[]`
with `must_fix`. The markdown format below applies only to direct chat
`review-spec` use.

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
