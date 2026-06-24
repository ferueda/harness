# Plan 260624-user-level-install: Add a source-checkout user install command

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx

## Why this matters

The intended install model is now: clone `harness` anywhere on the user's
machine, run one installer from that checkout, then use `harness` as the normal
CLI command. The repo already supports source-mode execution with Node 24 type
stripping (`node bin/harness.ts`) and target-repo initialization (`harness
init`). What is missing is the one-command user-level install layer that writes a
stable `harness` command without npm publishing, releases, global packages, or
requiring the checkout to live at `~/.harness`.

## Current state

Relevant files:

- `bin/harness.ts` — CLI entrypoint; source-mode execution is already used by
  tests and local development.
- `lib/config.ts` — `harness init` creates target-repo `harness.json`,
  `.gitignore`, and an ignored `.harness/bin/harness` shim.
- `test/cli.test.ts` — existing CLI integration tests run `node bin/harness.ts`
  directly and verify init/shim behavior.
- `README.md` — currently shows development/bootstrap commands but does not
  document a root `install` command. It also has a later `## Installation`
  section that shows `npx skills add ferueda/harness`; that is a skills-host
  installation path, not the harness CLI install model this plan is adding.
- `package.json` / `Makefile` — define Node 24 requirement and verification
  gates.

Current CLI entrypoint pattern (`bin/harness.ts:51-93`):

```ts
const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;
const HARNESS_ENTRYPOINT = fileURLToPath(import.meta.url);

program
  .command("init")
  .description("Create harness.json, ignore artifacts, and write a local shim")
  .option("--workspace <path>", "target repo (default: nearest harness.json or Git root)")
  .option("--base <ref>", "base ref for new harness.json (default: main)")
  .action((options: InitOptions) => {
    const result = initHarnessConfig({
      workspace: options.workspace,
      baseRef: options.base,
      harnessEntrypoint: HARNESS_ENTRYPOINT,
    });
    console.log(JSON.stringify(result, null, 2));
  });
```

Current target-repo init/shim contract (`lib/config.ts:6-9`, `71-95`,
`209-215`):

```ts
export const HARNESS_GITIGNORE_ENTRY = ".harness/";
export const HARNESS_SHIM_RELATIVE_PATH = ".harness/bin/harness";
export const HARNESS_RECOMMENDED_COMMAND = `${HARNESS_SHIM_RELATIVE_PATH} run review`;

export function initHarnessConfig(
  options: InitHarnessOptions,
  cwd = process.cwd(),
): InitHarnessResult {
  const workspace = resolveHarnessWorkspace(options.workspace, cwd);
  // ...
  const shim = writeHarnessShim(workspace, {
    harnessEntrypoint: resolveRequiredPath("harnessEntrypoint", options.harnessEntrypoint),
    nodePath: resolve(options.nodePath ?? process.execPath),
  });
  const result = {
    workspace,
    configPath,
    gitignorePath,
    shimPath: shim.path,
    recommendedCommand: HARNESS_RECOMMENDED_COMMAND,
    shimUpdated: shim.updated,
    // ...
  };
}

function renderHarnessShim(input: { harnessEntrypoint: string; nodePath: string }): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `exec ${shellQuote(input.nodePath)} ${shellQuote(input.harnessEntrypoint)} "$@"`,
    "",
  ].join("\n");
}
```

Current CLI test pattern (`test/cli.test.ts:20-28`, `146-180`):

```ts
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS_BIN = join(REPO_ROOT, "bin/harness.ts");

function runHarness(args: string[], options: { cwd?: string; input?: string } = {}) {
  return spawnSync(process.execPath, [HARNESS_BIN, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
  });
}

test("harness init creates config through the CLI", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(["init", "--workspace", workspace, "--base", "develop"]);
  expect(result.status).toBe(0);
  // ...
});
```

Current repo commands (`package.json`, `Makefile`):

- `pnpm test` runs Vitest.
- `pnpm typecheck` runs `tsc -p tsconfig.json --noEmit`.
- `pnpm check` runs format check, lint, typecheck, tests, build, and dist smoke.
- `package.json` has `"engines": { "node": ">=24" }`.

Design decisions already made:

- The normal user-facing command should be `harness`, not
  `.harness/bin/harness`.
- The source checkout may live anywhere, not only `~/.harness`.
- The root `install` command should discover its own checkout path and write a
  user-level shim pointing at that absolute path.
- The target-repo `.harness/bin/harness` shim remains useful as a pinned
  fallback for agents/automation, but should not be the happy-path command in
  docs.
- Do not introduce npm publishing, package releases, global package managers, or
  standalone binary packaging in this plan.

## Commands you will need

