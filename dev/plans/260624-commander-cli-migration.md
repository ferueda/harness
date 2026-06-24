# Plan 260624-commander-cli-migration: Migrate harness CLI parsing to Commander

> **Executor instructions**: Follow step by step. Run every verification command before the next step. On any STOP condition, stop and report — do not improvise.

## Status

- **Priority**: P2 | **Effort**: S | **Risk**: MED | **Category**: migration | dx
- **Depends on**: `dev/plans/260624-typescript-oxc-vitest-migration.md` (`done`)

## Why

`bin/harness.ts` hand-rolls parsing. Commander gives a standard command tree, strict options, generated help, and easier tests without touching workflow runtime. Narrow scope: replace parser, preserve command behavior, no CLI redesign.

## Baseline

- ESM Node 24, pnpm, strict TS, Vitest, Oxfmt, Oxlint (`260624-typescript-oxc-vitest-migration` merged).
- Installable bin: `dist/bin/harness.js` → `commander` is a **runtime** dependency.
- Only user-facing CLI: `bin/harness.ts`. `providers/cursor/cursor-agent.ts` parser is out of scope.
- CLI tests: `test/cli.test.ts` (7 cases today).

## Behavior contract

### Preserve

| Behavior | Detail |
|----------|--------|
| Init JSON | `harness init` prints `initHarnessConfig` result |
| Workspace resolution | Nested cwd → nearest Git root |
| Dry-run | `run dual-review --dry-run` → JSON, exit 0 |
| Review exit | Exit 0 only when `verdict === "pass"` or `status === "dry_run"`; else 1 |
| Usage errors | Exit 2 |
| Runtime errors | Message on stderr, exit 1 |
| `--base` defaults | **Not** in Commander — `initHarnessConfig` / `resolveHarnessOptions` own defaults |
| `baseSkipped` | `true` only when config exists **and** `--base` was explicitly passed |

### Accepted changes (do not fight Commander)

| Change | Detail |
|--------|--------|
| Help on usage errors | Commander `showHelpAfterError()` replaces custom `printHelp()` on parse failures. Help text is Commander-generated; option descriptions can be richer via `.option()` strings but need not match old verbatim layout. |
| Unknown-option message | `error: unknown option '--foo'` instead of `Unknown option: --foo` |
| Bare `harness` (no subcommand) | Today: custom help, exit 0. Commander default: help + exit 1. **Keep exit 1** — matches missing-subcommand convention. Do not add a default command. |

## Research notes (2026-06-24)

- `commander@15.0.0` — ESM-only, Node `>=22.12.0`, ships types. Fits this repo.
- Skip `@commander-js/extra-typings` — CLI is small; use local option interfaces.
- Use local `new Command()` + `exitOverride()` + `parseAsync()` (async `dual-review` action).

