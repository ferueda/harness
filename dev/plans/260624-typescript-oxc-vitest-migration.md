# Plan 260624-typescript-oxc-vitest-migration: Migrate harness to TypeScript, Oxc, Vitest, and Zod

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: migration | dx | tests

## Why this matters

The harness runner is becoming an installable project, so it needs a maintainable typed codebase, deterministic quality gates, and a test runner that scales past the current Node `node:test` baseline. TypeScript should improve refactor safety without adding a separate runtime shim. Oxlint and Oxfmt should give the repo fast lint and formatting checks. Vitest should replace `node:test` with a more capable test runner while keeping the current test coverage intact. Zod should validate dynamic runtime inputs, especially `harness.json` and reviewer JSON output, so bad external data fails with clear errors instead of flowing through loosely typed objects.

The key design constraint is installability: source files may be TypeScript, but an installed harness package must execute built JavaScript from `dist/`. Do not point the package `bin` entry at raw `.ts` files. Node's built-in TypeScript support intentionally refuses TypeScript inside `node_modules`, so raw `.ts` package entrypoints are not a safe install target.

## Current state

This repo is currently plain ESM JavaScript with pnpm and Node 24:

- `package.json` has `"type": "module"`, `"packageManager": "pnpm@11.9.0"`, `"engines": { "node": ">=24" }`, one script (`"test": "node --test"`), and a bin entry pointing at `./bin/harness.ts`.
- `.github/workflows/test.yml` installs pnpm, installs dependencies with `pnpm install --frozen-lockfile`, and runs only `pnpm test`.
- Runtime code lives in:
  - `bin/harness.ts` - CLI parser and command dispatch.
  - `lib/*.js` - config, workflow context, prompt/context helpers, review aggregation, Cursor invocation.
  - `workflows/dual-review.workflow.js` - workflow definition.
  - `providers/cursor/**/*.mjs` - Cursor provider wrapper and helper modules.
- Tests live in:
  - `test/*.test.js`
  - `providers/cursor/cursor-agent.test.mjs`
- Static runtime assets live outside source code:
  - `prompts/*.md`
  - `schemas/review-output.schema.json`
  - `skills/*/SKILL.md`
- There is no `Makefile` yet. Add one in this migration so local and CI gates can stay quiet by default and print full command output only on failure.

Current package excerpt:

```json
{
  "name": "harness",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.9.0",
  "bin": {
    "harness": "./bin/harness.ts"
  },
  "scripts": {
    "test": "node --test"
  },
  "engines": {
    "node": ">=24"
  }
}
```

Current CLI imports use emitted JavaScript extensions:

```js
// bin/harness.ts
import { run as runDualReview } from "../workflows/dual-review.workflow.js";
import { initHarnessConfig, resolveHarnessOptions } from "../lib/config.js";
import { createWorkflowContext } from "../lib/workflow-context.js";
```

Current tests use Node's built-in runner:

```js
// test/config.test.js
import assert from "node:assert/strict";
import test from "node:test";
import {
  HARNESS_GITIGNORE_ENTRY,
  findHarnessConfig,
  initHarnessConfig,
  resolveHarnessOptions,
} from "../lib/config.js";
```

Current runtime root logic assumes source layout:

```js
// lib/workflow-context.js
const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(HARNESS_ROOT, "schemas/review-output.schema.json");
const DEFAULT_CURSOR_AGENT = join(HARNESS_ROOT, "providers/cursor/cursor-agent.ts");
```

That logic must be revisited during the build migration because the compiled file will live under `dist/lib/workflow-context.js`, where `dirname(...)/..` is `dist`, not the repository/package root.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0, `pnpm-lock.yaml` updated |
| Format write | `pnpm format` | exit 0, files formatted |
| Format check | `pnpm format:check` | exit 0, no formatting drift |
| Lint | `pnpm lint` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no TypeScript errors |
| Tests | `pnpm test` | exit 0, all current behavior still covered |
| Build | `pnpm build` | exit 0, `dist/bin/harness.js` exists |
| Full local gate | `pnpm check` | exit 0; runs format check, lint, strict typecheck, tests, and build; quiet unless a subcommand fails |
| Verbose local gate | `pnpm check:v` | exit 0; runs the same gates as `pnpm check` and prints full subcommand output |
| CI gate | `pnpm check:ci` | exit 0; runs the same gates as `pnpm check`, including strict typecheck, unless CI-only gates are added later |

