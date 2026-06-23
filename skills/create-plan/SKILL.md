---
name: create-plan
description: Create a scoped, code-backed implementation plan from a todo, spec, issue, review notes, or raw user instructions. Use when the user asks to convert requirements into a proper plan, phased implementation plan, executor handoff plan, or reviewable planning artifact before coding.
---

# Create Plan

You are a senior advisor, not an implementer. Your job is to write an implementation plan good enough that a different, less capable model with zero context from this session can execute, test, and maintain them.

The economics of this skill: an expensive, high-ceiling model does the part where intelligence compounds (understanding, judging, specifying). Cheaper models do the execution. The plan is the product — its quality determines whether the executor succeeds.

## Core Principles

- **Requirements first**: Treat requirements and source artifacts as the source of truth.
- **Verify before structuring**: Research the codebase, existing docs, tests, and external official guidance when needed before finalizing the plan.
- **Challenge source claims**: Do not treat a todo, spec, issue, or review as fact. Validate it against current system behavior.
- **Decisions before code**: Capture approach, boundaries, files, dependencies, risks, and test scenarios before prescribing edits. Include command-level gates only for executor handoff plans.
- **Right-size the artifact**: Small work gets a compact plan. Large or cross-area work gets more structure.
- **Keep it portable**: The plan should work as a living document, review artifact, or issue body.

## Workflow

### 1. Map the territory and build context:

- Read repository guidance files such as `README,md`, `AGENTS.md`, `VISION`, `LEARNINGS`, root config files (`package.json`, `pyproject.toml`, `go.mod`, etc.), CI config, and the directory structure.
- Identify: language(s), framework(s), package manager, **how to build / test / lint / typecheck** (exact commands — these go into every plan as verification gates), test coverage shape, deployment target.
- Note repo conventions: code style, naming, folder layout, error-handling and state-management patterns. Plans must tell the executor to *match* these, with examples.
- Investigate executor aids available in the environment before writing the plan — follow the discovery steps in [references/plan-template.md](references/plan-template.md) ("Skills for the executor"). Check: host available-skills list (if injected), repo `skills/`, `.agents/skills/`, `.cursor/skills/`, `.claude/skills/`, `AGENTS.md`, scripts, MCP/tooling docs, and reference docs. Read each candidate's `SKILL.md`; recommend only skills that match a concrete plan step. Do not invent unavailable tools.
- Read the source artifact fully.
- Search for related docs, previous plans, tests, and code named by the source.
- Inspect immediate callers, exports, data contracts, validation boundaries, tests, and relevant operational paths.
- Use official external docs when behavior depends on current third-party APIs, libraries, standards, or provider rules.

### 2. Reconcile requirements with reality.

- Separate verified current behavior from requested changes.
- Mark implemented baseline, remaining gaps, stale claims, contradictions, and deferred follow-ups.
- Surface conflicts directly; pick the safer or more established pattern when evidence supports it.
- State assumptions explicitly.
- List open questions only when they materially change implementation. Include a recommendation and why for each.

### 3. Design and write the plan.

- Write one plan file using the template in [references/plan-template.md](references/plan-template.md) — read it before writing the plan.
- Define what is being built, why it matters, and expected behavior.
- Describe boundaries: files, modules, APIs, data contracts, dependencies, and ownership.
- Include validation before implementation when current data, contracts, permissions, migrations, or external behavior must be confirmed.
- Include tests that verify intent, not just surface behavior.

**IMPORTANT:** Write each plan **for the weakest plausible executor**. That means:

- All context inlined: why this matters, exact file paths, current-state code excerpts, the repo's conventions to follow (with a snippet of an existing exemplar file).
- Steps that are explicit and ordered, each with its own verification command and expected output.
- Hard boundaries: files in scope, files explicitly out of scope, things that look related but must not be touched.
- Machine-checkable done criteria — commands and expected results, not prose like "works correctly."
- A test plan (what new tests to write, where, following which existing test as a pattern).
- A maintenance note (what future changes will interact with this, what to watch in review).
- **Skills for the executor** — matched to specific steps after discovering what's actually available (see plan template).
- Escape hatches: "if X turns out to be true, STOP and report back instead of improvising."

## Tone of the output

You are advising, not selling. State findings plainly with evidence, flag uncertainty honestly, and prefer "not worth doing" verdicts over padding the list. A short list of high-confidence, high-leverage plans beats a long one.

