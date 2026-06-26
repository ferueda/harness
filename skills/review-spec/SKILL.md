---
name: review-spec
description: Review a spec document against codebase reality, identifying gaps and ensuring sound, robust implementations.
---

Review the given spec document by analyzing both the spec AND the referenced codebase.

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
- **Reliability**: Error handling, retries, idempotency, graceful degradation
- **Performance**: Bottlenecks, caching, query patterns, scaling approach
- **Security**: Auth, data protection, input validation, audit logging
- **Edge Cases**: Null handling, limits, timeouts, race conditions, partial failures
- **Testing**: Testability, integration strategy, rollback considerations

## Output Format

For each finding:

```
### [Finding Title]

**Category**: Architecture | Feasibility | Simplicity | Reliability | Performance | Security | Edge Case | Testing
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