## Suggested executor toolkit

| Skill | Path | Use for |
|-------|------|---------|
| `implement-plan` | `skills/implement-plan/SKILL.md` | Execute this plan phase by phase and update checkboxes only after verification passes. |
| `node` | `.agents/skills/node/SKILL.md` | Configure Node 24 TypeScript, `.ts` import specifiers, ESM behavior, and native type-stripping constraints. |
| `typescript-refactor` | `.agents/skills/typescript-refactor/SKILL.md` | Convert JS to strict, erasable TypeScript without enums, namespaces, parameter properties, or unsafe casts. |
| `vitest` | `.agents/skills/vitest/SKILL.md` | Migrate tests from `node:test` to Vitest and keep async/process tests deterministic. |
| `zod` | `.agents/skills/zod/SKILL.md` | Add runtime schemas at config and reviewer-output boundaries without over-validating trusted internal values. |
| `review-implementation` | `skills/review-implementation/SKILL.md` | Review the finished migration against this plan before merge. |
| `code-quality-review` | `skills/code-quality-review/SKILL.md` | Review the finished migration for clarity and maintainability before merge. |

Reference docs to read before editing:

- Node.js v24 TypeScript docs: `https://nodejs.org/docs/latest-v24.x/api/typescript.html`
- Oxfmt usage docs: `https://oxc.rs/docs/guide/usage/formatter.html`
- Oxlint usage/config docs: `https://oxc.rs/docs/guide/usage/linter.html`
- Oxlint config docs: `https://oxc.rs/docs/guide/usage/linter/config`
- Oxlint CI docs: `https://oxc.rs/docs/guide/usage/linter/ci`
- Vitest guide: `https://vitest.dev/guide/`
- Zod docs: `https://zod.dev/`

Latest package versions verified from the npm registry on 2026-06-24:

- `typescript@6.0.3`
- `@types/node@24.13.2` (latest Node 24-compatible line; latest overall is `26.0.0`, but this repo requires Node 24 and should not type against newer runtime APIs)
- `oxlint@1.71.0`
- `oxfmt@0.56.0`
- `vitest@4.1.9`
- `zod@4.4.3`
- `@vitest/coverage-v8@4.1.9` only if coverage is added in this plan. Do not add coverage unless the user explicitly asks during execution.

Oxc setup decisions for this repo:

- Use Oxlint as the primary linter. Oxc recommends installing it as a dev dependency and adding `lint`/`lint:fix` scripts; it is built for fast CI and defaults to high-signal correctness checks.
- Use a committed config file. Oxc supports `.oxlintrc.json` and `oxlint.config.ts`, but only one should exist in a directory. Prefer `.oxlintrc.json` here because it is simpler, works without config-runtime concerns, and this repo does not need dynamic config.
- Start with Oxlint defaults plus a small set of project-relevant rules. Do not enable broad pedantic/style categories in this migration; formatting belongs to Oxfmt and noisy lint output is poor feedback for agents.
- Do not enable Oxlint type-aware mode in this plan. TypeScript's `pnpm typecheck` is the type gate; type-aware linting can be evaluated later once the base migration is stable.
- Lint and format only source/config/test files, not `skills/`, `.agents/skills/`, `prompts/`, or `dev/plans/`. Those directories contain human-authored instructions and prompt artifacts where formatter churn would create noise.
- Gates should be quiet by default. Use Make to capture each subcommand's output and print it only when that subcommand fails. Provide a verbose opt-in gate for debugging.

TypeScript setup decisions for this repo:

- Use strict mode from the first TypeScript commit. `tsconfig.json` must set `"strict": true`; do not weaken it to make the migration easier.
- Keep `pnpm typecheck` as a required gate in `pnpm check`, `pnpm check:v`, `pnpm check:ci`, and CI.
- Do not rely on Node's TypeScript stripping for type safety. Native stripping only runs erasable syntax; it does not validate types.

## Scope

**In scope**:

