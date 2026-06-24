# Plan 260624-runs-prune-command: Add run artifact pruning to the CLI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx

## Why this matters

Harness writes review artifacts into each target repo under
`.harness/runs/reviews/<run-id>/`. Those artifacts are useful for debugging, but
they include rendered prompts, diffs, review JSON, and summaries, so they should
not accumulate forever. The current code only removes incomplete pre-metadata run
directories during workflow setup failures. Users need an explicit CLI command to
inspect what would be removed, then prune old local run artifacts by age.

## Current state

- `bin/harness.ts` - Commander CLI entrypoint. It currently exposes `init` and
  `run review` / `run review-full`.
- `lib/workflow-context.ts` - creates run directories and writes run metadata.
- `lib/context.ts` - creates timestamp-prefixed run ids.
- `test/runs.test.ts` - create; direct unit coverage for prune parsing, cutoff,
  symlink, and filesystem safety.
- `test/cli.test.ts` - spawns `node bin/harness.ts ...` and checks CLI status,
  stdout JSON, stderr, command help, and high-level artifact effects.
- `README.md` - documents user-facing CLI behavior.
- `dev/plans/README.md` - plan index. Preserve existing rows; this work is only
  adding one row for this plan.

Current CLI shape:

```ts
// bin/harness.ts:37-70
function buildProgram(): Command {
  const program = new Command();
  program.name("harness").description("Agent workflow harness").showHelpAfterError().exitOverride();
  program.action(() => {
    program.outputHelp();
    process.exitCode = 1;
  });

  program
    .command("init")
    .description("Create harness.json and ignore harness artifacts")
    .option("--workspace <path>", "target repo (default: nearest harness.json or Git root)")
    .option("--base <ref>", "base ref for new harness.json (default: main)")
    .action((options: InitOptions) => {
      const result = initHarnessConfig({
        workspace: options.workspace,
        baseRef: options.base,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  const run = program.command("run").description("Run a harness workflow");
  addReviewCommand(run, {
    name: "review",
    description: "Run implementation and code-quality reviewers",
    workflow: runReview,
  });
  addReviewCommand(run, {
    name: "review-full",
    description: "Run implementation, code-quality, and simplify reviewers",
    workflow: runReviewFull,
  });

  return program;
}
```

Current run directory creation:

```ts
// lib/workflow-context.ts:111-113
const startedAt = new Date();
const runId = buildRunId(startedAt);
const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/reviews")), runId);
```

Current metadata behavior:

```ts
// lib/workflow-context.ts:248
writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

// lib/workflow-context.ts:280
writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

// lib/workflow-context.ts:433-440
export function cleanupOrphanedRunDir(runDir: string): boolean {
  if (existsSync(join(runDir, "meta.json"))) {
    return false;
  }

  rmSync(runDir, { recursive: true, force: true });
  return true;
}
```

Current run id format:

```ts
// lib/context.ts:30-33
export function buildRunId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
```

Important current metadata detail: completed and failed runs include
`startedAt`, but dry-run metadata currently does not. The prune logic must
therefore use `meta.startedAt` when present and fall back to the timestamp in
the run directory name.

Local evidence from this checkout on 2026-06-24:

```text
find ./.harness/runs/reviews -mindepth 1 -maxdepth 1 -type d | wc -l
# 91

du -sh ./.harness/runs
# 3.2M
```

Repo conventions to match:

- TypeScript ESM source imports use `.ts` extensions, for example
  `import { createWorkflowContext } from "../lib/workflow-context.ts";`.
- CLI actions print pretty JSON to stdout with `JSON.stringify(result, null, 2)`.
- Commander parse/user errors exit 2 through `CommanderError`; runtime errors
  print to stderr and exit 1.
- Tests in `test/cli.test.ts` use `spawnSync(process.execPath, [HARNESS_BIN,
  ...args])`, temporary directories from `mkdtempSync`, and direct file-system
  assertions.
- Full local gate is `pnpm check`; CI runs `pnpm check:ci`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0, lockfile unchanged unless dependencies are intentionally changed |
| Focused tests | `pnpm test -- test/runs.test.ts test/cli.test.ts` | exit 0, all run-prune and CLI tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no TypeScript errors |
| Full gate | `pnpm check` | exit 0; format, lint, typecheck, tests, build, smoke pass |

Do not add dependencies for this work. Use Node `fs`, `path`, and `Date`.

## Suggested executor toolkit

