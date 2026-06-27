# Plan 260627-remove-cursor-cli-review-runtime: Remove the Cursor CLI runtime from harness reviews

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **State**: completed
- **Depends on**: `260627-sdk-agent-stream-logs` ✅, `260626-agent-abort-signal` ✅ (SDK parity for stream logs + cancellation)
- **Category**: tech-debt
- **Related**: SDK pivot; Cursor CLI review runtime deprecation
- **Step 1 decision**: **Split retention** — keep `skills/cursor-cli/` as a standalone ad-hoc Cursor delegation tool; remove CLI from harness review runtime and `install`.

## Why this matters

Harness now treats SDK providers as the production review path: Cursor SDK is the default runtime and Codex is SDK-only from harness' perspective. Keeping the Cursor CLI review runtime makes every provider plan branch across two execution models, keeps subprocess tests alive, and couples ad-hoc Cursor delegation to `harness run change-review`. Removing the review-runtime CLI path lets stream logs, cancellation, structured output, and future durable orchestration target one provider contract.

The `cursor-cli` launcher remains useful for **agent-to-agent delegation outside harness** (scripts, other agents, ad-hoc tasks). That code moves under `skills/cursor-cli/` as skill-owned `scripts/` + `lib/`; harness `install` no longer ships it.

## Standalone `cursor-cli` contract

After migration, `skills/cursor-cli/` must work **without** harness review runtime, harness `install`, or imports from `lib/`, `bin/`, or `providers/`:

| Requirement | Detail |
|-------------|--------|
| **Self-contained tree** | All launcher code under `skills/cursor-cli/scripts/` + `skills/cursor-cli/lib/` only |
| **No harness imports** | Skill TS must not import `../../lib`, `../../providers`, `../../bin`, or `harness` modules |
| **Direct execution** | `node skills/cursor-cli/scripts/cursor-cli.ts --help` works from repo root (Node 22+ native `.ts`, same as today) |
| **Skill install** | `skills/cursor-cli/scripts/install.sh` symlinks `cursor-cli` → skill script; does not call harness `install` |
| **Tests in skill** | Vitest covers launcher + `lib/schema` under `skills/cursor-cli/` |
| **Harness deletion safe** | Re-run standalone smoke **after** Step 4 deletes `providers/cursor/cursor-agent.ts` — skill must still pass |

Target layout:

```
skills/cursor-cli/
  SKILL.md
  agents/openai.yaml
  scripts/
    cursor-cli.ts      # #!/usr/bin/env node entrypoint
    cursor-cli.test.ts
    install.sh
  lib/
    command.ts
    envelope.ts
    home.ts
    output.ts
    runner.ts
    schema.ts
    schema.test.ts
    toon.ts
```

**Not required:** harness `package.json` `bin` entry for `cursor-cli`, harness `install` shim, or `lib/cursor-agent.ts` parent wrapper (skill invokes Cursor `agent` directly, as the launcher already does).

## Current state

