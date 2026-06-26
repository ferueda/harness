# Brief template

Interview output. Omit inapplicable sections; add for artifact type (e.g. ADR → **Alternatives considered**).

Default path: `dev/briefs/YYMMDD-short-slug.md`

```markdown
# Brief: <Title>

> **Audience:** <who reads this>
> **Status:** draft | ready for plan | ready to build
> **Date:** YYYY-MM-DD

## Summary

2–4 sentences: what, why, what changes if it lands.

## Problem / opportunity

Pain today, who feels it, cost of inaction.

## Goals

- …

## Non-goals

- …

## Requirements

### Must have

- …

### Nice to have

- …

## Constraints

Specific: versions, SLAs, policy, time.

## Acceptance criteria

Testable or observable done conditions.

## Approach (if known)

Thin OK — flag gaps in Open Questions.

## Risks and tradeoffs

## Open questions

- …

## Suggested next step

- [ ] `create-plan`
- [ ] `review-spec`
- [ ] Implement directly
- [ ] Other: …
```

## Confirmed interpretation (gate mode)

Gate usually ends in chat. For a durable record:

```markdown
## Confirmed interpretation

**Objective:** …
**Done when:** …
**Scope:** in … / out …
**Constraints:** …
**Assumptions:** …
```