| Skill | Use it for |
|---|---|
| `implement-plan` | Execute this plan phase by phase and update this file's checkboxes/status if that is the active workflow. |
| `node` | Implement filesystem traversal/deletion and Node TypeScript code using erasable syntax and `.ts` imports. |
| `typescript-refactor` | Keep exported types and parser helpers type-safe; avoid unsafe casts while parsing metadata and dates. |
| `vitest` | Add focused CLI regression tests with isolated temporary directories and specific assertions. |

Verified skill files:

- `skills/implement-plan/SKILL.md`
- `.agents/skills/node/SKILL.md`
- `.agents/skills/typescript-refactor/SKILL.md`
- `.agents/skills/vitest/SKILL.md`

## Scope

**In scope** (the only files you should modify):

- `bin/harness.ts`
- `lib/runs.ts` (create)
- `test/runs.test.ts` (create)
- `test/cli.test.ts`
- `README.md`
- `dev/plans/260624-runs-prune-command.md`
- `dev/plans/README.md`

**Out of scope** (do NOT touch):

- `lib/workflow-context.ts` run layout or metadata shape, except do not touch it
  at all unless a compile error proves a shared type must move.
- `lib/context.ts` run id generation.
- Existing review workflow behavior.
- SQLite, run dashboards, cross-workspace indexing, or archive/export features.
- Automatic retention after each run.
- Deleting anything outside the selected direct child directories under the
  chosen runs directory.

## Desired CLI behavior

Add a new noun command:

```bash
harness runs prune --older-than 7d
harness runs prune --older-than 7d --dry-run
harness runs prune --workspace /path/to/repo --older-than 30d
harness runs prune --runs-dir /tmp/harness-runs --older-than 24h
```

Options:

- `--workspace <path>`: target repo. Same resolution semantics as current CLI
  commands when omitted and `--runs-dir` is also omitted: nearest
  `harness.json`, else current Git root.
- `--runs-dir <path>`: override the runs root. Default:
  `<workspace>/.harness/runs/reviews`. When this is provided without
  `--workspace`, the command may run outside a Git/harness workspace; use
  `process.cwd()` only as the `workspace` value in JSON output.
- `--older-than <duration>`: required positive duration. Accept only:
  - integer days: `7d`, `30d`
  - integer hours: `24h`, `72h`
- `--dry-run`: report matches without deletion.

Output JSON shape:

```json
{
  "workspace": "/abs/path/to/repo",
  "runsDir": "/abs/path/to/repo/.harness/runs/reviews",
  "dryRun": true,
  "olderThanMs": 604800000,
  "cutoff": "2026-06-17T00:00:00.000Z",
  "matched": 1,
  "deleted": 0,
  "kept": 4,
  "skipped": 1,
  "runs": [
    {
      "runId": "20260601-120000-aaaaaa",
      "path": "/abs/path/to/repo/.harness/runs/reviews/20260601-120000-aaaaaa",
      "startedAt": "2026-06-01T12:00:00.000Z",
      "status": "completed",
      "deleted": false
    }
  ]
}
```

Rules:

- Missing runs directory is not an error. Return zero counts and `runs: []`.
- Only inspect direct child directories of `runsDir`.
- Do not follow symlinks. Use `lstatSync()` on each direct child path and skip
  entries where `isSymbolicLink()` is true before checking `isDirectory()`.
  Plain files and other non-directories also increment `skipped`.
- Determine run age in this order:
  1. parse `meta.json.startedAt` when present and valid
  2. parse timestamp prefix from run id, e.g. `20260624-032137-4fa9a9`
  3. if neither exists, skip the entry and increment `skipped`
- `matched` means "would delete because the run is older than the cutoff".
- `runs` lists only matched candidates, not kept or skipped entries.
- Include dry-run matched candidates in `runs` with `deleted: false`.
- Include deleted candidates in `runs` with `deleted: true`.
- Do not delete runs whose age is exactly equal to the cutoff. Delete only when
  `startedAt < cutoff`.
- Sort returned `runs` by `startedAt` ascending for deterministic output.

## Steps

### Step 1: Add run pruning helpers

Create `lib/runs.ts`.

Implement exported functions and types with explicit return types:

- `parseRetentionDuration(value: string): number`
  - trims/lowercases input
  - accepts only `^\d+d$` and `^\d+h$`
  - parses the numeric prefix and rejects values less than or equal to zero
  - returns milliseconds
  - throws `InvalidArgumentError` from `commander` with a clear message for bad
    input, so CLI parse errors exit 2