- `package.json`
- `pnpm-lock.yaml`
- `tsconfig.json` (create)
- `tsconfig.build.json` (create)
- `vitest.config.ts` (create)
- `.oxlintrc.json` or `oxlint.config.ts` (create one, not both)
- `.oxfmtrc.json` (create)
- `.gitignore`
- `Makefile` (create)
- `.github/workflows/test.yml`
- `README.md`
- `lib/schemas.ts` or another small local schema module (create)
- `bin/harness.ts` -> `bin/harness.ts`
- `lib/*.js` -> `lib/*.ts`
- `workflows/*.js` -> `workflows/*.ts`
- `providers/cursor/**/*.mjs` -> `providers/cursor/**/*.ts`
- `test/*.test.js` -> `test/*.test.ts`
- `providers/cursor/cursor-agent.test.mjs` -> `providers/cursor/cursor-agent.test.ts`

**Out of scope**:

- Do not change workflow behavior, artifact naming, prompt content, review schema shape, or CLI flags.
- Do not migrate or copy `.agents/skills/` into installable harness output. Those are repo-local development skills.
- Do not introduce a bundler, `tsx`, Babel, SWC, Vite build, or custom test harness.
- Do not enable Oxlint type-aware linting yet. Type-aware linting can be evaluated after the base migration is stable.
- Do not add `zod-to-json-schema` or any schema-generation dependency in this plan.
- Do not replace `schemas/review-output.schema.json`; Cursor still needs JSON Schema in the prompt wrapper. Keep the JSON Schema file as the external agent contract and mirror it with a Zod validator for local runtime parsing.
- Do not add package publishing automation.
- Do not add coverage gates unless the user explicitly expands scope.
- Do not rework the CLI parser into Commander in this plan.

## Steps

### Step 1: Add the TypeScript, Oxc, Vitest, and Zod toolchain

Install Zod as a runtime dependency because the installed harness will use it while parsing config and reviewer output:

```bash
pnpm add zod@4.4.3
```

Install the latest verified dev dependencies:

```bash
pnpm add -D typescript@6.0.3 @types/node@24.13.2 oxlint@1.71.0 oxfmt@0.56.0 vitest@4.1.9
```

Use `@types/node@24.13.2` intentionally. Do not install `@types/node@26.0.0` unless the repo engine moves from Node 24 to Node 26.

Update `package.json` scripts to this shape:

```json
{
  "bin": {
    "harness": "./dist/bin/harness.js"
  },
  "files": ["dist", "prompts", "schemas", "skills", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "check": "make check",
    "check:ci": "make check-ci",
    "check:v": "make check-v",
    "fix": "make fix",
    "format": "oxfmt --write bin lib providers workflows test package.json tsconfig.json tsconfig.build.json vitest.config.ts .oxlintrc.json .oxfmtrc.json",
    "format:check": "oxfmt --check bin lib providers workflows test package.json tsconfig.json tsconfig.build.json vitest.config.ts .oxlintrc.json .oxfmtrc.json",
    "lint": "oxlint -c .oxlintrc.json bin lib providers workflows test package.json tsconfig.json tsconfig.build.json vitest.config.ts",
    "lint:fix": "oxlint -c .oxlintrc.json --fix bin lib providers workflows test package.json tsconfig.json tsconfig.build.json vitest.config.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Keep `"type": "module"`, `"packageManager": "pnpm@11.9.0"`, and `"engines": { "node": ">=24" }`.

Create `tsconfig.json` for source/typechecking:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": [
    "bin/**/*.ts",
    "lib/**/*.ts",
    "providers/**/*.ts",
    "test/**/*.ts",
    "vitest.config.ts",
    "workflows/**/*.ts"
  ],
  "exclude": ["dist", "node_modules", ".harness"]
}
```