- `lib/agents.ts` — defines `CURSOR_RUNTIMES = ["cli", "sdk"]`, `CursorRuntime`, and `DEFAULT_CURSOR_RUNTIME = "sdk"`.
- `lib/schemas.ts` — `agents.cursor.runtime` validated via `z.enum(CURSOR_RUNTIMES)`.
- `bin/harness.ts` — exposes `--runtime <runtime>`, `--cursor-wrapper`, and hidden `--cursor-agent`; rejects wrapper options unless Cursor runtime is `cli`.
- `lib/config.ts` — resolves `cursorRuntime` from CLI + `harness.json`.
- `lib/agent-provider.ts` — selects Cursor SDK when runtime is SDK, otherwise falls back to `createCursorAgent(...)`.
- `lib/workflow-context.ts` — passes `cursorRuntime` / `cursorAgentPath` to provider factory; writes `meta.agent.runtime`.
- `lib/cursor-agent.ts` — parent-side subprocess wrapper around `providers/cursor/cursor-agent.ts`.
- `providers/cursor/cursor-agent.ts` and CLI-only `providers/cursor/lib/*` — `cursor-cli` launcher, runner, envelope, home, TOON output.
- `providers/cursor/lib/schema.ts` — shared prompt wrap + structured output parse; **used by SDK**; copy into skill for standalone CLI.
- `install` — installs a `cursor-cli` shim pointing at `providers/cursor/cursor-agent.ts`.
- `skills/cursor-cli/` — documents `cursor-cli` for ad-hoc Cursor delegation (no owned code yet).
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
// lib/schemas.ts
runtime: z.enum(CURSOR_RUNTIMES).optional(),
```

```ts
// lib/workflow-context.ts
return { runtime: effectiveCursorRuntime(options.cursorRuntime) };
```

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm run typecheck` | exit 0, no TypeScript errors |
| Target tests | `pnpm test -- test/cli.test.ts test/config.test.ts test/agent-provider.test.ts test/install.test.ts test/workflow-context.test.ts providers/cursor/cursor-sdk-agent.test.ts` | exit 0 |
| Skill CLI tests | `pnpm test -- skills/cursor-cli` | exit 0 |
| Standalone smoke | Step 1 + Step 4 re-checks (see below) | `cursor-cli` works without harness install |
| Cleanup sweeps | Step 7f `rg` commands | harness clean; `cursor-cli` only under `skills/cursor-cli/` |
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
- Remove harness review-runtime glue: `lib/cursor-agent.ts`, provider selection for CLI, install shim.
- **Migrate** CLI launcher code into `skills/cursor-cli/` as self-contained `scripts/` + `lib/` (not a harness provider); must satisfy **Standalone `cursor-cli` contract** above.
- Add skill-owned `skills/cursor-cli/scripts/install.sh` that symlinks `cursor-cli` from the skill tree only.
- Remove Cursor CLI **review** tests from harness; relocate launcher tests under the skill.
- Update README and skill docs: reviews are SDK-only; `cursor-cli` is skill-installed ad-hoc tooling.
- **Repo-wide cleanup sweep** (Step 7): dead harness code, stale tests, docs, skills, config examples, and plan index rows.

**Out of scope**:

- Codex SDK internals. The Codex SDK may spawn the Codex CLI internally; that is provider-owned and not a harness CLI runtime.
- `bin/sessions.ts` or session-history CLI commands. They are harness CLIs, not Cursor review runtimes.
- Removing `harness run` itself.
- Removing Cursor SDK.
- Rewriting session evidence or automations unless they mention `--runtime cli` / harness-installed `cursor-cli`.
- Deduplicating `schema.ts` between SDK and skill long-term (acceptable copy at migration; SDK copy stays canonical for reviews).

## Steps

### Step 1: Migrate CLI launcher into `skills/cursor-cli/` (standalone)

**Decision (locked):** Split retention. Harness drops review-runtime CLI; skill owns `cursor-cli` and must run independently of harness.

Create under `skills/cursor-cli/`:

| From (harness) | To (skill) |
|----------------|------------|
| `providers/cursor/cursor-agent.ts` | `skills/cursor-cli/scripts/cursor-cli.ts` |
| `providers/cursor/lib/command.ts` | `skills/cursor-cli/lib/command.ts` |
| `providers/cursor/lib/envelope.ts` | `skills/cursor-cli/lib/envelope.ts` |
| `providers/cursor/lib/home.ts` | `skills/cursor-cli/lib/home.ts` |
| `providers/cursor/lib/output.ts` | `skills/cursor-cli/lib/output.ts` |
| `providers/cursor/lib/runner.ts` | `skills/cursor-cli/lib/runner.ts` |
| `providers/cursor/lib/toon.ts` | `skills/cursor-cli/lib/toon.ts` |
| `providers/cursor/lib/schema.ts` | `skills/cursor-cli/lib/schema.ts` (copy; skill-local imports only) |
| `providers/cursor/lib/schema.test.ts` | `skills/cursor-cli/lib/schema.test.ts` |
| `providers/cursor/cursor-agent.test.ts` | `skills/cursor-cli/scripts/cursor-cli.test.ts` |

**Import rules:**

- `cursor-cli.ts` imports only from `../lib/*.ts` (or `./lib` if you colocate — prefer `scripts/` + `lib/` layout above).
- Skill `lib/*` imports only other files under `skills/cursor-cli/lib/`.
- **No** imports from `lib/`, `providers/`, `bin/`, `workflows/`, or harness packages beyond Node builtins.

**Entrypoint:**

- Keep `#!/usr/bin/env node` on `cursor-cli.ts`.
- Set `LAUNCHER_COMMAND = "cursor-cli"` in skill `lib/command.ts` (rename from legacy `harness-cursor` in migrated `command.ts`).
- Help text, install symlink, and tests must use `cursor-cli` only — no `harness-cursor` alias.

**`skills/cursor-cli/scripts/install.sh`:**