Refs: [Commander README](https://github.com/tj/commander.js/blob/master/Readme.md), [changelog](https://github.com/tj/commander.js/blob/master/CHANGELOG.md).

## Commands

| Purpose | Command | Success |
|---------|---------|---------|
| Install | `pnpm add commander@15.0.0` | exit 0 |
| Format / lint / typecheck | `pnpm format` / `pnpm lint` / `pnpm typecheck` | exit 0 |
| CLI tests | `pnpm test -- test/cli.test.ts` | exit 0 |
| Full gate | `pnpm check` / `pnpm check:ci` | exit 0, quiet |
| Dist smoke | `pnpm build && pnpm smoke:dist` | exit 0 |

## Skills for the executor

| Skill | Path | Use for |
|-------|------|---------|
| `implement-plan` | `skills/implement-plan/SKILL.md` | Step-by-step execution |
| `node` | `.agents/skills/node/SKILL.md` | ESM / Node 24 CLI |
| `typescript-refactor` | `.agents/skills/typescript-refactor/SKILL.md` | Explicit option types |
| `vitest` | `.agents/skills/vitest/SKILL.md` | CLI test updates |
| `review-implementation` | `skills/review-implementation/SKILL.md` | Post-migration review |

## Scope

**In**: `package.json`, `pnpm-lock.yaml`, `bin/harness.ts`, `test/cli.test.ts`, `scripts/smoke-dist.ts` (only if smoke breaks), `README.md` (only if public examples change), plan files.

**Out**: `cursor-agent.ts` parser, extra-typings, workflow registry, JSON/output/artifact semantics, `harness.json` semantics, publishing, install.sh.

## Steps

### Step 1: Add Commander runtime dependency

```bash
pnpm add commander@15.0.0
```

Confirm `dependencies` has `"commander": "15.0.0"` alongside `zod`. No `@types/commander`, no extra-typings.

**Verify**: `pnpm install --frozen-lockfile` → exit 0.

### Step 2: Replace parser in `bin/harness.ts`

Remove `printHelp`, `parseArgs`, `parseRunArgs`, `parseInitArgs`, `readValue`. Add `buildProgram()` + slim `main()`.

```ts
import { Command, CommanderError, InvalidArgumentError } from "commander";

type InitOptions = { workspace?: string; base?: string };

type DualReviewOptions = {
  workspace?: string;
  base?: string;
  head?: string;
  plan?: string;
  handoff?: string;
  runsDir?: string;
  cursorAgent?: string;
  model?: string;
  maxRuntimeMs: number;
  dryRun: boolean;
};

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive number");
  }
  return parsed;
}

function buildProgram(): Command {
  const program = new Command();
  program.name("harness").description("Agent workflow harness").showHelpAfterError().exitOverride();

  program
    .command("init")
    .description("Create harness.json and ignore harness artifacts")
    .option("--workspace <path>", "target repo (default: nearest harness.json or Git root)")
    .option("--base <ref>", "base ref for new harness.json (default: main)")
    .action((options: InitOptions) => {
      const result = initHarnessConfig({ workspace: options.workspace, baseRef: options.base });
      console.log(JSON.stringify(result, null, 2));
    });

  const run = program.command("run").description("Run a harness workflow");
  run
    .command("dual-review")
    .description("Run implementation and code-quality reviewers")
    .option("--workspace <path>", "target repo")
    .option("--base <ref>", "base ref (default: harness.json base or main)")
    .option("--head <ref>", "head ref (default: HEAD)")
    .option("--plan <path>", "optional plan file")
    .option("--handoff <path>", "optional handoff file")
    .option("--runs-dir <path>", "output root (default: <workspace>/.harness/runs/reviews)")
    .option("--cursor-agent <path>", "cursor-agent entrypoint (auto-detected)")
    .option("--model <id>", "Cursor model override")
    .option("--max-runtime-ms <ms>", "per-reviewer timeout (default: 1800000)", positiveInteger, 30 * 60 * 1000)
    .option("--dry-run", "prepare context and prompts only", false)
    .action(async (options: DualReviewOptions) => {
      const ctx = createWorkflowContext(
        resolveHarnessOptions({
          workspace: options.workspace,
          baseRef: options.base,
          headRef: options.head,
          planPath: options.plan,
          handoffPath: options.handoff,
          runsDir: options.runsDir,
          cursorAgentPath: options.cursorAgent,
          model: options.model,
          maxRuntimeMs: options.maxRuntimeMs,
          dryRun: options.dryRun,
        }),
      );
      const meta = await runDualReview(ctx);
      console.log(JSON.stringify(meta, null, 2));
      process.exitCode = meta.verdict === "pass" || meta.status === "dry_run" ? 0 : 1;
    });

  return program;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exit(error.exitCode === 0 ? 0 : 2);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
```

Key rules:

- Keep shebang; local imports use `.ts` extensions.
- No Commander default for `--base`.
- Map camelCase opts explicitly into `resolveHarnessOptions` / `initHarnessConfig` (do not pass raw Commander opts object).
- `exitOverride()` + map non-zero `CommanderError` → exit 2.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Update `test/cli.test.ts`

Keep existing behavioral tests (init, nested cwd, idempotent, non-git, dry-run). **Update** assertions that depend on hand-rolled messages:

| Test | Change |
|------|--------|
| Unknown flags | Assert exit 2 + `/unknown option.*--unknown/i` on stderr (not `Unknown option:`) |

Add regression tests (model after existing `spawnSync(process.execPath, [HARNESS_BIN, ...])`):

| Case | Args | Expect |
|------|------|--------|
| Root help | `--help` | exit 0; stdout has `Usage: harness`, `init`, `run` |
| Init help | `init --help` | exit 0 |
| Bare invocation | (no args) | exit 1 (accepted change) |
| Missing value | `init --workspace` | exit 2; stderr has missing-argument wording |
| Invalid timeout | `run dual-review --max-runtime-ms 0` | exit 2; stderr has `must be a positive number` |
| Init unknown option | `init --unknown` | exit 2; stderr matches `/unknown option.*--unknown/i` |
| Unknown workflow | `run unknown` | exit 2; stderr has unknown-command wording |
| `baseSkipped` guard | init on workspace with existing `harness.json`, no `--base` | exit 0; JSON `baseSkipped: false` |

Do not assert exact help whitespace — assert exit codes and key substrings only.

**Verify**: `pnpm test -- test/cli.test.ts` → exit 0.

### Step 4: Dist smoke

```bash
pnpm build && pnpm smoke:dist
```

Smoke checks `--help` exit 0 and dry-run JSON. Do not weaken `scripts/smoke-dist.ts` unless Commander breaks those contracts. If smoke fails for other reasons, STOP.

**Verify**: exit 0.

### Step 5: Docs

Skip `README.md` if public examples (`node bin/harness.ts init`, `run dual-review`) are unchanged.

**Verify**: `git diff -- README.md` empty or wording-only.

### Step 6: Gates and plan status

```bash
pnpm check && pnpm check:ci
```

Update checklists here and `dev/plans/README.md` status → `done`.

**Verify**: `git status --short` shows only intended files.

## Done criteria

- [x] `commander@15.0.0` in `dependencies`; lockfile updated
- [x] `bin/harness.ts` uses Commander; old parser helpers removed
- [x] `--base` defaults stay in `lib/config.ts`, not Commander
- [x] Usage errors exit 2; runtime errors exit 1
- [x] Bare `harness` behavior is tested and matches the accepted exit-1 Commander behavior
- [x] `init --unknown` and `run dual-review --unknown` both have CLI coverage
- [x] `baseSkipped` CLI regression test passes
- [x] `providers/cursor/cursor-agent.ts` untouched
- [x] `pnpm test -- test/cli.test.ts`, `pnpm typecheck`, `pnpm check`, `pnpm check:ci`, `pnpm build && pnpm smoke:dist` all exit 0
- [x] `dev/plans/README.md` updated

## STOP conditions

- Public command or option names must change
- Usage-error exit 2 needs brittle hacks
- `baseSkipped: true` when `--base` not passed on existing config
- `pnpm smoke:dist` fails after clean build (non-help reasons)
- `cursor-agent.ts` migration seems required
- `@commander-js/extra-typings` seems necessary — explain first

## Maintenance notes

- Hard-code `dual-review` until a second workflow exists; no registry yet.
- Review exit codes, defaults, and JSON output — not help whitespace.
- Revisit extra-typings or a local command builder if CLI grows past a few commands.