| Purpose             | Command                                                  | Expected on success |
| ------------------- | -------------------------------------------------------- | ------------------- |
| Install deps        | `pnpm install --frozen-lockfile`                         | exit 0              |
| Format touched code | `pnpm exec oxfmt --write test/install.test.ts README.md` | exit 0              |
| Focused tests       | `pnpm vitest run test/install.test.ts test/cli.test.ts`  | all tests pass      |
| Typecheck           | `pnpm typecheck`                                         | exit 0, no errors   |
| Full gate           | `pnpm check`                                             | exit 0              |

## Suggested executor toolkit

| Step                     | Skill / resource                                    | Why                                                                                        |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| All implementation steps | `implement-plan` (`skills/implement-plan/SKILL.md`) | Execute this plan phase-by-phase and update plan checkboxes/status as work completes.      |
| Step 1 and Step 2        | `node` (`.agents/skills/node/SKILL.md`)             | Keep source-mode Node 24 TypeScript assumptions explicit; avoid introducing build tooling. |
| Step 3                   | `vitest` (`.agents/skills/vitest/SKILL.md`)         | Add isolated installer tests using `spawnSync`, temp directories, and clear assertions.    |
| Final cleanup            | `simplify` (`.agents/skills/simplify/SKILL.md`)     | Optional readability pass on touched harness files before review; do not broaden scope.    |

## Scope

**In scope**:

- `install` (create at repo root; executable shell script)
- `README.md`
- `test/install.test.ts` (create)
- `test/cli.test.ts` only if helper reuse or assertions need a tiny adjustment
- `package.json` only if adding a focused script is clearly useful
- `dev/plans/260624-user-level-install.md`
- `dev/plans/README.md`

**Out of scope**:

- npm publishing, package names, semantic releases, release automation, GitHub
  Packages, or standalone binary packaging.
- A `harness self update` command. Mention it as a deferred follow-up only.
- Moving skills, workflows, or provider code.
- Changing `harness init` output shape or `.harness/bin/harness` behavior unless a
  test proves the install script needs a compatible helper.
- Editing private downstream repo paths or examples into docs.
- Supporting Windows-native `.cmd` launchers. This plan may document POSIX/bash
  support only, matching current shim behavior.

## Steps

### Step 1: Add the root `install` script

Create an executable root file named `install` with a bash shebang:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

Required behavior:

1. Resolve the checkout root from the script location, not from `$PWD`.
   Use `BASH_SOURCE[0]` so this works when the user runs
   `/some/path/harness/install` from another directory:

   ```bash
   ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
   ```

2. Resolve prerequisites:
   - `node` must exist.
   - Resolve the Node binary with `node -p 'process.execPath'`, not just
     `command -v node`, so the shim points at the real executable that is
     running Node rather than a version-manager shim.
   - Node major version must be `>=24`. Prefer a runtime check over parsing
     `node -v`, for example:

     ```bash
     node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 24 ? 0 : 1)'
     ```

   - `pnpm` must exist unless `HARNESS_INSTALL_SKIP_PNPM=1` is set for tests.
     Assign it explicitly with `PNPM="$(command -v pnpm)"` before using
     `"$PNPM" install --frozen-lockfile`.

3. Install dependencies by default:

   ```bash
   (cd "$ROOT" && "$PNPM" install --frozen-lockfile)
   ```

   Keep `HARNESS_INSTALL_SKIP_PNPM=1` as a test-only escape hatch. Document it in
   a comment in the script, not in README.

4. Write the user-level shim:
   - Default bin dir: `${HARNESS_INSTALL_BIN_DIR:-$HOME/.local/bin}`
   - Create the bin dir with `mkdir -p`.
   - Write `$BIN_DIR/harness`.
   - Use absolute paths to the resolved Node binary and checkout source
     entrypoint: `$ROOT/bin/harness.ts`.
   - The generated shim should look like this in shape:

     ```bash
     #!/usr/bin/env bash
     set -euo pipefail
     exec '<absolute-node-path>' '<absolute-checkout-path>/bin/harness.ts' "$@"
     ```

   - Reuse the same single-quote escaping strategy as `lib/config.ts` conceptually:
     replace `'` with `'"'"'` inside generated quoted values. Do this in a small
     `shell_quote()` helper in the bash script.

5. `chmod +x "$BIN_DIR/harness"`.

6. Verify the generated command:

   ```bash
   "$BIN_DIR/harness" --help >/dev/null
   ```

7. Print concise success output:
   - Installed command path.
   - Checkout root.
   - Next commands:

     ```bash
     harness init
     harness run review
     ```