```bash
#!/usr/bin/env bash
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${CURSOR_CLI_INSTALL_BIN:-$HOME/.local/bin}"
ENTRYPOINT="$SKILL_ROOT/scripts/cursor-cli.ts"
mkdir -p "$BIN_DIR"
ln -sf "$ENTRYPOINT" "$BIN_DIR/cursor-cli"
chmod +x "$ENTRYPOINT"
echo "Installed cursor-cli: $BIN_DIR/cursor-cli"
echo "Entrypoint: $ENTRYPOINT"
```

Must resolve `SKILL_ROOT` from the script location (works from any cwd). Must **not** reference harness `install`, `providers/cursor/`, or repo `bin/harness`.

**Tooling (include skill in harness repo checks):**

- `vitest.config.ts` — add `"skills/cursor-cli/**/*.test.ts"` to `include`.
- `tsconfig.json` — add `"skills/cursor-cli/**/*.ts"` to `include` so `pnpm run typecheck` covers skill code.

Update `skills/cursor-cli/SKILL.md`:

- Remove **Harness provider:** `providers/cursor/cursor-agent.ts`.
- Document: install via `skills/cursor-cli/scripts/install.sh` or direct `node …/cursor-cli.ts`.
- Clarify boundary: `harness run change-review` → Cursor SDK; this skill → ad-hoc / cross-agent Cursor calls.

**Verify — unit tests:**

```bash
pnpm test -- skills/cursor-cli
```

→ exit 0.

**Verify — standalone smoke (no harness install):**

```bash
# Direct from repo root — does not require harness on PATH
node skills/cursor-cli/scripts/cursor-cli.ts --help
node skills/cursor-cli/scripts/cursor-cli.ts --format json   # home/status envelope

# No harness coupling in skill source
rg -n "from ['\"].*(/lib/|/providers/|/bin/|harness)" skills/cursor-cli
rg -n "providers/cursor/cursor-agent|lib/cursor-agent|createCursorAgent" skills/cursor-cli
```

→ help shows `Usage: cursor-cli`; home command exits 0 with JSON/TOON envelope; both `rg` → no matches.

**Verify — skill install path (optional but recommended):**

```bash
BIN_DIR="$(mktemp -d)" CURSOR_CLI_INSTALL_BIN="$BIN_DIR" skills/cursor-cli/scripts/install.sh
"$BIN_DIR/cursor-cli" --help
```

→ exit 0.

### Step 2: Remove runtime branching from harness types and config

Edit `lib/agents.ts`, `lib/config.ts`, `lib/schemas.ts`, `lib/agent-provider.ts`, and `lib/workflow-context.ts`.

Target shape:

- `provider: "cursor"` always maps to Cursor SDK.
- Remove `CURSOR_RUNTIMES`, `CursorRuntime`, `DEFAULT_CURSOR_RUNTIME`, `effectiveCursorRuntime`, and `isCursorSdkRuntime`.
- Remove `cursorRuntime` from `resolveHarnessOptions` / `HarnessOptions` and from `WorkflowOptions`.
- Remove `cursorAgentPath` from `WorkflowOptions` and provider factory calls.
- In `lib/schemas.ts`, remove `agents.cursor.runtime` from `HarnessConfigSchema` (or reject `"cli"` with: `Cursor CLI runtime has been removed; use the Cursor SDK runtime (default).`).
- In `lib/workflow-context.ts`, stop passing `cursorRuntime` / `cursorAgentPath` to `createAgentProvider`; drop `resolvedCursorRuntimeMeta` or omit `runtime` from `meta.agent` (SDK-only; no runtime field is fine).
- Remove CLI-focused catalog note: `"Fixed Cursor SDK review modes; --runtime cli passes model IDs to Cursor CLI."` from `lib/agents.ts`.

Compatibility (recommended: **full removal** of runtime flags):

- Do not accept `--runtime`, `--cursor-wrapper`, or `--cursor-agent` on `harness run change-review`.
- `harness.json` with `"runtime": "cli"` fails at config parse with the clear removal message above.

**Verify**: `pnpm run typecheck` → exit 0.

### Step 3: Simplify the review CLI

Edit `bin/harness.ts`.

Remove:

- `parseCursorRuntime` and `CursorRuntime` imports if unused.
- `--runtime`, `--cursor-wrapper`, hidden `--cursor-agent`.
- runtime/wrapper validation branches.
- passing `cursorRuntime` and `cursorAgentPath` into `resolveHarnessOptions`.

Tests in `test/cli.test.ts`:

