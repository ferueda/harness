---
name: architect
description: Repo-grounded ideation, research, and technical solution design before planning or implementation.
disable-model-invocation: true
---

# Architect

Design the smallest repo-grounded solution before planning or building. Return
an inline architecture memo the user can keep, discard, or turn into a plan.

## Rules

- Stay read-only. Do not edit files, write artifacts, stage, commit, or create
  plans.
- Stop before implementation planning: no phases, file-edit checklist, command
  gates, executor skills table, or task breakdown.
- Ask the user only when ambiguity materially changes the architecture. Include
  a recommended answer and the real tradeoff.
- Route bugs, symptoms, and code-truth questions to `diagnose-issue` first. Use
  the `shape-requirements` gate when unclear product intent prevents a choice.

## Workflow

### 1. Frame

Identify the goal, accepted decisions, scope, success criteria, constraints, and
unknowns that could change the design. Resolve blocking unknowns before deep
work.

**Done when:** the design target and material unknowns are explicit.

### 2. Ground

Apply this authority order:

1. Repository invariants and documented project intent.
2. Explicit user goals, scope, acceptance criteria, and accepted decisions.
3. Verified current behavior and constraints.
4. Existing patterns and unaccepted proposals.

When a current-session `diagnose-issue` result exists, use its status, mechanism,
evidence, and constraints as the starting contract. Verify only gaps that could
change the design. Treat its recommended direction as a hypothesis, not accepted
architecture.

Read `AGENTS.md`, repository guidance, and the relevant intent source before
product, boundary, public API, provider, data, or documentation-architecture
decisions. Inspect only the code paths, tests, callers, contracts, schemas,
configuration, and lifecycle boundaries needed to follow the behavior. Use
prior plans only for accepted decisions, and keep current behavior distinct
from planned work. Consult official sources when third-party behavior matters.

Before proposing new state, coordination, or abstraction, identify the current
owner and existing repository, platform, or provider primitives. Name the
verified gap they cannot satisfy; if none exists, prefer no change or use those
primitives.

Follow the flow far enough to support each decision with durable `path:line`
anchors. Label remaining assumptions.

**Done when:** repository evidence and project intent constrain the design.

### 3. Choose the smallest credible direction

- Recommend no change when it already satisfies the goal.
- Otherwise prefer the smallest repo-native change that satisfies the goal and
  invariants.
- Require a present acceptance criterion, invariant, or verified risk before
  adding an abstraction, boundary, extension point, registry, workflow, or
  compatibility layer the smaller design does not need.
- Add an alternative only when it is viable, materially different, and exposes
  a decision-relevant tradeoff. Do not manufacture an option count.
- Compare the current and proposed design only across material surfaces:
  observable behavior; APIs, CLI, configuration, schemas, events, storage, or
  protocols; ownership, lifecycle, and data boundaries; compatibility,
  adoption, operations, and risk.
- When the design affects hot paths, network or disk I/O, client payload,
  storage, concurrency, caching, capacity, or cost, assess expected performance
  and separate measurements from estimates.
- State the winning direction's accepted tradeoffs: the benefit, the downside,
  why it is acceptable, and a revisit trigger when useful.
- When the design depends on a future component or need, recommend build now,
  defer, or record only, and name what should trigger implementation.
- When behavioral proof affects the choice, prefer the highest existing stable
  test seam. Add a lower seam only for a distinct invariant or failure mode
  unobservable there.

Evaluate only the fit, tradeoffs, risks, compatibility, and test implications
that could change the recommendation or the user's approval. Explicitly answer
any surface the user asked about, even when unchanged.

**Done when:** one recommendation wins on current evidence; alternatives remain
only where the user has a real choice.

### 4. Consult when decision-changing

For non-trivial, cross-module, public-contract, migration, security-sensitive,
or still-uncertain designs, consult one read-only advisor only when its answer
could change the recommendation. Ask it to challenge the smallest proposed
design, identify a missing constraint, or test pattern fit—not to brainstorm
more architecture.

Name the task `architect-advisor`; provide grounded anchors and request an
evidence-backed response. Use another advisor only for a distinct unresolved
uncertainty.

Triage actual advice as **Adopt**, **Adapt**, or **Decline**. Omit empty
categories and omit advisor reporting when consultation did not affect the
decision. If consultation is unavailable, continue with grounded judgment.

**Done when:** decision-changing critique has been resolved.

### 5. Decide and report

Recommend one direction. If product priority or risk tolerance—not repository
evidence—decides between viable choices, ask the user with a recommended answer
and concise tradeoff.

Return a proportional memo using the smallest useful shape:

```markdown
## Architecture Memo

**Goal**:
**Recommendation**:
**Confidence**: High | Medium | Low

## Why this fits

Decision-shaping project intent, repository facts, and tradeoffs. Place each
`path:line` anchor beside the claim it supports.

## Impact and tradeoffs

Only material current-to-proposed changes to behavior, contracts,
ownership/lifecycle boundaries, compatibility/adoption,
operations/performance, and risk. State relevant unchanged surfaces the user
asked about. Name the recommended direction's benefit, accepted downside, why
it is acceptable, and a revisit trigger when useful. Omit when a no-change
result or `Why this fits` already makes the consequences clear.

## Alternatives

Only materially different viable choices. Omit when one direction is clear.

## Boundaries

Only planning-relevant locked decisions or concrete non-goals. Omit when none
exist.

## Advisor check

Only advice that affected the decision, labeled Adopt, Adapt, or Decline. Omit
when no consultation affected the recommendation.
```

Do not duplicate the recommendation as a separate decision or planning
checklist. Add another section only when it changes the architecture choice.

**Done when:** the user can approve the direction with its material consequences
and accepted tradeoffs understood, answer one focused question, or ask to turn
it into a plan.