- `pruneRuns(options: PruneRunsOptions): PruneRunsResult`
  - resolves `runsDir`
  - computes `cutoff` from an injectable `now?: Date` for tests
  - scans direct children only
  - skips symlinks/non-directories/unknown date entries
  - deletes selected directories with `rmSync(path, { recursive: true, force:
    true })` only when `dryRun` is false

Use these type names unless a better local type fit emerges:

```ts
export type PruneRunsOptions = {
  workspace: string;
  runsDir?: string;
  olderThanMs: number;
  dryRun: boolean;
  now?: Date;
};

export type PrunedRun = {
  runId: string;
  path: string;
  startedAt: string;
  status?: string;
  deleted: boolean;
};

export type PruneRunsResult = {
  workspace: string;
  runsDir: string;
  dryRun: boolean;
  olderThanMs: number;
  cutoff: string;
  matched: number;
  deleted: number;
  kept: number;
  skipped: number;
  runs: PrunedRun[];
};
```

Implementation notes:

- Use `readdirSync(runsDir)` plus `lstatSync(join(runsDir, entry))` before any
  directory check. Do not rely on `Dirent.isDirectory()` alone for symlink
  safety.
- Resolve the effective runs directory exactly once:
  `const runsDir = resolve(options.runsDir ?? join(workspace, ".harness/runs/reviews"));`.
- Use a small helper to parse run id timestamps. The timestamp is UTC because
  `buildRunId()` starts from `date.toISOString()`.
- Parse metadata defensively: invalid JSON or non-object metadata should not
  crash pruning. Fall back to run id timestamp. If that also fails, skip.
- Count `kept` as known-date run directories that were not old enough.
- Count `skipped` as direct entries that are not eligible for age comparison.

**Verify**: `pnpm typecheck` -> exit 0, no TypeScript errors.

### Step 2: Wire `harness runs prune`

Edit `bin/harness.ts`.

Add imports from `../lib/runs.ts`:

```ts
import { parseRetentionDuration, pruneRuns } from "../lib/runs.ts";
```

Add an option type:

```ts
type RunsPruneOptions = {
  workspace?: string;
  runsDir?: string;
  olderThan: number;
  dryRun: boolean;
};
```

Add the command in `buildProgram()` after the `run` command setup:

```ts
const runs = program.command("runs").description("Manage harness run artifacts");
runs
  .command("prune")
  .description("Delete old harness run artifacts")
  .option("--workspace <path>", "target repo (default: nearest harness.json or Git root; cwd when only --runs-dir is set)")
  .option("--runs-dir <path>", "runs root (default: <workspace>/.harness/runs/reviews)")
  .requiredOption("--older-than <duration>", "delete runs older than a duration, e.g. 7d or 24h", parseRetentionDuration)
  .option("--dry-run", "show what would be deleted without deleting", false)
  .action((options: RunsPruneOptions) => {
    const workspace =
      (options.workspace || !options.runsDir)
        ? resolveHarnessOptions({ workspace: options.workspace }).workspace
        : resolve(process.cwd());
    const result = pruneRuns({
      workspace,
      runsDir: options.runsDir,
      olderThanMs: options.olderThan,
      dryRun: options.dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
  });
```

Also import `resolve` from `node:path` in `bin/harness.ts`. If TypeScript rejects
the `olderThan` type because of Commander inference, adjust the local
`RunsPruneOptions` type only. Do not introduce broad `any`.

**Verify**: `node bin/harness.ts runs prune --help` -> exit 0 and help mentions
`--older-than`, `--dry-run`, `--runs-dir`, and `--workspace`.

### Step 3: Add unit tests for pruning logic

Create `test/runs.test.ts`.

Cover pure/helper behavior here instead of pushing all cases through spawn-based
CLI tests:

1. `parseRetentionDuration accepts day and hour shorthand`
   - assert `7d` -> `7 * 24 * 60 * 60 * 1000`
   - assert `24h` -> `24 * 60 * 60 * 1000`

2. `parseRetentionDuration rejects unsupported duration forms`
   - reject `soon`, `7 days`, `0d`, `1.5d`, `-1d`
   - assert the thrown error message mentions invalid duration

