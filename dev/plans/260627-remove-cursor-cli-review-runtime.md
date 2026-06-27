# Plan 260627-remove-cursor-cli-review-runtime: Remove the Cursor CLI runtime from harness reviews

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `dev/plans/260627-sdk-agent-stream-logs.md`, `dev/plans/260626-agent-abort-signal.md`
- **Category**: tech-debt
- **Related**: SDK pivot; Cursor CLI review runtime deprecation

## Why this matters

Harness now treats SDK providers as the production review path: Cursor SDK is the default runtime and Codex is SDK-only from harness' perspective. Keeping the Cursor CLI review runtime makes every provider plan branch across two execution models, keeps subprocess tests alive, and encourages new work to target `harness-cursor` instead of the SDK adapters. Removing the review-runtime CLI path lets stream logs, cancellation, structured output, and future durable orchestration target one provider contract.

This plan is intentionally after SDK stream logs and SDK abort support. Those plans close the practical observability/cancellation gaps that previously made the CLI path tempting.

## Current state

- `lib/agents.ts` — defines `CURSOR_RUNTIMES = ["cli", "sdk"]`, `CursorRuntime`, and `DEFAULT_CURSOR_RUNTIME = "sdk"`.
- `bin/harness.ts` — exposes `--runtime <runtime>`, `--cursor-wrapper`, and hidden `--cursor-agent`; rejects wrapper options unless Cursor runtime is `cli`.
- `lib/agent-provider.ts` — selects Cursor SDK when runtime is SDK, otherwise falls back to `createCursorAgent(...)`.
- `lib/cursor-agent.ts` — parent-side subprocess wrapper around `providers/cursor/cursor-agent.ts`.
- `providers/cursor/cursor-agent.ts` and `providers/cursor/lib/*` — `harness-cursor` launcher, CLI runner, envelope, home discovery, TOON output.
- `install` — installs a `harness-cursor` shim.
- `skills/cursor-cli/` — intentionally documents `harness-cursor` for ad-hoc Cursor delegation.
- Tests still cover the legacy path: `test/cursor-agent.test.ts`, `providers/cursor/cursor-agent.test.ts`, `test/install.test.ts`, and CLI tests around `--runtime cli` / `--cursor-wrapper`.

Relevant current excerpts:

```ts
// lib/agent-provider.ts
if (isCursorSdkRuntime(options.provider, options.cursorRuntime)) {
  return createLazyCursorSdkAgent();
}

return createCursorAgent({
  cursorAgentPath: resolveCursorAgentPath(options.cursorAgentPath),
});
```

```ts
// bin/harness.ts
.option("--runtime <runtime>", "Cursor runtime: cli or sdk (default: sdk)", parseCursorRuntime)
.option("--cursor-wrapper <path>", "Cursor wrapper entrypoint (auto-detected)")
```