8. If `$BIN_DIR` is not on `$PATH`, print a warning with an exact example:

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   ```

   Define this check as an exact PATH segment match, not a substring check.
   Use a stable warning marker so tests can assert it:

   ```text
   Add this directory to PATH:
   ```

Do not mutate shell startup files (`~/.zshrc`, `~/.bashrc`, etc.).
Track the script executable bit in git; if needed, use:

```bash
git update-index --chmod=+x install
```

**Verify**:

```bash
HARNESS_INSTALL_BIN_DIR="$(mktemp -d)" HARNESS_INSTALL_SKIP_PNPM=1 ./install
```

Expected result: exit 0, output mentions installed command path and checkout
root, and the temp bin dir contains an executable `harness`.

### Step 2: Document the install model in README

Update `README.md` so the top workflow is user-facing and simple:

```bash
git clone git@github.com:ferueda/harness.git ~/.harness
~/.harness/install
harness init
harness run review
```

Also document that any checkout path works:

```bash
git clone git@github.com:ferueda/harness.git ~/dev/harness
~/dev/harness/install
```

Clarify the mental model:

- `harness` is the normal command after install.
- The checkout can live anywhere; rerun `install` if it moves.
- `harness init` configures the target repo.
- Target repo `.harness/bin/harness` is a pinned fallback for agents/automation
  when PATH is unreliable, not the primary command users should type.
- `harness init` still returns
  `recommendedCommand: ".harness/bin/harness run review"` in JSON. Explain that
  this is the target-repo fallback/pinned command for agents and automation; the
  normal user command after root install is `harness run review`.
- Reconcile the later `## Installation` / `npx skills add ferueda/harness`
  section. Reframe it as skills-host installation only, move it under the
  skills section, or otherwise make clear it is not the harness CLI install
  path.
- Separate user installation from harness development. User docs should start
  with clone → `install` → `harness`; development docs can still mention
  `pnpm check`, `node bin/harness.ts`, and `dist/`.
- Updating is:

  ```bash
  cd /path/to/harness-checkout
  git pull
  ./install
  ```

Keep docs generic. Do not add examples with private downstream repo paths.

**Verify**:

```bash
rg "node dist/bin/harness.js run review|\\.harness/bin/harness run review" README.md
```

Expected result: no happy-path examples tell users to prefer
`.harness/bin/harness`; any remaining `.harness/bin/harness` mention is clearly
described as fallback/pinned behavior.

### Step 3: Add installer tests

Create `test/install.test.ts`.

Use existing test style from `test/cli.test.ts`:

- `mkdtempSync(join(tmpdir(), "..."))` for temp dirs.
- `spawnSync` for command execution.
- `readFileSync`, `existsSync`, and `statSync` for filesystem assertions.
- `expect(...).toBe(...)` / `toMatch(...)` for assertions.

Required tests:

1. **`install writes a user-level harness shim`**
   - Create temp bin dir.
   - Run root `install` with:

     ```ts
     env: {
       ...process.env,
       HARNESS_INSTALL_BIN_DIR: binDir,
       HARNESS_INSTALL_SKIP_PNPM: "1",
     }
     ```

   - Assert exit status `0`.
   - Assert `$binDir/harness` exists and has executable bits.
   - Assert shim content contains `bin/harness.ts` and the repo root.
   - Run `spawnSync(join(binDir, "harness"), ["--help"])`.
   - Assert status `0` and stdout contains `Usage: harness`.

2. **`install reports PATH guidance when bin dir is not on PATH`**
   - Use temp bin dir not present in PATH.
   - Run with `HARNESS_INSTALL_SKIP_PNPM=1`.
   - Assert stdout mentions adding the temp bin dir or `PATH`.

3. **`install does not report PATH guidance when bin dir is on PATH`**
   - Run with `PATH` prefixed by the temp bin dir.
   - Assert stdout does not include `Add this directory to PATH:`.

4. **`install works when invoked outside the checkout cwd`**
   - Run `install` with `cwd: tmpdir()`.
   - Assert the generated shim still points at the checkout root, not the cwd.

5. **`install rewrites an existing harness shim idempotently`**
   - Run `install` twice with the same temp bin dir.
   - Assert the second run exits `0` and the generated `harness --help` still
     works.

6. **Optional lightweight quoting assertion**
   - If cheap, use a `HARNESS_INSTALL_BIN_DIR` path containing spaces and a
     single quote and assert the generated command still executes.
   - Do not copy the whole checkout into a synthetic quote-heavy path just for
     this test; the target-repo shim already has deeper quote coverage in
     `test/config.test.ts`.

Optional, only if it stays deterministic:

7. **Prerequisite failure coverage**
   - A negative test for missing `pnpm` or Node `<24` is useful but not required.
   - Do not add brittle PATH shims or fake Node installations if they make the
     installer test harder to maintain than the installer itself.