3. `pruneRuns dry-run reports old runs without deleting`
   - create temporary `runsDir`
   - use fixed `now: new Date("2026-06-24T00:00:00.000Z")`
   - create old and recent run dirs with `meta.json.startedAt`
   - assert old is matched, not deleted; recent is kept

4. `pruneRuns deletes only runs older than cutoff`
   - same fixed `now`
   - assert old run is removed, recent run remains

5. `pruneRuns keeps runs at the exact cutoff`
   - with `olderThanMs` for 7 days and fixed now, create
     `startedAt: "2026-06-17T00:00:00.000Z"`
   - assert `matched` is 0 and `kept` is 1

6. `pruneRuns falls back to run id timestamp`
   - create `20200101-000000-aaaaaa` without `meta.json`
   - assert it is matched/deleted when old

7. `pruneRuns skips symlink children`
   - create a real directory outside `runsDir`
   - create a symlink child inside `runsDir` pointing at that directory
   - assert `skipped` increments, symlink remains, target remains
   - skip this test only when the platform cannot create symlinks; do not weaken
     implementation behavior

8. `pruneRuns treats missing runs dir as empty`
   - pass a non-existent `runsDir`
   - assert zero counts and `runs: []`

9. `pruneRuns skips unknown direct child directories and files`
   - create `runsDir/notes/`
   - create `runsDir/.gitkeep`
   - assert `skipped` is at least 2, both entries still exist, and `matched` is 0

**Verify**: `pnpm test -- test/runs.test.ts` -> exit 0, all run-prune unit tests
pass.

### Step 4: Add CLI regression tests

Edit `test/cli.test.ts`.

Add helper functions near existing test helpers if they keep the tests concise:

- `writeRun(runsDir, runId, meta?)`
- `readJson(stdout)`

Keep helpers local to `test/cli.test.ts`; do not create shared test utility files
for this narrow command.

Add tests:

1. `harness runs prune help exits cleanly`
   - command: `runHarness(["runs", "prune", "--help"])`
   - assert status 0 and help contains `harness runs prune`, `--older-than`,
     `--dry-run`

2. `harness runs help exits cleanly`
   - command: `runHarness(["runs", "--help"])`
   - assert status 0 and help contains `prune`

3. `harness root help includes runs`
   - extend existing root help test to assert `runs`

4. `harness runs prune dry-run reports old runs without deleting`
   - create git workspace
   - create explicit `runsDir`
   - create an old run directory with `meta.json` containing
     `{ "status": "completed", "startedAt": "2026-01-01T00:00:00.000Z" }`
   - create a recent run directory with `startedAt` near now
   - run `runs prune --workspace <workspace> --runs-dir <runsDir>
     --older-than 7d --dry-run`
   - assert status 0
   - assert JSON `matched` is 1, `deleted` is 0, `kept` is 1
   - assert both directories still exist

5. `harness runs prune deletes old runs`
   - same setup, but omit `--dry-run`
   - assert old directory removed, recent directory still exists
   - assert JSON `matched` is 1, `deleted` is 1

6. `harness runs prune treats missing runs dir as empty`
   - pass a non-existent `--runs-dir`
   - assert status 0 and zero counts

7. `harness runs prune rejects invalid durations`
   - command: `runs prune --older-than soon`
   - assert status 2 and stderr mentions invalid duration

8. `harness runs prune accepts explicit runs-dir outside a workspace`
   - create a temporary directory that is not a Git repo and has no
     `harness.json`
   - run from that cwd with `--runs-dir <runsDir> --older-than 7d --dry-run`
   - assert status 0 and JSON `workspace` equals that cwd

Use existing tests around lines 115-175 as the pattern for help and invalid
option behavior. Use existing tests around lines 177-348 as the pattern for JSON
stdout parsing and temp directories.

Potential time stability issue: tests that compare to the current date should
use obviously old dates like 2020-01-01 and recent dates far in the future only
if the implementation permits. Prefer real old dates plus current `new Date()`
metadata generated in the test for kept entries.

**Verify**: `pnpm test -- test/cli.test.ts` -> exit 0, all CLI tests pass,
including the new prune wiring tests.

### Step 5: Document the command

Edit `README.md`.

Add a concise paragraph near the existing artifact explanation around line 26:

````md
Prune old local run artifacts explicitly when they are no longer useful:

```bash
node dist/bin/harness.js runs prune --older-than 30d --dry-run
node dist/bin/harness.js runs prune --older-than 30d
```

The command targets `<workspace>/.harness/runs/reviews` by default and prints JSON
with matched/deleted counts.
````