```ts
// lib/agents.ts
export const CURSOR_RUNTIMES = ["cli", "sdk"] as const;
export const DEFAULT_CURSOR_RUNTIME = "sdk" satisfies CursorRuntime;
```

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm run typecheck` | exit 0, no TypeScript errors |
| Target tests | `pnpm test -- test/cli.test.ts test/config.test.ts test/agent-provider.test.ts test/install.test.ts providers/cursor/cursor-sdk-agent.test.ts` | exit 0 |
| Full tests | `pnpm test` | exit 0 |
| Lint | `pnpm run lint` | exit 0 |
| Format check | `pnpm run format:check` | exit 0 |

## Suggested executor toolkit

| Skill | Use for |
|-------|---------|
| `node` | CLI option handling, install script behavior, subprocess cleanup removal |
| `typescript-refactor` | Type deletion and provider contract simplification |
| `vitest` | Updating tests after removing fake wrapper / CLI runtime cases |

## Scope

**In scope**:

- Remove Cursor CLI runtime selection from `harness run change-review`.
- Remove `--runtime cli` and `--cursor-wrapper` / `--cursor-agent` from review command behavior.
- Simplify `lib/agent-provider.ts` so `provider: "cursor"` always uses `createCursorSdkAgent()`.
- Remove or archive `lib/cursor-agent.ts` and `providers/cursor/cursor-agent.ts` review-runtime entrypoint code.
- Remove Cursor CLI runtime tests and replace workflow tests that used fake wrappers with SDK/provider mocks.
- Update README and skill docs so review examples are SDK-only.
- Decide and apply one of these outcomes for `skills/cursor-cli/`:
  - remove/archive it if harness no longer owns any Cursor CLI launcher, or
  - split it into a separate documented legacy/ad-hoc package outside the review runtime.
- Update `install` and `test/install.test.ts` so install no longer promises `harness-cursor` unless the skill is explicitly retained.

**Out of scope**:

- Codex SDK internals. The Codex SDK may spawn the Codex CLI internally; that is provider-owned and not a harness CLI runtime.
- `bin/sessions.ts` or session-history CLI commands. They are harness CLIs, not Cursor review runtimes.
- Removing `harness run` itself.
- Removing Cursor SDK.
- Rewriting session evidence, automations, or review prompts unless they mention `--runtime cli` / `harness-cursor`.

## Steps

### Step 1: Make a final retention decision for `cursor-cli`

Search:

```bash
rg -n "harness-cursor|cursor-cli|--runtime cli|--cursor-wrapper|cursorRuntime: \"cli\"" .
```

Decide before coding:

- **Full removal**: delete/archive `skills/cursor-cli/`, stop installing `harness-cursor`, and remove provider CLI code.
- **Split retention**: keep `skills/cursor-cli/` only if it no longer depends on review-runtime internals. Move it out of this plan or write a separate migration plan.

Recommended default: full removal from this repo unless there is an active ad-hoc Cursor delegation workflow that cannot use Cursor SDK.

**Verify**: document the decision in the PR body or update this plan before implementation.

### Step 2: Remove runtime branching from provider types

Edit `lib/agents.ts`, `lib/config.ts`, and `lib/agent-provider.ts`.

Target shape:

- `provider: "cursor"` always maps to Cursor SDK.
- Remove `CURSOR_RUNTIMES`, `CursorRuntime`, `DEFAULT_CURSOR_RUNTIME`, `effectiveCursorRuntime`, and `isCursorSdkRuntime` if no longer used.
- Remove `cursorRuntime` from resolved harness options unless a compatibility warning is intentionally kept for one release.
- Remove CLI-focused model note text like "For Cursor CLI model IDs, use --runtime cli."

Compatibility option:

- For one release, `--runtime sdk` may be accepted as a no-op.
- `--runtime cli` should fail fast with a clear message: `Cursor CLI runtime has been removed; use the Cursor SDK runtime.`

**Verify**: `pnpm run typecheck` -> exit 0.

### Step 3: Simplify the review CLI

Edit `bin/harness.ts`.

Remove:

- `parseCursorRuntime` if unused.
- `--cursor-wrapper`.
- hidden `--cursor-agent`.
- runtime/wrapper validation branches.
- passing `cursorRuntime` and `cursorAgentPath` into `resolveHarnessOptions`.

If keeping one-release compatibility, keep `--runtime <runtime>` only to reject `cli` and ignore/accept `sdk`; document this in code with a short deprecation comment.

Tests in `test/cli.test.ts`:

- Remove or rewrite spawn-arg expectations for fake `harness-cursor`.
- Add a test that `--runtime cli` fails with the clear removal message if compatibility flag remains.
- Ensure stdout remains final single JSON meta for normal SDK/Codex paths.

**Verify**: `pnpm test -- test/cli.test.ts` -> exit 0.

### Step 4: Remove CLI provider code and tests

Delete or archive only after Step 1 decision:

- `lib/cursor-agent.ts`
- `providers/cursor/cursor-agent.ts`
- `providers/cursor/lib/runner.ts`
- `providers/cursor/lib/command.ts`
- `providers/cursor/lib/home.ts`
- `providers/cursor/lib/toon.ts`
- tests that only validate the deleted CLI stack

Keep:

- `providers/cursor/cursor-sdk-agent.ts`
- `providers/cursor/lib/schema.ts` if still imported by Cursor SDK prompt wrapping / parsing.
- `providers/cursor/lib/schema.test.ts`.

If a shared helper lives under `providers/cursor/lib/` and is used by SDK code, keep it and rename only if useful.

**Verify**: `rg -n "createCursorAgent|harness-cursor|CURSOR_CLI_EXECUTABLE|stream-json|--cursor-wrapper" lib providers bin test README.md skills .agents/skills` -> no active review-runtime references remain, except archived docs if intentionally kept.

### Step 5: Update install and docs

Edit:

- `install`
- `test/install.test.ts`
- `README.md`
- `skills/change-review-workflow/SKILL.md`
- `dev/plans/README.md`
- this plan status after implementation

Remove examples that recommend:

- `harness run change-review --agent cursor --runtime cli`
- `--cursor-wrapper`
- installing `harness-cursor` as part of harness install

Keep language that distinguishes:

- Cursor SDK as harness provider runtime.
- Codex SDK as harness provider runtime.
- Codex SDK internal CLI spawn is not a harness CLI runtime.

**Verify**: `rg -n "--runtime cli|--cursor-wrapper|harness-cursor|CURSOR_CLI_EXECUTABLE" README.md skills .agents/skills install test` -> only archived/intentional references remain.

### Step 6: Replace workflow tests that used fake wrappers

In `test/workflow-context.test.ts`, replace tests that create fake wrapper scripts with injected `agentProviderFactory` mocks.

Expected pattern:

```ts
createWorkflowContextForTest({
  agentProvider: "cursor",
  agentProviderFactory(options) {
    return {
      name: options.provider,
      async run(input) {
        return { ok: true, structuredOutput: validReview, raw: { input } };
      },
    };
  },
  // ...
});
```

Do not preserve fake `harness-cursor` wrapper tests just to keep coverage of the deleted runtime.

**Verify**: `pnpm test -- test/workflow-context.test.ts test/agent-provider.test.ts test/config.test.ts` -> exit 0.

### Step 7: Full verification

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run format:check
```

