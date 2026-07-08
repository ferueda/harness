---
name: architect
description: Repo-grounded ideation, research, and technical solution design before planning or implementation.
disable-model-invocation: true
---

# Architect

Design the solution before planning or building. Product: an inline architecture memo the user can keep, discard, or ask to turn into a plan.

## Rules

- Stay read-only. Do not edit files, write artifacts, stage, commit, or create plan files.
- Ground claims in current repo reality: guidance, docs, code, tests, callers, contracts, and existing patterns.
- Ask the user when ambiguity materially changes architecture. Include a recommended answer, alternatives, and tradeoffs.
- Proactively ask Cursor for advice, second opinions, and critique on non-trivial designs. When available, use the `cursor-cli` skill; read that skill before invoking it.
- Triage advisor input as **Adopt**, **Adapt**, or **Decline**. Do not dump raw advisor output.
- Stop before implementation planning: no phases, file-edit checklist, command gates, executor skills table, or task breakdown.
- If the user gives a bug, symptom, or "what is true?" question, route to `diagnose-issue` first. If product intent is too vague to choose among designs, use `shape-requirements` gate.

## Workflow

### 1. Frame

Extract:

- goal or problem
- suspected solution, if any
- scope and non-goals
- constraints
- success criteria
- unknowns that may change the architecture

If an unknown blocks responsible design, ask the user before deep work. Give the recommended choice and alternatives.

**Done when:** the design target and blocking unknowns are explicit.

### 2. Ground

Read enough repo context to understand what the design must fit:

- `AGENTS.md`, `README.md`, intent docs, ADRs, or relevant contributor docs
- relevant code paths, tests, callers, exports, schemas, config, and lifecycle boundaries
- prior plans or docs only when they explain current intent
- official external docs when third-party behavior, standards, or provider contracts matter

Do not stop at the first plausible file. Follow the flow until each design option can cite current-state anchors.

**Done when:** the memo can cite repo evidence with `file:line` anchors and label remaining assumptions.

### 3. Explore

Generate two to four viable designs:

- smallest credible design
- repo-native design that follows existing patterns
- bolder architecture when justified by real constraints
- defer or no-change option when credible

For each option, capture fit, tradeoffs, risks, compatibility, testability, and what would make it the wrong choice.

**Done when:** options are meaningfully different and each has a defensible acceptance or rejection case.

### 4. Consult

Call Cursor when the design is non-trivial, cross-module, public API/data-contract affecting, migration-heavy, security-sensitive, or still uncertain after repo grounding.

Use focused prompts:

- ask for missed risks
- ask for simpler alternatives
- ask for pattern fit against specific files
- ask for critique of a draft recommendation

Call again only when the next prompt has a distinct uncertainty. If Cursor is unavailable, say so briefly and continue with the best grounded judgment.

**Done when:** advisor feedback is triaged as Adopt, Adapt, or Decline with short rationale.

### 5. Decide

Recommend one architecture when evidence supports it. If product, priority, or risk tolerance decides between live options, ask the user and present:

- recommended choice
- alternatives
- tradeoffs
- what changes downstream planning

Separate locked decisions from open questions.

**Done when:** the user can either approve the design, answer a focused question, or ask for a plan.

### 6. Report

Return an inline memo. Keep it proportional: enough detail to support a later plan, not enough to become one.

```markdown
## Architecture Memo

**Goal**:
**Recommendation**:
**Confidence**: High | Medium | Low

## Current-State Anchors

- `<file:line>`: <fact this proves>

## Constraints

- <constraint>

## Options

### 1. <name>

<design, fit, tradeoffs, risks, compatibility, testability>

### 2. <name>

<design, fit, tradeoffs, risks, compatibility, testability>

## Advisor Synthesis

- Adopt: <advisor note and rationale>
- Adapt: <advisor note and rationale>
- Decline: <advisor note and rationale>

## Decision

<recommended architecture and why>

## Locked For Planning

- <decision>

## Open Questions

- <question with recommended answer and alternatives>

## Non-Goals

- <not part of this design>
```

**Done when:** inline architecture memo delivered, no files written, and next step named only at workflow level.