- Remove or rewrite spawn-arg expectations for fake `cursor-cli` and `--cursor-wrapper`.
- Remove `--runtime cli` / `sdk` cases.
- Ensure stdout remains final single JSON meta for normal SDK/Codex paths.

**Verify**: `pnpm test -- test/cli.test.ts` → exit 0.

### Step 4: Remove harness CLI review glue

Delete from harness (after Step 1 migration verified):

- `lib/cursor-agent.ts`
- `providers/cursor/cursor-agent.ts`
- `providers/cursor/cursor-agent.test.ts`
- `providers/cursor/lib/command.ts`
- `providers/cursor/lib/envelope.ts`
- `providers/cursor/lib/home.ts`
- `providers/cursor/lib/output.ts`
- `providers/cursor/lib/runner.ts`
- `providers/cursor/lib/toon.ts`
- `test/cursor-agent.test.ts`

Keep in harness:

- `providers/cursor/cursor-sdk-agent.ts`
- `providers/cursor/cursor-sdk-agent.test.ts`
- `providers/cursor/lib/schema.ts` (+ `schema.test.ts`) — SDK prompt wrap / parse only.

**Verify**:

```bash
rg -n "createCursorAgent|lib/cursor-agent|providers/cursor/cursor-agent\\.ts|CURSOR_CLI_EXECUTABLE|stream-json|--cursor-wrapper|--runtime cli" lib providers bin test install README.md skills/change-review-workflow .agents/skills/change-review-workflow
```

→ no active **harness review-runtime** references. `skills/cursor-cli/` and archived docs may still mention `cursor-cli`.

**Re-verify standalone skill still works** (harness CLI files are gone):

```bash
pnpm test -- skills/cursor-cli
node skills/cursor-cli/scripts/cursor-cli.ts --help
node skills/cursor-cli/scripts/cursor-cli.ts --format json
rg -n "from ['\"].*(/lib/|/providers/|/bin/)" skills/cursor-cli
```

→ all pass; skill does not depend on deleted harness paths.

### Step 5: Update install

Edit:

- `install` — remove `cursor-cli` shim and post-install `cursor-cli --help` smoke check; only install `harness`.
- `test/install.test.ts` — remove `cursor-cli` expectations, symlink path assertions, and stdout lines for `Installed cursor-cli:`.

**Verify**: `pnpm test -- test/install.test.ts` → exit 0.

### Step 6: Replace workflow tests that used fake wrappers

In `test/workflow-context.test.ts`, replace tests that create fake wrapper scripts (`cursorRuntime: "cli"`, `cursorAgentPath`) with injected `agentProviderFactory` mocks.

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

Rename mislabeled test `"workflow context keeps Cursor CLI reviews parallel by default"` → `"workflow context keeps Cursor reviews parallel by default"` (it already uses SDK defaults).

Do not preserve fake `cursor-cli` wrapper tests for the deleted harness review runtime.

**Verify**: `pnpm test -- test/workflow-context.test.ts test/agent-provider.test.ts test/config.test.ts` → exit 0.

### Step 7: Dead-code, documentation, and skills cleanup sweep

Run after Steps 1–6. Goal: no harness review-runtime residue; skill docs accurate; only intentional `cursor-cli` references live under `skills/cursor-cli/`.

#### 7a. Harness code — remove dead symbols and strings

| Location | Remove / update |
|----------|-----------------|
| `lib/agent-provider.ts` | `createCursorAgent` import, `DEFAULT_CURSOR_AGENT`, `resolveCursorAgentPath`, `cursorRuntime` / `cursorAgentPath` on `AgentProviderOptions` |
| `lib/agents.ts` | Any leftover `CURSOR_RUNTIMES`, `CursorRuntime`, runtime helpers, CLI `modelsNote` |
| `lib/config.ts` | `cursorRuntime` on options types and `resolveHarnessOptions` |
| `lib/schemas.ts` | `agents.cursor.runtime` field |
| `lib/workflow-context.ts` | `CursorRuntime` import, `cursorRuntime` / `cursorAgentPath` options, `resolvedCursorRuntimeMeta` |
| `bin/harness.ts` | `HarnessCliOptions.runtime` / `cursorWrapper`, `parseCursorRuntime`, `--runtime` help text |
| `providers/cursor/cursor-sdk-agent.ts` | Error text `For Cursor CLI model IDs, use --runtime cli.` → SDK-only supported-models message |
| `providers/cursor/cursor-sdk-agent.test.ts` | Matching assertion for updated error text |

Confirm `providers/cursor/lib/` contains only `schema.ts` (+ `schema.test.ts`) — no orphaned CLI lib files.