Expected: all exit 0.

## Test plan

- CLI tests prove removed flags fail clearly or are gone from help.
- Agent-provider tests prove Cursor uses SDK without runtime branching.
- Config tests prove no target `harness.json` can force Cursor CLI for reviews.
- Install tests prove no stale `harness-cursor` shim is promised unless Step 1 retained the ad-hoc skill separately.
- Workflow-context tests use provider mocks, not fake wrapper scripts.
- Full test suite passes after deleting CLI-runtime tests.

## Done criteria

- [ ] `provider: "cursor"` always creates Cursor SDK provider for reviews.
- [ ] `--runtime cli`, `--cursor-wrapper`, and `--cursor-agent` are removed or fail with explicit removal messaging.
- [ ] `lib/cursor-agent.ts` and Cursor CLI provider runner files are deleted or moved out of the active review runtime.
- [ ] Tests no longer rely on fake `harness-cursor` wrapper scripts for workflow coverage.
- [ ] README and skill docs are SDK-first and do not recommend Cursor CLI review runs.
- [ ] `skills/cursor-cli/` has an explicit fate: removed/archived or split out by a separate plan.
- [ ] `rg -n "harness-cursor|--runtime cli|--cursor-wrapper|CURSOR_CLI_EXECUTABLE" .` returns only archived docs or intentional compatibility messages.
- [ ] `pnpm run typecheck`, `pnpm test`, `pnpm run lint`, and `pnpm run format:check` pass.
- [ ] `dev/plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- There is an active, required workflow that depends on `skills/cursor-cli/` and cannot use Cursor SDK.
- Removing runtime config would break existing target `harness.json` files without an acceptable compatibility error.
- Cursor SDK cannot cover a review capability that currently only works through Cursor CLI.
- The removal would require changing review output schemas or prompt contracts.

## Maintenance notes

- Land SDK stream logs and SDK abort first so the CLI path is not retained for observability/cancellation reasons.
- Keep archived plan files for historical context, but remove active implementation references.
- After this plan lands, new provider work should target only `providers/cursor/cursor-sdk-agent.ts` and `providers/codex/codex-agent.ts`.
