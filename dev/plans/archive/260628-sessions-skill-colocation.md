# Plan 260628-sessions-skill-colocation: Move sessions CLI into skills/sessions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: migration | dx | direction
- **Completed**: 2026-06-28

## Why this matters

`sessions` is a standalone CLI for indexing and searching local Cursor/Codex
session history. It is not part of `harness run`, shares no runtime with
workflows or providers, and is not installed by the root `install` script
today. Keeping it in `bin/` + `lib/sessions/` mislabels it as harness-core
infrastructure.

Colocating the CLI under **`skills/sessions/`** (renamed from
`session-evidence`) matches the `cursor-cli` pattern: skill name = tool name,
skill-owned launcher + `install.sh`, agent playbook in `SKILL.md`. Harness
stays focused on workflow execution.

## Current state

**Harness CLI** (`bin/harness.ts`) — workflow runner. Installed by root
`install`.

**Sessions CLI** (`bin/sessions.ts`, ~620 LOC) — Commander entry over
`lib/sessions/` (~26 modules). Commands: `analyze`,
`cursor|codex reindex|list|show|export|stats`.

**Coupling to harness core**: one import — `formatZodError` from
`lib/schemas.ts` in `lib/sessions/core/cache.ts` (inline on move).

**Packaging inconsistency** — `package.json` declares a `sessions` bin but
root `install` only wires `harness`; README uses `node bin/sessions.ts`.

**Cache path**: `~/.sessions/index` (migrated from `~/.harness/session-index` on first use); override `SESSIONS_CACHE_DIR`.

**Skill today** — `skills/session-evidence/` is docs-only (`SKILL.md`,
`references/`, `agents/openai.yaml`). Skill `name:` is `session-evidence`.

**Exemplar**: `skills/cursor-cli/` — `scripts/`, `scripts/install.sh`, `lib/`,
co-located tests, vitest + tsconfig includes.

**Files to move**:

| From | Role |
| ---- | ---- |
| `bin/sessions.ts` | CLI entry |
| `lib/sessions/core`, `cursor`, `codex` | Library (flatten to `skills/sessions/lib/{core,cursor,codex}`) |
| `test/sessions/**` | 21 test files + `helpers.ts` |
| `test/fixtures/sessions/**` | JSONL fixtures |
| `skills/session-evidence/**` | Skill docs → rename dir to `skills/sessions/` |

**Cross-repo references to rename** (`session-evidence` → `sessions`):

