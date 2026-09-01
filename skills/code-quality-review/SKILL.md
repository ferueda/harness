---
name: code-quality-review
description: >
  Review recently modified code for behavior-preserving clarity, simplicity, consistency, and
  maintainability. Trigger when the user wants a code quality, readability, maintainability, or
  simplification review of a diff or implementation.
---

# Code Quality Review

Review changed code for behavior-preserving clarity, simplicity, consistency,
and maintainability. Stay read-only.

## Audit Focus

- Preserve exact behavior, accepted scope, public contracts, structured output
  shapes, artifact paths, CLI behavior, validation boundaries, and regression
  coverage.
- Prefer project conventions and nearby code over general industry preferences.
- Flag unnecessary abstractions, speculative generality, duplicated setup,
  avoidable indirection, and deeply nested control flow introduced by the diff.
  Recommend simplification only when a materially smaller equivalent shape
  exists.
- Check naming, file organization, error handling, dependencies, tests, and
  explicit control flow against repository policy and established patterns.
- Do not perform a second general correctness review. Report a behavioral
  defect only when found while evaluating quality.
- Exclude pre-existing debt, surrounding cleanup, broad rewrites, future
  improvements, architecture changes outside the accepted task, and equally
  valid style alternatives.

### Primitive fit

When changed code adds, duplicates, extends, replaces, or moves a primitive or
its owner, apply **primitive fit** at the relevant layer. Treat a primitive as
an owned building block or contract. Verify relevant existing primitives, the
current owner and source of truth, directly affected contracts and consumers,
and dependency direction. Evaluate in order:

1. **Reuse:** an existing primitive already owns and satisfies the accepted need
   without weakening or crossing its boundary.
2. **Extend:** the behavior belongs to the same owner and lifecycle, and the
   extension keeps its contract coherent for current consumers while preserving
   source-of-truth and dependency boundaries.
3. **Add:** neither option fits; the diff introduces the smallest primitive at
   the correct boundary for a verified current need.

Complete primitive fit only when evidence supports the selected option and why
earlier options do not fit. Let present requirements and verified consumers
bound a new primitive's surface; treat future reuse as a benefit, not authority
for broader scope.

## Skills and Guidelines

Discover available host and repository skills. Read only the `SKILL.md` files
relevant to languages, frameworks, or patterns changed by the diff. Use them as
subordinate guidelines, not a new checklist.

## Process

1. Read repository guidance, the task handoff when present, relevant skills,
   and the full diff. Inspect nearby code only to verify established conventions.
2. Review only changed or directly affected code.
3. Check whether changed tests encode behavior and whether added complexity
   creates test-reliability risk.
4. Make every finding actionable and specific. Include:
   - **Severity**: `Critical` | `High` | `Medium` | `Low`
   - **Location**: file/line or function/class/module name
   - **Issue**: description of the finding
   - **Recommendation**: smallest behavior-preserving correction
   - **Rationale**: evidence that the correction is warranted
   - **must_fix**: `true` | `false`
5. Complete the full diff. Include lower-severity findings only when they
   materially affect maintainability or test confidence.
6. Mark `must_fix: true` only for a hard repository-policy violation or when
   added complexity creates a verified correctness, contract, or
   test-reliability risk that makes safe acceptance unreasonable. Keep optional
   simplifications advisory.
7. Use `pass` when no finding has `must_fix: true`, `needs_changes` when at
   least one does, and `blocked` only when coverage is unavailable.
8. Run narrow read-only checks when useful. Leave deterministic validation to
   the validation stage.

Return only material, evidence-backed findings. A clean review is valid.