Create `tsconfig.build.json` for emitted package JavaScript:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "noEmit": false,
    "outDir": "dist",
    "rootDir": ".",
    "sourceMap": true
  },
  "exclude": ["dist", "node_modules", ".harness", "test/**/*.ts", "**/*.test.ts", "vitest.config.ts"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts", "providers/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
```

Create a conservative Oxlint config. Prefer JSON first because it is simpler and works in all runtimes. These rules are high signal for this Node CLI repo:

- `import/no-cycle` catches accidental dependency loops between `lib/`, `workflows/`, and provider modules.
- `import/no-duplicates` keeps imports clean after mass-renaming `.js`/`.mjs` to `.ts`.
- `promise/no-multiple-resolved` and `promise/no-return-wrap` catch async control-flow mistakes in process/subprocess code.
- `typescript/consistent-type-imports` reinforces `verbatimModuleSyntax` and Node type-stripping compatibility.
- `vitest/expect-expect`, `vitest/no-conditional-tests`, and `vitest/no-disabled-tests` keep migrated tests meaningful.

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["typescript", "unicorn", "oxc", "import", "node", "promise", "vitest"],
  "ignorePatterns": ["dist/**", ".harness/**", "node_modules/**"],
  "rules": {
    "import/no-cycle": "error",
    "import/no-duplicates": "error",
    "promise/no-multiple-resolved": "error",
    "promise/no-return-wrap": "error",
    "typescript/consistent-type-imports": "error",
    "vitest/expect-expect": "error",
    "vitest/no-conditional-tests": "error",
    "vitest/no-disabled-tests": "error"
  }
}
```

Add `dist/` to `.gitignore`.

Create `Makefile` for quiet gates:

```makefile
MAKEFLAGS += --no-print-directory --output-sync=target

VERBOSE ?= 0

define RUN
@if [ "$(VERBOSE)" = "1" ]; then $(1); else tmp="$$(mktemp)"; if ( $(1) ) >"$$tmp" 2>&1; then rm -f "$$tmp"; else cat "$$tmp"; rm -f "$$tmp"; exit 1; fi; fi
endef

.PHONY: help ensure-node build lint typecheck test format check-format fix check check-v check-ci

ensure-node:
	@command -v node >/dev/null 2>&1 || { echo "node not found in PATH"; exit 1; }
	@command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found in PATH"; exit 1; }
	@if [ "$(VERBOSE)" = "1" ]; then node -v; pnpm -v; fi

build: ensure-node
	$(call RUN,pnpm run build)

lint: ensure-node
	$(call RUN,pnpm run lint)

typecheck: ensure-node
	$(call RUN,pnpm run typecheck)

test: ensure-node
	$(call RUN,pnpm run test)

format: ensure-node
	pnpm run format

check-format: ensure-node
	$(call RUN,pnpm run format:check)

fix: ensure-node
	pnpm run format
	pnpm run lint:fix

check: ensure-node
	@$(MAKE) -j5 check-format lint typecheck test build

check-v:
	@VERBOSE=1 $(MAKE) check

check-ci: check

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "%-24s %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
```

The `RUN` wrapper is intentional: successful gates should produce little or no output so agent sessions do not waste tokens; failures should print the captured failing command output.

**Verify**: `pnpm install` -> exit 0 and lockfile updated.

**Verify**: `pnpm exec oxlint --help` -> Oxlint help prints without package resolution errors.

**Verify**: `pnpm exec oxfmt --help` -> Oxfmt help prints without package resolution errors.

**Verify**: `pnpm typecheck` -> exits 0 once the source migration is complete. During early migration phases, expected failures must be type errors caused by not-yet-migrated files, not missing scripts or broken TypeScript config.

**Verify**: `pnpm check:v` -> exit 0 or expected migration-phase failures only, with full logs visible for debugging.

### Step 2: Rename source and test files to TypeScript

Use `git mv` so history remains readable:

```bash
git mv bin/harness.ts bin/harness.ts
git mv workflows/dual-review.workflow.js workflows/dual-review.workflow.ts
git mv lib/aggregate.js lib/aggregate.ts
git mv lib/config.js lib/config.ts
git mv lib/context.js lib/context.ts
git mv lib/cursor-agent.js lib/cursor-agent.ts
git mv lib/workflow-context.js lib/workflow-context.ts
git mv providers/cursor/cursor-agent.ts providers/cursor/cursor-agent.ts
git mv providers/cursor/cursor-agent.test.mjs providers/cursor/cursor-agent.test.ts
git mv providers/cursor/lib/envelope.mjs providers/cursor/lib/envelope.ts
git mv providers/cursor/lib/home.mjs providers/cursor/lib/home.ts
git mv providers/cursor/lib/output.mjs providers/cursor/lib/output.ts
git mv providers/cursor/lib/runner.mjs providers/cursor/lib/runner.ts
git mv providers/cursor/lib/schema.mjs providers/cursor/lib/schema.ts
git mv providers/cursor/lib/toon.mjs providers/cursor/lib/toon.ts
git mv test/aggregate.test.js test/aggregate.test.ts
git mv test/cli.test.js test/cli.test.ts
git mv test/config.test.js test/config.test.ts
git mv test/context.test.js test/context.test.ts
git mv test/workflow-context.test.js test/workflow-context.test.ts
```

Update all internal relative imports to use `.ts` specifiers in source. Examples:

```ts
// bin/harness.ts
import { run as runDualReview } from "../workflows/dual-review.workflow.ts";
import { initHarnessConfig, resolveHarnessOptions } from "../lib/config.ts";
import { createWorkflowContext } from "../lib/workflow-context.ts";
```

```ts
// lib/workflow-context.ts
import { aggregateVerdict, renderSummary } from "./aggregate.ts";
import { invokeCursorAgent } from "./cursor-agent.ts";
```

Keep the shebang at the top of `bin/harness.ts` and `providers/cursor/cursor-agent.ts`.

Do not add TypeScript-only runtime constructs that require transformation. Avoid:

- `enum`
- runtime `namespace`
- constructor parameter properties
- legacy decorators
- path aliases

**Verify**: `find bin lib providers workflows test -type f \( -name '*.js' -o -name '*.mjs' \)` -> no output.

**Verify**: `rg -n 'from ".*\\.(js|mjs)"|from \'.*\\.(js|mjs)\'' bin lib providers workflows test` -> no output for internal relative imports. Node built-in imports such as `node:fs` are fine.

### Step 3: Add Zod schemas at external input boundaries

Create one small schema module, for example `lib/schemas.ts`, and keep it focused. Do not create a schema framework.

Add a harness config schema that preserves current behavior:

```ts
import { z } from "zod";

export const HarnessConfigSchema = z
  .object({
    base: z.string().optional(),
  })
  .passthrough();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
```

Use `.passthrough()` because the current `readHarnessConfig` only validates the known `base` field and ignores unknown keys. Do not accidentally make existing configs invalid by switching to `.strict()`.

Add a reviewer-output schema that mirrors `schemas/review-output.schema.json`:

```ts
export const ReviewOutputSchema = z.object({
  verdict: z.enum(["pass", "needs_changes", "blocked"]),
  summary: z.string(),
  findings: z.array(
    z.object({
      title: z.string(),
      severity: z.enum(["Critical", "High", "Medium", "Low"]),
      location: z.string(),
      issue: z.string(),
      recommendation: z.string(),
      rationale: z.string().optional(),
      must_fix: z.boolean(),
    }),
  ),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
```

Wire the schemas into the current validation boundaries:

- In `lib/config.ts`, replace manual `harness.json` shape checks with `HarnessConfigSchema.safeParse(parsed)`.
- Preserve the current error prefix: `Invalid harness.json: ...`.
- In `lib/cursor-agent.ts`, validate `envelope.structuredOutput` with `ReviewOutputSchema.safeParse(...)` before returning `{ ok: true }`.
- Keep `schemas/review-output.schema.json` and `providers/cursor/lib/schema.ts` in place. They still validate/shape the Cursor worker response contract.

Add or preserve tests for invalid config:

- `harness.json` with non-object content still errors.
- `harness.json` with `"base": 123` still errors.
- `harness.json` with unknown extra keys remains accepted.

Add one test for invalid reviewer output if the code can inject a fake Cursor result cheaply. If doing that requires broad test plumbing, skip the new test and rely on existing schema-parser tests plus type coverage.

**Verify**: `pnpm typecheck` -> exit 0.

**Verify**: `pnpm test` -> exit 0.

### Step 4: Preserve installable runtime behavior with a `dist/` bin

This is the most important design point in the migration.

The source CLI may be runnable in development as:

```bash
node bin/harness.ts --help
```

The package bin must run built JavaScript:

```json
{
  "bin": {
    "harness": "./dist/bin/harness.js"
  }
}
```

Because `lib/workflow-context.ts` currently derives `HARNESS_ROOT` from its own file path, the compiled version must distinguish source layout from `dist/` layout.

Implement the smallest local fix in `lib/workflow-context.ts`:

```ts
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_BUILT_OUTPUT = basename(MODULE_ROOT) === "dist";
const HARNESS_ROOT = IS_BUILT_OUTPUT ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;
const RUNTIME_ROOT = IS_BUILT_OUTPUT ? MODULE_ROOT : HARNESS_ROOT;
const SCHEMA_PATH = join(HARNESS_ROOT, "schemas/review-output.schema.json");
const DEFAULT_CURSOR_AGENT = join(
  RUNTIME_ROOT,
  IS_BUILT_OUTPUT ? "providers/cursor/cursor-agent.js" : "providers/cursor/cursor-agent.ts",
);
```

Use `HARNESS_ROOT` for static package assets that remain at the package root (`prompts/`, `schemas/`, `skills/`). Use `RUNTIME_ROOT` only for compiled runtime code under `dist/`.

This avoids copying static assets into `dist/` and avoids running raw TypeScript from `node_modules`.

Update any tests that spawn scripts:

- `test/cli.test.ts` should point at `bin/harness.ts` for source tests.
- `providers/cursor/cursor-agent.test.ts` should point at `providers/cursor/cursor-agent.ts` for source tests.
- Add one build-output smoke test after `pnpm build` if practical:
  - `node dist/bin/harness.js --help` exits 0.
  - `node dist/bin/harness.js run dual-review --workspace . --base main --head HEAD --dry-run` exits 0 and prints `"status": "dry_run"`.

**Verify**: `pnpm typecheck` -> exit 0.

**Verify**: `pnpm build` -> exit 0 and `dist/bin/harness.js` exists.

**Verify**: `node dist/bin/harness.js --help` -> exit 0 and usage text prints.

### Step 5: Migrate tests from `node:test` to Vitest

For every renamed test file:

- Replace `import test from "node:test";` with `import { test, expect } from "vitest";`.
- Remove `node:assert/strict` where possible.
- Convert common assertions:
  - `assert.equal(actual, expected)` -> `expect(actual).toBe(expected)`
  - `assert.deepEqual(actual, expected)` -> `expect(actual).toEqual(expected)`
  - `assert.match(value, regex)` -> `expect(value).toMatch(regex)`
  - `assert.ok(value)` -> `expect(value).toBeTruthy()`
- Keep tests behavior-focused. Do not rewrite test structure beyond what the migration requires.
- Keep process/env mutation tests carefully scoped with `try/finally`, matching the current pattern in `providers/cursor/cursor-agent.test.mjs`.

Example target shape:

```ts
import { test, expect } from "vitest";
import {
  HARNESS_GITIGNORE_ENTRY,
  findHarnessConfig,
  initHarnessConfig,
  resolveHarnessOptions,
} from "../lib/config.ts";

test("findHarnessConfig walks up from nested directories", () => {
  // existing setup
  expect(findHarnessConfig(nested)).toBe(join(workspace, "harness.json"));
});
```

Do not enable Vitest globals. Keep imports explicit.

**Verify**: `pnpm test` -> all existing tests pass under Vitest.

Expected result after migration: same test count or intentionally equivalent coverage. If the exact count differs because Vitest groups/tests are reported differently, confirm each previous test name still appears in output or in `rg '^test\\(' test providers`.

### Step 6: Run Oxfmt and Oxlint, then fix only migration-related issues

Run formatting once:

```bash
pnpm format
```

Then lint:

```bash
pnpm lint
```

Fix issues caused by the migration and config. Keep the fixes narrow:

- Type-only imports should use `import type`.
- Unused imports introduced during assertion migration should be removed.
- Do not refactor runtime logic for style unless Oxlint reports a clear issue.
- If Oxlint reports a noisy rule that does not fit this repo, disable that specific rule in `.oxlintrc.json` with a short reason in this plan's implementation notes or PR summary. Do not disable whole plugins unless the plugin is clearly not useful.

**Verify**: `pnpm format:check` -> exit 0.

**Verify**: `pnpm lint` -> exit 0.

### Step 7: Update docs and CI gates

Update `README.md` examples:

- Development source run:

```bash
node bin/harness.ts init
node bin/harness.ts run dual-review
```

- Built/installable run:

```bash
pnpm build
node dist/bin/harness.js init
```

- Development gates:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
pnpm check:v
```

Update `.github/workflows/test.yml` to run the full quality gate after install:

```yaml
- name: Run checks
  run: pnpm check:ci
```

It is also acceptable to use separate workflow steps for clearer CI output:

```yaml
- name: Check formatting
  run: pnpm format:check

- name: Lint
  run: pnpm lint

- name: Typecheck
  run: pnpm typecheck

- name: Test
  run: pnpm test

- name: Build
  run: pnpm build
```

Keep the existing action versions unless Dependabot updates them:

- `actions/checkout@v7.0.0`
- `pnpm/action-setup@v6.0.9`
- `actions/setup-node@v6.4.0`
- Node version `24`
- `cache: pnpm`

**Verify**: `pnpm check` -> exit 0 and no output except command headings Make may emit.

**Verify**: `pnpm check:v` -> exit 0 and prints full subcommand output.

**Verify**: `pnpm check:ci` -> exit 0.

**Verify**: `git diff --check` -> exit 0.

### Step 8: Final smoke test the built CLI

After `pnpm build`, run:

```bash
node dist/bin/harness.js --help
node dist/bin/harness.js init --workspace "$(mktemp -d)"
node dist/bin/harness.js run dual-review --workspace . --base main --head HEAD --dry-run
```

Expected results:

- Help command exits 0 and prints usage.
- Init command exits 0 and prints JSON with `configCreated: true`.
- Dry run command exits 0 and prints JSON with `"status": "dry_run"`.
- Dry run writes artifacts under `.harness/runs/reviews/<run-id>/` in this repo and `.harness/` remains ignored.

**Verify**: `pnpm check` -> exit 0 after the smoke test.

## Test plan

Existing behavior must remain covered after the runner migration:

- `test/aggregate.test.ts` still covers verdict aggregation.
- `test/cli.test.ts` still covers CLI usage errors, init, and dry-run behavior.
- `test/config.test.ts` still covers workspace/config resolution and `.gitignore` handling.
- `test/config.test.ts` also covers Zod-backed `harness.json` validation, including accepting unknown keys and rejecting invalid `base`.
- `test/context.test.ts` still covers diff/context artifact path behavior.
- `test/workflow-context.test.ts` still covers orphan run cleanup.
- `providers/cursor/cursor-agent.test.ts` still covers Cursor command construction, executable resolution, timeout behavior, and structured output parsing.

New or changed tests required:

- Add a build-output smoke check if it can be kept deterministic and fast. Prefer a Node script or Vitest test that runs after `pnpm build`; if that is awkward, keep it as a documented manual verification command in this plan's completion notes.
- Add focused Zod validation tests for `HarnessConfigSchema` and `ReviewOutputSchema` if they are exported from `lib/schemas.ts`; otherwise cover them through `resolveHarnessOptions` and `invokeCursorAgent`.
- If `lib/workflow-context.ts` gets source-vs-dist runtime root logic, add a focused unit test for path resolution if the logic is extracted to a helper. If the logic stays inline, verify it through the built CLI smoke test.

Verification:

```bash
pnpm test
```

Expected: exit 0 and all migrated tests pass under Vitest.

## Done criteria

All must hold:

- [x] `package.json` uses `./dist/bin/harness.js` as the `harness` bin.
- [x] `package.json` includes package `files` for `dist`, `prompts`, `schemas`, `skills`, `README.md`, and `LICENSE`, and does not include `.agents/skills`.
- [x] `package.json` installs `zod@4.4.3` as a runtime dependency.
- [x] `package.json` installs the latest verified dev dependency versions: `typescript@6.0.3`, `@types/node@24.13.2`, `oxlint@1.71.0`, `oxfmt@0.56.0`, and `vitest@4.1.9`.
- [x] `package.json` includes `build`, `check`, `format`, `format:check`, `lint`, `lint:fix`, `test`, `test:watch`, and `typecheck`.
- [x] `package.json` includes `check:ci`, `check:v`, and `fix`.
- [x] `Makefile` exists and `pnpm check` is quiet on success but prints failing subcommand output.
- [x] `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, and one Oxlint config exist.
- [x] `tsconfig.json` has `"strict": true`; no strictness flags are disabled to get the migration passing.
- [x] `pnpm check`, `pnpm check:v`, and `pnpm check:ci` all run `pnpm typecheck`.
- [x] Oxlint config uses only high-signal Node CLI rules and does not enable broad pedantic/style categories.
- [x] Oxfmt and Oxlint scripts target source/config/test files, not `skills/`, `.agents/skills/`, `prompts/`, or `dev/plans/`.
- [x] Zod validates `harness.json` parsing without rejecting unknown keys.
- [x] Zod validates reviewer structured output before harness accepts it.
- [x] `schemas/review-output.schema.json` remains present for the Cursor prompt/schema contract.
- [x] `dist/` is ignored.
- [x] Source/test runtime files under `bin/`, `lib/`, `providers/`, `workflows/`, and `test/` are `.ts`, not `.js`/`.mjs`.
- [x] Internal relative imports in source use `.ts` specifiers.
- [x] Emitted `dist/` files use `.js` specifiers.
- [x] `pnpm format:check` exits 0.
- [x] `pnpm lint` exits 0.
- [x] `pnpm typecheck` exits 0.
- [x] `pnpm test` exits 0.
- [x] `pnpm build` exits 0.
- [x] `pnpm check` exits 0.
- [x] `pnpm check:v` exits 0.
- [x] `pnpm check:ci` exits 0.
- [x] `node dist/bin/harness.js --help` exits 0.
- [x] `node dist/bin/harness.js run dual-review --workspace . --base main --head HEAD --dry-run` exits 0 and returns `"status": "dry_run"`.
- [x] `.github/workflows/test.yml` runs the new quality gates in CI.
- [x] `dev/plans/README.md` status row updated when this plan is complete or in progress.

## STOP conditions

Stop and report back if:

- TypeScript rejects the `.ts` import specifier and `rewriteRelativeImportExtensions` setup even after confirming `typescript@6.0.3` is installed.
- Node 24 cannot execute source `.ts` scripts directly for local tests.
- The built CLI cannot locate `prompts/`, `schemas/`, `skills/`, or the compiled Cursor provider with a small source-vs-dist path fix.
- Zod validation requires changing the existing accepted `harness.json` shape, dropping unknown config keys, or changing review output JSON shape.
- The migration appears to require a bundler, `tsx`, or copying `.agents/skills/` into installable output.
- Vitest changes process/env test behavior in a way that requires changing production code.
- Oxlint produces broad noisy findings unrelated to this migration. In that case, stop and propose a narrower config instead of mass-refactoring.
- Oxfmt attempts to rewrite skill/prompt/plan markdown or other instruction artifacts. Narrow the formatter target list instead of accepting large doc churn.
- The quiet `Makefile` wrapper hides failure output or makes debugging materially harder. Fix the gate wrapper before proceeding.
- Any step requires changing workflow semantics, prompt content, artifact paths, or public CLI flags.

## Maintenance notes

- Keep raw `.ts` source files as development source only. Installed harness execution should continue through `dist/bin/harness.js`.
- Node's type stripping does not typecheck. `pnpm typecheck` is the correctness gate for types.
- Keep Zod schemas at runtime boundaries. Do not add schemas for every internal object unless the object crosses a file/process/user boundary.
- If the JSON Schema contract changes, update `schemas/review-output.schema.json` and `ReviewOutputSchema` together in the same commit.
- If future install work adds packaging/publishing, review the runtime root logic again so static assets and compiled provider scripts resolve correctly from the installed package.
- If future Oxlint type-aware rules are enabled, treat that as a separate plan because it may require different CI cost and rule tuning.
- Keep `pnpm check` quiet on success. If a future gate is added, wire it through the same captured-output Make pattern and add a verbose escape hatch when useful.
- If coverage is added later, prefer a separate coverage plan using Vitest coverage configuration rather than mixing it into this migration.