Avoid a long retention policy discussion. Keep automatic cleanup and config
retention out of the README because they are not part of this plan.

**Verify**: `pnpm run format:check` -> exit 0.

### Step 6: Run the full gate and update plan status

Run the full local gate:

```bash
pnpm check
```

Expected: exit 0.

If the command fails only because formatting is needed, run:

```bash
pnpm run format
pnpm check
```

Then update this plan:

- Change this plan's status row in `dev/plans/README.md` from `todo` to `done`.
- If using `implement-plan`, mark completed step checkboxes in this file if
  checkboxes were added during execution. Do not edit unrelated plan rows.

**Verify**: `git diff -- dev/plans/README.md dev/plans/260624-runs-prune-command.md`
-> only this plan's status and intended implementation notes changed.

## Test plan

New unit tests go in `test/runs.test.ts`. New CLI wiring tests go in
`test/cli.test.ts`, using the existing `runHarness()` and `createGitWorkspace()`
patterns.

Required coverage:

- Help output for `harness runs prune`.
- Invalid duration exits 2.
- Missing runs directory exits 0 with zero counts.
- Dry-run reports but does not delete.
- Non-dry-run deletes old run dirs.
- Recent runs are kept.
- Exact cutoff equality keeps the run.
- Run id timestamp fallback handles dry-run/orphan-style dirs without metadata.
- Unknown direct child entries are skipped, not deleted.
- Symlink children are skipped and never traversed/deleted.
- Explicit `--runs-dir` works outside a Git/harness workspace.
- Root and `runs` help expose the new command.

Verification:

```bash
pnpm test -- test/runs.test.ts test/cli.test.ts
pnpm check
```

Both must exit 0.

## Done criteria

All must hold:

- [x] `harness runs prune --help` exits 0 and documents `--older-than`,
  `--dry-run`, `--runs-dir`, and `--workspace`.
- [x] `harness runs prune --older-than 7d --dry-run` prints JSON and deletes
  nothing.
- [x] `harness runs prune --older-than 7d` deletes only direct child run
  directories older than the cutoff.
- [x] Invalid durations exit 2 with a clear Commander parse error.
- [x] Missing runs directory exits 0 with zero counts.
- [x] Symlink children are skipped and not traversed or deleted.
- [x] Runs at exactly the cutoff are kept.
- [x] Explicit `--runs-dir` works outside a Git/harness workspace.
- [x] New unit tests cover duration parsing, dry-run, deletion, missing dir,
  cutoff equality, symlink skipping, run-id timestamp fallback, and skipped
  unknown entries.
- [x] New CLI tests cover help, invalid duration, dry-run/delete wiring, missing
  dir, root command discoverability, and explicit `--runs-dir` outside a
  workspace.
- [x] `pnpm test -- test/runs.test.ts test/cli.test.ts` exits 0.
- [x] `pnpm check` exits 0.
- [x] `README.md` documents the command.
- [x] `dev/plans/README.md` includes this plan and preserves unrelated rows.

## STOP conditions

Stop and report back if:

- `bin/harness.ts` no longer uses Commander or no longer has `buildProgram()`.
- Run directories are no longer direct children of
  `<workspace>/.harness/runs/reviews`.
- `buildRunId()` format changed from `YYYYMMDD-HHMMSS-hex`.
- Implementing safe workspace resolution requires changing `lib/config.ts`
  public behavior.
- A test requires deleting files outside a temporary directory or outside
  `.harness/runs/reviews`.
- The implementation appears to need a database, background job, config
  retention policy, or workflow metadata migration.

## Maintenance notes

- Future `harness runs list` or dashboard work should reuse `lib/runs.ts`
  scanning/date parsing instead of duplicating filesystem logic.
- If automatic retention is added later, make it opt-in config and call the same
  pruning helper with explicit dry-run-disabled semantics.
- If run metadata changes, keep pruning tolerant: `meta.json` is useful when
  valid but the timestamped run id remains the compatibility fallback.
- Deferred follow-up: adding `startedAt: startedAt.toISOString()` to dry-run
  metadata in `lib/workflow-context.ts` would reduce fallback use, but it is not
  required for this command because run-id timestamp parsing remains necessary
  for metadata-free dirs.
- Reviewers should scrutinize deletion safety: direct children only, no symlink
  traversal, deterministic cutoff comparison, and no default deletion without an
  explicit `--older-than`.