- `skills/planning-workflow/SKILL.md` (routing table)
- `skills/planning-workflow/references/routing.md` (fixture #6 wording + audit link)
- `README.md`, `AGENTS.md`
- `skills/session-evidence/agents/openai.yaml` → `skills/sessions/agents/openai.yaml`
- `test/skills.test.ts`
- `test/sessions/core/evidence.test.ts` (embedded path strings in fixtures)

## Commands you will need

| Purpose   | Command | Expected on success |
| --------- | ------- | ------------------- |
| Install   | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests     | `pnpm test` | all pass |
| Lint      | `pnpm lint` | exit 0 |
| Format    | `pnpm format:check` | exit 0 |
| Full gate | `pnpm check` | exit 0 |

## Suggested executor toolkit

| Skill / reference | Use for |
| ----------------- | ------- |
| `implement-plan` | Phase-by-phase execution |
| `.agents/skills/typescript-refactor` | Import paths, `NodeNext` extensions |
| `.agents/skills/vitest` | Co-located tests (`skills/cursor-cli` model) |
| `skills/cursor-cli/scripts/install.sh` | Install script shape |

## Scope

**In scope**:

- Rename `skills/session-evidence/` → `skills/sessions/`; update skill `name:` in frontmatter
- Move CLI, lib (flattened), tests, fixtures into `skills/sessions/`
- `skills/sessions/scripts/install.sh` (required)
- Delete `bin/sessions.ts`, `lib/sessions/`, `test/sessions/`, `test/fixtures/sessions/`
- `package.json`, `tsconfig.json`, `vitest.config.ts`
- `README.md`, `AGENTS.md`, planning-workflow refs, `test/skills.test.ts`
- `dev/plans/README.md`

**Out of scope**:

- `bin/harness.ts`, `workflows/`, `providers/`, harness `lib/` (except delete `lib/sessions/`)
- Root `install` script — sessions uses skill `install.sh` only
- Cache path migration to `~/.sessions/index` with legacy rename
- CLI command rename (`sessions` stays)
- Separate npm package / new repository

## Target layout

```text
skills/sessions/
  SKILL.md                 # name: sessions
  agents/openai.yaml
  references/
  scripts/
    sessions.ts            # from bin/sessions.ts
    install.sh             # symlink ~/.local/bin/sessions
  lib/
    core/                  # from lib/sessions/core/
    cursor/                # from lib/sessions/cursor/
    codex/                 # from lib/sessions/codex/
  test/
    helpers.ts
    cli.test.ts
    core/ cursor/ codex/
  fixtures/
    sessions/              # from test/fixtures/sessions/
```

Internal lib imports (`../core/...` from `cursor/`) stay valid after flatten.

CLI imports change: `../lib/sessions/core/...` → `../lib/core/...`.

## Steps

### Step 1: Rename skill directory

```bash
git mv skills/session-evidence skills/sessions
```

Update **`skills/sessions/SKILL.md`** frontmatter: `name: sessions`. Retitle H1
to `# Sessions` (or `# Sessions CLI`). Refresh `description` trigger phrases for
skill discovery (`sessions analyze`, session history, transcript evidence).

Update **`skills/sessions/agents/openai.yaml`**: `default_prompt` uses
`$sessions` (not `$session-evidence`).

**Verify**: `test -f skills/sessions/SKILL.md && ! test -d skills/session-evidence` → exit 0

### Step 2: Move CLI, lib (flattened), tests, fixtures

```bash
mkdir -p skills/sessions/{scripts,lib,test,fixtures}
git mv bin/sessions.ts skills/sessions/scripts/sessions.ts
git mv lib/sessions/core skills/sessions/lib/core
git mv lib/sessions/cursor skills/sessions/lib/cursor
git mv lib/sessions/codex skills/sessions/lib/codex
rmdir lib/sessions 2>/dev/null || true
git mv test/sessions skills/sessions/test
git mv test/fixtures/sessions skills/sessions/fixtures/sessions
```

**Verify**:

```bash
test -f skills/sessions/scripts/sessions.ts \
  && test -d skills/sessions/lib/core \
  && ! test -d lib/sessions \
  && ! test -f bin/sessions.ts
```

→ exit 0

### Step 3: Fix imports and decouple from harness lib

1. **`skills/sessions/scripts/sessions.ts`** — replace every
   `../lib/sessions/` with `../lib/` (e.g. `../lib/core/cache.ts`).

2. **`skills/sessions/lib/core/cache.ts`** — remove
   `import { formatZodError } from "../../schemas.ts"`. Add local:

   ```ts
   function formatZodError(error: z.ZodError): string {
     return error.issues
       .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
       .join("; ");
   }
   ```

3. **`skills/sessions/lib/core/env.ts`** — rename `harnessRoot` → `skillRoot`;
   replace `resolveHarnessRoot()` with `resolveSkillRoot()` that walks parent
   directories from `core/env.ts` until `SKILL.md` exists (skill root). Drop
   dist/`package.json` repo-root fallback from the old harness resolver — not
   applicable after colocation. `skillRoot` remains on `SessionEnvironment` for
   test overrides only (still unused at runtime).

4. **`skills/sessions/test/helpers.ts`** — imports `../lib/core/...`; rename
   `harnessRoot` → `skillRoot`. Export a shared fixture root:

   ```ts
   export const FIXTURES = join(
     dirname(fileURLToPath(import.meta.url)),
     "../fixtures/sessions",
   );
   ```

5. **All `skills/sessions/test/**`** — update imports:
   - `../../../lib/sessions/` → `../../lib/` (from `test/cursor/`, etc.)
   - `../../lib/sessions/` → `../lib/` (from `test/helpers.ts`)

6. **`skills/sessions/test/codex/rollout.test.ts`** and
   **`skills/sessions/test/cursor/transcript.test.ts`** — remove local
   `FIXTURES` constants; import `FIXTURES` from `../helpers.ts`.

7. **`skills/sessions/test/cli.test.ts`**:

   ```ts
   const SESSIONS_BIN = join(
     dirname(fileURLToPath(import.meta.url)),
     "../scripts/sessions.ts",
   );
   ```

7. **Fixture paths** — use exported `FIXTURES` from `helpers.ts` everywhere;
   do not use `process.cwd()/test/fixtures/...`.

8. **`skills/sessions/fixtures/sessions/cursor-artifact-user.jsonl`** — update
   embedded path `lib/sessions/core/evidence.ts` →
   `skills/sessions/lib/core/evidence.ts` (artifact extraction test alignment).

9. **`skills/sessions/test/core/evidence.test.ts`** — update embedded path
   strings to `skills/sessions/lib/core/evidence.ts`. Transcript fixture strings
   that mention `session-evidence` as branch/plan names (e.g.
   `codex/session-evidence`) may stay — they simulate user transcript content,
   not skill references.

**Verify**: proceed to Step 4 if typecheck fails on missing tsconfig includes.

### Step 4: Wire TypeScript, Vitest, lint, package bins

1. **`tsconfig.json`** — add `"skills/sessions/**/*.ts"` to `include`.

2. **`vitest.config.ts`** — add `"skills/sessions/**/*.test.ts"` to `include`.

3. **`package.json`**:
   - Remove `"sessions": "./dist/bin/sessions.js"` from `bin`.
   - Add `skills/sessions` to `format`, `format:check`, `lint`, and `lint:fix`
     script path lists.

4. Confirm `tsconfig.build.json` does not emit sessions into `dist/`.

**Verify**: `pnpm typecheck && pnpm lint && pnpm format:check` → exit 0

### Step 5: Add install.sh and update skill docs

Create **`skills/sessions/scripts/install.sh`** (mirror `cursor-cli`):

```bash
#!/usr/bin/env bash
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${SESSIONS_INSTALL_BIN:-$HOME/.local/bin}"
ENTRYPOINT="$SKILL_ROOT/scripts/sessions.ts"
mkdir -p "$BIN_DIR"
ln -sf "$ENTRYPOINT" "$BIN_DIR/sessions"
chmod +x "$ENTRYPOINT"
echo "Installed sessions: $BIN_DIR/sessions"
echo "Entrypoint: $ENTRYPOINT"
```

**`skills/sessions/SKILL.md`** — add **Install launcher** section (after intro):
- `skills/sessions/scripts/install.sh` — run from harness checkout after `pnpm install` (needs repo `node_modules` for `commander`/`zod`)
- Manual symlink to `scripts/sessions.ts`
- Note: skill-owned; not `harness run` or root `install`
- Examples use `sessions` on PATH when installed; fallback `node …/scripts/sessions.ts`

Grep **`skills/sessions/references/`** for stale `session-evidence` prose; update
to `sessions` where referring to the skill.

**Verify**:

```bash
chmod +x skills/sessions/scripts/install.sh
node skills/sessions/scripts/sessions.ts --help | head -5
```

→ mentions `sessions` / `Browse local agent sessions`

### Step 6: Update harness docs, planning-workflow, tests

1. **`README.md`** — Session Extraction: `install.sh`, `sessions` command,
   `skills/sessions/SKILL.md`; remove `node bin/sessions.ts`.

2. **`AGENTS.md`** — rename table row `session-evidence` → `sessions`; update paths.

3. **`skills/planning-workflow/SKILL.md`** — routing row: `sessions` (was
   `session-evidence`).

4. **`skills/planning-workflow/references/routing.md`**:
   - Fixture #6: `"Something's wrong with the sessions CLI"` (avoids conflating
     bug reports with the skill)
   - Score section: link `../../sessions/references/audit-examples.md`

