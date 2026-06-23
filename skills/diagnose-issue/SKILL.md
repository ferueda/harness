---
name: diagnose-issue
description: Research and define codebase issues before implementation planning. Use when the user provides an issue statement, bug report, Jira ticket, vague problem, proposed solution, runtime symptom, or design concern and wants Codex to inspect the current codebase, validate whether the problem exists, diagnose likely causes, compare solution directions, and produce an evidence-backed problem definition. Do not use when the user asks for a step-by-step implementation plan, direct implementation, or code review of an existing diff.
---

# Diagnose Issue

Use this skill to turn incomplete issue input into an evidence-backed problem definition and solution direction. The product is understanding, not an implementation plan.

## Operating Rules

- Stay read-only unless the user explicitly asks for edits.
- Verify against the current checkout. Do not trust issue text, Jira fields, stale docs, or a proposed solution without code evidence.
- Separate facts, inferences, and assumptions.
- Prefer high-confidence findings. If evidence is weak, say what is missing.
- Keep solution discussion at the design-direction level. Do not write a step-by-step implementation plan.
- If the reported problem does not exist, say so and cite the evidence.
- If the issue is too vague to investigate, ask the minimum clarifying question needed to start.

## Workflow

### 1. Frame The Intake

Extract the actionable claim from the user's input:

- Symptom or concern: what is wrong or risky?
- Affected behavior: who or what observes it?
- Scope hints: files, modules, commands, Jira links, logs, errors, environments.
- Proposed solution, if any: treat it as a hypothesis, not a decision.

State the initial investigation target in one or two sentences before deep work.

### 2. Build A Code Map

Read enough surrounding code to understand the relevant path:

- Search for exact error strings, feature names, API routes, CLI commands, config keys, or domain terms.
- Read exports, immediate callers, shared utilities, tests, and lifecycle boundaries around the suspected area.
- Check docs or ADRs when they explain intended behavior.
- Use runtime commands only when they are cheap, local, and useful for diagnosis.

Do not stop at the first matching file. Follow the call/data flow until the behavior is explainable.

### 3. Validate The Problem

Decide which validation state applies:

- **Confirmed**: current code can produce the reported behavior or risk.
- **Likely**: evidence supports the issue, but one missing fact prevents confirmation.
- **Not Found**: searched plausible paths and found no current evidence.
- **Invalidated**: current code contradicts the issue statement.
- **Ambiguous**: input is too broad or missing a required fact.

For confirmed or likely issues, identify the mechanism in positive terms:

- Prefer: "User input reaches processing without normalization."
- Avoid: "Missing normalization layer."

The cause should describe observable current behavior, not smuggle in one solution.

### 4. Explore Solution Directions

Generate two to four viable solution directions only after diagnosis. Include the smallest credible fix and at least one alternative when the tradeoff is real.

For each direction, capture:

- What it changes conceptually.
- Why it addresses the diagnosed mechanism.
- Main tradeoffs, risks, and compatibility concerns.
- Fit with existing code patterns.
- Tests or checks that would prove the direction works.

Choose a recommended direction when evidence supports one. If not, explain what additional evidence would decide.

### 5. Produce The Definition

Use this format unless the user asked for something narrower:

```markdown
## Problem Definition

**Status**: Confirmed | Likely | Not Found | Invalidated | Ambiguous
**Issue**: <one-sentence problem statement>
**Impact**: <user/system/developer impact>
**Mechanism**: <current behavior causing the issue>

## Evidence

- `<file:line>`: <what this proves>
- `<file:line>`: <what this proves>

## Relevant Flow

<brief call/data/config flow from input to impact>

## Solution Directions

### 1. <direction name>

<conceptual fix, why it works, tradeoffs, verification>

### 2. <direction name>

<conceptual fix, why it works, tradeoffs, verification>

## Recommendation

<recommended direction and why, or what evidence is still needed>

## Non-Goals

- <implementation details deliberately deferred>
- <out-of-scope adjacent concerns>

## Open Questions

- <only questions that materially affect diagnosis or direction>
```

## Quality Bar

Before finalizing, check:

- The diagnosis cites current code, tests, docs, logs, or command output.
- The mechanism explains the reported symptom without assuming the solution.
- At least one alternative explanation or solution direction was considered.
- The recommendation follows from evidence, not preference.
- The output can feed a later planning skill without already being a plan.