#### 7b. Harness tests — delete or rewrite stale cases

| File | Action |
|------|--------|
| `test/cursor-agent.test.ts` | Delete (file removed in Step 4) |
| `test/cli.test.ts` | Remove help expectations for `--runtime` / `--cursor-wrapper`; delete CLI-runtime spawn tests |
| `test/config.test.ts` | Remove `cursorRuntime` override tests; add rejection test if `runtime` removed from schema |
| `test/agent-provider.test.ts` | Remove CLI path test; Cursor always SDK |
| `test/workflow-context.test.ts` | No `cursorRuntime` / `cursorAgentPath` in options or `meta.agent.runtime` assertions |
| `test/install.test.ts` | No `cursor-cli` (Step 5) |

#### 7c. Documentation — harness vs skill boundary

| Artifact | Update |
|----------|--------|
| `README.md` | Drop `--runtime sdk` optional wording; remove `agents.cursor.runtime` from JSON examples; remove legacy CLI review runtime; document `skills/cursor-cli/` + `cursor-cli` for ad-hoc delegation |
| `harness.json` (repo root) | Remove `agents.cursor.runtime` if field deleted from schema |
| `AGENTS.md` | If it mentions harness-installed `cursor-cli` or review `--runtime`, align with SDK-only reviews + skill launcher |
| `dev/plans/README.md` | Mark Phase E ✅ after land; update “Doc refresh after Phase E” table (cursor-cli → migrated into skill, not “keep/archive/split”) |
| `dev/plans/260621-agent-harness-handoff.md` | Runtime table: Cursor = SDK only; remove `cli` row and `--runtime cli` example; note ad-hoc launcher is `cursor-cli` under `skills/cursor-cli/` |
| This plan | Status → completed; check done criteria |

**Archived plans** (`dev/plans/260626-*.md`, etc.): leave historical mentions; do not rewrite unless an active link breaks.

#### 7d. Skills — update both `skills/` and `.agents/skills/` mirrors

| Skill | Update |
|-------|--------|
| `skills/change-review-workflow/SKILL.md` | SDK-only; remove `--runtime cli` / `--cursor-wrapper` / legacy diagnostics exception |
| `.agents/skills/change-review-workflow/SKILL.md` | Same as above |
| `skills/cursor-cli/SKILL.md` | Standalone install (`scripts/install.sh` or `node …/cursor-cli.ts`); no harness `install` or `providers/cursor/` paths; scope = ad-hoc delegation outside harness |
| `skills/cursor-cli/agents/openai.yaml` | Note skill-local `cursor-cli`; not part of `harness run` |

**Do not** remove the `cursor-cli` launcher binary from the skill — only decouple it from harness.

#### 7g. Standalone `cursor-cli` end-to-end check

Confirm the skill works **after** full harness decoupling:

```bash
pnpm test -- skills/cursor-cli
node skills/cursor-cli/scripts/cursor-cli.ts --help
BIN_DIR="$(mktemp -d)" CURSOR_CLI_INSTALL_BIN="$BIN_DIR" skills/cursor-cli/scripts/install.sh
"$BIN_DIR/cursor-cli" --help
rg -n "providers/cursor/cursor-agent|lib/cursor-agent|from ['\"].*\.\./\.\./(lib|providers|bin)" skills/cursor-cli
```

Expected: tests pass; both direct `node` and installed symlink show `Usage: cursor-cli`; last `rg` → no matches.

Other agents can invoke Cursor by calling `cursor-cli` (installed from the skill) or `node <path-to-skill>/scripts/cursor-cli.ts` — no harness binary required.

#### 7e. Tooling

| File | Check |
|------|-------|
| `vitest.config.ts` | Includes `skills/cursor-cli/**/*.test.ts`; no include paths pointing at deleted `providers/cursor/cursor-agent.test.ts` |
| `tsconfig.json` / build | No references to deleted CLI entrypoints in dist layout |

#### 7f. Verification commands

```bash
# Harness: no review-runtime CLI surface
rg -n "createCursorAgent|CURSOR_RUNTIMES|CursorRuntime|isCursorSdkRuntime|effectiveCursorRuntime|cursorRuntime|cursorAgentPath|DEFAULT_CURSOR_RUNTIME|providers/cursor/cursor-agent" lib bin providers test install

# Harness docs/skills (excludes cursor-cli skill and archived plans)
rg -n "--runtime|--cursor-wrapper|--cursor-agent|CURSOR_CLI_EXECUTABLE|providers/cursor/cursor-agent" README.md AGENTS.md harness.json skills/change-review-workflow .agents/skills/change-review-workflow install test

# Retired launcher name (exempt archived plans under dev/plans/)
rg -n "harness-cursor" --glob '!dev/plans/**' .

# Skill owns cursor-cli launcher
rg -n "LAUNCHER_COMMAND|Usage: cursor-cli" skills/cursor-cli
```