Do not make tests run `pnpm install`; use `HARNESS_INSTALL_SKIP_PNPM=1`.
Because generated `harness --help` needs this repo's dependencies, add a clear
test comment or setup guard explaining that the test suite assumes
`pnpm install` has already run, same as the existing CLI tests.

**Verify**:

```bash
pnpm vitest run test/install.test.ts
```

Expected result: new installer tests pass.

### Step 4: Integrate with existing CLI/init expectations

Run existing CLI tests to confirm the new user-level install model did not
break target-repo init behavior:

```bash
pnpm vitest run test/install.test.ts test/cli.test.ts
```

Expected result: all tests pass. Existing `test/cli.test.ts` should still verify
that `harness init` writes target repo `.harness/bin/harness`. Do not remove that
behavior.

If the installer test needs a tiny helper shared with `test/cli.test.ts`, keep it
local unless reuse is substantial. Avoid creating a broad test utility module for
one script.

### Step 5: Update the plan index and final status

Confirm `dev/plans/README.md` already includes a row for
`260624-user-level-install.md`. When implementation is complete, update that row
from `done` to `done`.

Update this plan file status during execution if the executor follows
`implement-plan` conventions. Keep the old `260621-agent-harness-handoff.md`
entry; do not rewrite the old handoff in this plan.

**Verify**:

```bash
sed -n '1,80p' dev/plans/README.md
```

Expected result: index includes this plan with accurate status.

## Test plan

New tests:

- `test/install.test.ts`
  - Writes user-level shim to temp bin dir.
  - Executes generated `harness --help`.
  - Verifies PATH warning behavior.
  - Verifies invocation works from outside checkout cwd.
  - Verifies idempotent reinstall.
  - Optionally verifies a simple quote-heavy bin dir path if it stays cheap.

Existing tests to run:

- `test/cli.test.ts`
  - Ensures `harness init` still works and still creates target-repo fallback
    shim.

Full verification:

```bash
pnpm vitest run test/install.test.ts test/cli.test.ts
pnpm typecheck
pnpm check
```

Expected result: all commands exit 0.

## Done criteria

All must hold:

- [x] Root `install` exists, is executable, and has no file extension.
- [x] `install` works from any current working directory.
- [x] `install` writes `${HARNESS_INSTALL_BIN_DIR:-$HOME/.local/bin}/harness`.
- [x] Generated user-level `harness` executes `node <checkout>/bin/harness.ts`.
- [x] Generated user-level `harness --help` exits 0.
- [x] `install` checks Node >=24 and `pnpm`.
- [x] `install` runs `pnpm install --frozen-lockfile` by default.
- [x] `install` supports `HARNESS_INSTALL_BIN_DIR` and
      `HARNESS_INSTALL_SKIP_PNPM=1` for tests.
- [x] `install` uses `node -p 'process.execPath'` for the generated shim's Node
      path.
- [x] PATH warning uses the stable marker `Add this directory to PATH:`.
- [x] README documents clone-anywhere install and normal `harness` usage.
- [x] README clearly treats target `.harness/bin/harness` as fallback/pinned
      behavior, not the primary command.
- [x] README reconciles the existing skills-host `npx skills add` section so it
      does not conflict with the harness CLI install path.
- [x] `pnpm vitest run test/install.test.ts test/cli.test.ts` exits 0.
- [x] `pnpm check` exits 0.
- [x] `dev/plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- Current Node cannot execute `bin/harness.ts` directly with this repo's imports.
  Do not add a build-based installer without discussing the tradeoff first.
- A cross-platform Windows launcher becomes necessary. This plan is POSIX/bash
  only.
- The installer would need to modify user shell startup files automatically.
  Print instructions instead.
- `pnpm install --frozen-lockfile` is not sufficient to prepare the checkout.
- The generated user-level shim cannot support checkout paths containing spaces
  or single quotes with the planned shell quoting.
- Any step requires changing workflow behavior (`review`, `review-full`,
  provider execution, schemas, or artifacts).

## Maintenance notes

- If the checkout moves, users must rerun `/new/path/install`; this is expected
  and should remain documented.
- If `harness self update` is added later, it should probably run `git pull`
  inside the checkout and then re-run the same install logic rather than
  duplicate shim generation.
- If Node type-stripping support changes, revisit the source-mode decision
  before adding build requirements to user install.
- Reviewer focus: shell quoting, PATH guidance, install idempotency, and whether
  docs keep the command model simple (`harness`, not nested paths).
- Keep the installer test matrix small. Required coverage is happy path, cwd
  independence, PATH warning behavior, and idempotent reinstall. Prerequisite
  failure and quote-heavy path tests are useful only when they stay simple.