5. **`skills/sessions/references/audit-examples.md`** — replace
   `session-evidence` prose with `sessions` where referring to the skill.

6. **`test/skills.test.ts`** — path `skills/sessions/SKILL.md`; assert
   `install.sh` or `Install launcher` present; keep extraction-focus guards.

**Verify**: `pnpm test -- test/skills.test.ts` → pass

### Step 7: Final verification

```bash
pnpm test
pnpm check
! grep -r 'session-evidence' --include='*.ts' --include='*.md' --include='*.yaml' \
  skills/ lib/ bin/ test/ README.md AGENTS.md package.json \
  --exclude-dir=node_modules
! grep -r 'bin/sessions' --include='*.ts' --include='*.md' \
  skills/ lib/ bin/ test/ README.md AGENTS.md \
  --exclude-dir=node_modules
! grep -r 'lib/sessions' --include='*.ts' --include='*.md' --include='*.jsonl' \
  skills/sessions/ README.md AGENTS.md \
  --exclude-dir=node_modules
! test -d lib/sessions
```

Grep scopes exclude `dev/plans/` (active plan mentions old paths) and allow
`session-evidence` inside `skills/sessions/test/` transcript fixture strings.

Update **`dev/plans/README.md`** — mark plan `done`.

## Test plan

- Refactor-only; all moved tests must pass unchanged behavior.
- Model: `skills/cursor-cli/scripts/cursor-cli.test.ts` for co-location.
- `skills/sessions/test/cli.test.ts` spawns `scripts/sessions.ts`.
- `test/skills.test.ts` guards skill shape.