Expected:

- First two `rg` → **no matches** (or only this plan file while pending).
- Third `rg` → **no matches** (old `harness-cursor` name fully retired).
- Fourth `rg` → matches under `skills/cursor-cli/` only.

Note: `README.md` may mention the `cursor-cli` **skill** by name — that is fine. The check targets the retired `harness-cursor` binary name, not the skill directory.

**Verify**: Step 7f `rg` sweeps **and** Step 7g standalone check pass before Step 8.

### Step 8: Full verification

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run format:check
```

Expected: all exit 0.

## Test plan

- Skill tests prove migrated `cursor-cli` works standalone under `skills/cursor-cli/` (direct `node`, skill `install.sh`, no harness imports).
- Step 4 re-smoke: standalone skill still passes after harness CLI files deleted.
- CLI tests prove harness no longer exposes runtime/wrapper flags for reviews.
- Agent-provider tests prove Cursor uses SDK without runtime branching.
- Config tests prove `harness.json` cannot force Cursor CLI for reviews.
- Install tests prove only `harness` shim is installed.
- Workflow-context tests use provider mocks, not fake wrapper scripts.
- Step 7 `rg` sweeps pass (harness clean; `cursor-cli` only under `skills/cursor-cli/`).
- Full test suite passes after deleting harness CLI-runtime tests.

## Done criteria

- [ ] `provider: "cursor"` always creates Cursor SDK provider for reviews.
- [ ] `--runtime`, `--cursor-wrapper`, and `--cursor-agent` are removed from harness (no review-runtime CLI).
- [ ] `lib/cursor-agent.ts` and harness `providers/cursor/cursor-agent.ts` (+ CLI-only lib) are deleted; code lives under `skills/cursor-cli/`.
- [ ] Launcher renamed to `cursor-cli` (`scripts/cursor-cli.ts`, `LAUNCHER_COMMAND`, install symlink); no `harness-cursor` remains outside archived plans.
- [ ] Tests no longer rely on fake `cursor-cli` wrapper scripts for **harness workflow** coverage.
- [ ] Step 7 cleanup complete: no dead runtime types, SDK error strings, or doc examples referencing harness CLI review path.
- [ ] `skills/change-review-workflow` and `.agents/skills/change-review-workflow` are SDK-only (no legacy CLI exception).
- [ ] `skills/cursor-cli/` is self-contained: runs via `node skills/cursor-cli/scripts/cursor-cli.ts` and skill `install.sh` without harness `install` or harness provider imports.
- [ ] Step 7g standalone end-to-end check passes (direct invoke + symlink install).
- [ ] `README.md`, `harness.json`, handoff, and `dev/plans/README.md` Phase E rows updated.
- [ ] Step 7f `rg` sweeps pass.
- [ ] `pnpm run typecheck`, `pnpm test`, `pnpm run lint`, and `pnpm run format:check` pass.
- [ ] This plan status + `dev/plans/README.md` active queue updated.

## STOP conditions

Stop and report if:

- Cursor SDK cannot cover a review capability that currently only works through harness CLI review runtime.
- The removal would require changing review output schemas or prompt contracts.
- Migrating launcher code into the skill breaks vitest/tsconfig path resolution in a way that cannot be fixed without restructuring the repo.
- **Standalone check fails:** `cursor-cli` only works when harness CLI paths still exist (skill must not depend on deleted `providers/cursor/cursor-agent.ts` or `lib/cursor-agent.ts`).

## Maintenance notes

- Dependencies satisfied: SDK stream logs (#34) and SDK abort (#36) shipped before this plan.
- Keep archived plan files for historical context, but remove active implementation references to harness CLI review runtime.
- After this plan lands, harness provider work targets only `providers/cursor/cursor-sdk-agent.ts` and `providers/codex/codex-agent.ts`.
- `skills/cursor-cli/lib/schema.ts` may drift from `providers/cursor/lib/schema.ts`; reconcile manually if parse behavior changes in SDK.
- `package.json` `files` already ships `skills/` — consumers get `cursor-cli` with the repo/npm package, but it is not wired into `harness run` or `bin`.
