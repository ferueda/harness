---
name: simplify
description: Simplify and refine recently modified harness repo code for clarity, consistency, and maintainability without changing behavior. Use after implementing changes in this repository, when the user says "simplify", "clean up", "refactor for clarity", or wants a readability pass before review or merge.
---

# Simplify

Refine recently modified harness code while preserving exact behavior. Keep the pass pragmatic: reduce complexity where it clearly improves comprehension, avoid broad rewrites, and match local patterns.

## Workflow

1. Read root `AGENTS.md`.
2. Identify the current diff with `git diff` and the files changed in this session.
3. Read nearby code before changing structure.
4. Simplify only recently modified or explicitly requested files.
5. Run the narrowest useful checks, then report what changed.

## Harness Standards

- Keep this repo standalone. Do not add examples, paths, fixtures, or docs tied to private downstream repositories.
- Keep `.agents/skills/**` as repo-local development skills; do not treat them as installable target-repo assets.
- Keep installable/runtime assets under the existing public package surface: `dist`, `prompts`, `schemas`, `skills`, `README.md`, `LICENSE`.
- Prefer explicit TypeScript over clever compression. Use erasable syntax compatible with Node 24 type stripping in source files.
- Keep local `.ts` import extensions in source. Built output remains `dist/**/*.js`.
- Preserve CLI contracts: usage errors exit `2`, runtime errors exit `1`, dry-run exits `0`, passing reviews exit `0`, non-passing reviews exit `1`.
- Preserve structured JSON output shape unless the task explicitly changes the contract.
- Keep Zod validation at external or file/config boundaries; avoid double-validating already parsed internal values.
- Keep workflows simple until a second real workflow exists. Do not introduce registries, plugin systems, or generic abstractions for one caller.

## Simplification Targets

Prefer these changes when behavior stays identical:

- Replace deep nesting with guard clauses.
- Extract named helpers only when they clarify a real responsibility or remove meaningful duplication.
- Inline empty wrappers that add no name, reuse, or test seam.
- Replace nested ternaries with `if`/`switch` or a small lookup.
- Name data by domain meaning: `review`, `scope`, `runDir`, `envelope`, `config`, not generic `data` when ambiguity exists.
- Remove comments that restate code; keep comments explaining non-obvious contracts or compatibility choices.
- Collapse duplicate test setup into small local helpers when it improves scan speed.
- Keep fake/test helpers deterministic and local to the test file unless reuse is real.

## Do Not Simplify Away

- Error handling and exit-code contracts in CLI entrypoints.
- Artifact paths and run metadata compatibility.
- Prompt/context file boundaries that keep agent inputs inspectable.
- Schema validation for reviewer output and harness config.
- Quiet gate behavior in `Makefile`.
- Regression tests added for bugs or review findings.

## Checks

Pick the narrowest commands that cover touched files:

| Change | Check |
|--------|-------|
| Formatting only | `pnpm format:check` |
| Source or tests | `pnpm typecheck` and focused `pnpm test -- <file>` |
| CLI behavior | focused CLI tests plus `pnpm build && pnpm smoke:dist` |
| Shared behavior or before PR | `pnpm check && pnpm check:ci` |

Use `pnpm format` for formatting changes. If a full gate fails, isolate whether the failure is from the simplification before making unrelated fixes.

## Output

Report briefly:

1. Files touched.
2. Simplifications made and why.
3. Checks run.
4. Anything intentionally left alone.