**Verify**: `pnpm test` → exit 0; 20 `*.test.ts` files under `skills/sessions/test/`

## Done criteria

- [x] `skills/sessions/` exists; `skills/session-evidence/` gone
- [x] `skills/sessions/lib/{core,cursor,codex}/` — no nested `lib/sessions/`
- [x] `skills/sessions/scripts/install.sh` executable
- [x] `bin/sessions.ts` and `lib/sessions/` deleted
- [x] `package.json` has no `sessions` bin
- [x] No `session-evidence` skill/dir references in active docs (transcript fixtures in tests exempt)
- [x] `pnpm check` exits 0
- [x] Plan archived; `dev/plans/README.md` updated

## Post-ship documentation audit (2026-06-28)

Verified and updated:

| Area | Changes |
| ---- | ------- |
| `skills/sessions/SKILL.md` | `name: sessions`, install section, cache path |
| `skills/sessions/references/` | audit template title; skill naming |
| `skills/planning-workflow/` | routing → `sessions`; fixture #6 wording |
| `README.md`, `AGENTS.md` | paths, repo shape, skill-owned CLI note |
| `test/skills.test.ts` | stale-path guards for docs + removed directories |
| `dev/plans/archive/260627-*` | footnote: sessions no longer harness `bin/` |
| `dist/` | rebuild removes stale `dist/bin/sessions.js` |

Regression tests: `test/skills.test.ts` (`harness docs do not reference removed sessions harness paths`, `sessions CLI lives under skills/sessions only`).

## STOP conditions

Stop and report if:

- `lib/sessions/core/cache.ts` imports more than `formatZodError` from harness `lib/`.
- Flattening breaks internal imports beyond search-replace (e.g. unexpected `sessions` path segments).
- `pnpm smoke:dist` fails for harness-only reasons unrelated to sessions removal — report before patching smoke-dist.
- Verification fails twice after reasonable fix.

## Maintenance notes

- **Review**: import paths; `import.meta.url` fixtures; planning fixture #6 wording.
- **`harness skills install sessions`**: copies full skill tree to target repos; global CLI still via `install.sh` from harness checkout.
- **Cache**: `~/.sessions/index`; legacy `~/.harness/session-index` auto-migrates.
