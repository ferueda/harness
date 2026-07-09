# Plan 260709-durable-factory-store: Add a durable factory store for lifecycle and run artifacts

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If any STOP condition occurs, stop and report instead of improvising.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: migration
- **Issue**: FER-53, "Add durable factory store for lifecycle and run artifacts"

## Requirements

Build a harness-owned durable store for factory continuity. The execution workspace remains the sandbox; the durable store owns the factory lifecycle log, read-model cache, factory run artifacts, and plan-review artifacts spawned by factory planning.

Required behavior:

- Default durable store: `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/`. This must not land inside the documented harness checkout path `~/.harness`.
- Default layout:
  - `factory/events/<work-item>.jsonl`
  - `factory/state/<work-item>.json`
  - `factory/locks/<work-item>.lock/owner.json`
  - `runs/factory/<run-id>/`
  - `runs/reviews/<run-id>/` for plan-review runs spawned from factory planning only.
- Store override precedence: CLI override, then env override, then `harness.json`, then default user data root `${XDG_DATA_HOME:-~/.local/share}/harness/store`.
- Repo identity must not key on disposable workspace path when Git origin is available. Use `<repo-name>-<short-hash-of-normalized-origin-url>`.
- Support explicit project id override with `factory.store.projectId`; also add CLI/env escape hatches for tests/operators. Every explicit project id must be validated as one safe path segment before it is joined under `storeRoot/projects`.
- Existing low-level overrides (`factoryStateRoot` in helper/test inputs and `--runs-dir` / context `runsDir`) remain explicit escape hatches, but defaults must resolve through one store policy and metadata must record any override.
- Lifecycle append stays JSONL. Do not introduce SQLite.
- Add per-work-item file locks. Different work items can run concurrently; same work item writes serialize.
- Lock only append event -> rebuild read model -> publish state JSON. Never hold a lock across a station/provider run.
- Re-check event id after acquiring the lock for idempotent retries.
- Lock every state writer, including cache rebuild paths.
- State JSON remains a rebuildable projection. If an event is appended but state is missing/stale, rebuild from JSONL.
- Publish state via temp file + atomic rename on the same filesystem; fsync the file and parent dir where supported before unlock.
- Lock metadata includes pid, hostname, token, workspace/worktree path, and startedAt.
- `factory status` stays non-blocking and reports active store root, project id, held locks, owner/age, stale-lock warnings, and ignored legacy workspace-local state.
- Record execution provenance in run metadata and lifecycle events: workspace path, run dir, branch/head when available, store root/project id, and repo identity.
- `resolveFactoryWorkItemInput` and implementation readiness must merge lifecycle state from the durable store.
- Planned implementation still requires the approved plan file in the current execution workspace via Git. Durable lifecycle metadata is not plan/code materialization.
- Existing workspace-local `.harness/factory` logs are not silently merged into the durable store in v1. Detect and warn; migration tooling is out of scope.
- Documentation must explain: workspace = sandbox, durable factory store = log/evidence, Linear/GitHub = projections, Git = committed plans/code.

## Project Alignment

This plan intentionally revises a current project invariant, so docs must change before code behavior ships. Today `docs/project-intent.md` says target repos own generated `.harness/` artifacts and generated review artifacts belong under target-repo `.harness/`. FER-53 changes that boundary only for factory continuity.

Approved target invariants. Step 1 introduces these as planned work; the docs update step makes them present-tense only after code behavior ships:

- Harness docs stay generic and standalone. Use `/path/to/repo`, `harness.json`, `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/`, and target-repo wording; do not add private downstream paths.
- Workspace remains the execution sandbox and Git materialization point. Target repos still own source, tests, `harness.json`, `.harness/bin/harness`, `.harness/inbox/factory`, local skill installs, and committed `dev/plans/*.md`.
- Durable factory store owns factory lifecycle JSONL, factory read-model state, factory station run evidence, and plan-review evidence spawned by factory planning.
- Standalone `harness run change-review` and `harness run plan-review` artifacts stay workspace-local by default.
- Linear/GitHub remain human/project projections. Git remains source of truth for committed plans and code.
- Workflows remain provider-agnostic; store resolution belongs in factory command/context plumbing, not provider adapters.
- Docs must separate current behavior from planned behavior until implementation lands.

## Current State

Verified on 2026-07-09.

- Repo is TypeScript/Node 24 with Vitest. `package.json` scripts: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm check`.
- `README.md` documents installing the harness checkout at `~/.harness`; this means the default durable store must not be `~/.harness/store`, because that would put operator data inside the tool checkout. The harness repo `.gitignore` ignores `.harness/`, `node_modules/`, `dist/`, and `logs/`, not `store/`.
- `docs/project-intent.md` says Harness owns reusable workflow machinery, durable improvements, and generic docs; provider/workflow boundaries must stay clean.
- `docs/project-intent.md` also currently says target repos own generated `.harness/` artifacts and generated review artifacts belong under target-repo `.harness/`; this plan must revise that invariant for factory lifecycle/run evidence before code lands.
- `README.md` currently describes workspace-local `.harness/runs/factory`; `docs/contributing/factory.md`, `docs/contributing/architecture.md`, and `docs/contributing/setup-manifest.md` describe workspace-local `.harness/factory` lifecycle paths.
- `docs/contributing/architecture.md` currently lists target repos as owning `.harness/factory/events`, `.harness/factory/state`, `.harness/runs/reviews`, and `.harness/runs/factory`.
- `docs/contributing/setup-manifest.md:65` documents workspace-local `.harness/factory/events`, `.harness/factory/state`, and `.harness/runs/factory`; the `factory lifecycle generated artifacts are documented` test in `test/docs-contracts.test.ts` asserts those lifecycle strings.
- `lib/factory-lifecycle.ts:31` already has `execution.workspace`, optional `runDir`, `branch`, and `head`, but no repo/store identity.
- `lib/factory-lifecycle.ts:283` defaults lifecycle state to `join(workspace, ".harness/factory")`.
- `lib/factory-lifecycle.ts:310` appends JSONL and writes state without any lock.
- `lib/factory-lifecycle.ts:341` rebuilds stale state from JSONL, but also writes state without a lock or atomic rename.
- `lib/factory-run-context.ts:152`, `lib/factory-planning-run-context.ts:205`, and `lib/factory-implementation-run-context.ts:165` default factory run artifacts to `join(workspace, ".harness/runs/factory")`.
- `lib/workflow-context.ts:180` defaults standalone review artifacts to `join(workspace, ".harness/runs/reviews")`.
- `workflows/factory-planning.workflow.ts` `runReview()`/nested `createWorkflowContext` currently hardcodes nested plan-review runs to `join(ctx.workspace, ".harness/runs/reviews")`.
- `lib/factory-triage-input.ts:88` merges lifecycle state through `resolveFactoryStateRoot`, so it currently reads workspace-local lifecycle state unless a test-only root is passed.
- `bin/factory-commands.ts:175` has `factory status`, but it only reads the local inbox.
- `bin/factory-commands.ts:428`, `575`, and `986` expose `--runs-dir` for station run artifacts; there is no store-root flag.
- `bin/factory-commands.ts:701` and `1056` append lifecycle events without passing any durable store resolution.
- `bin/factory-commands.ts:909` planning publication CLI output includes run paths, but publication lifecycle writes currently re-resolve state from `meta.workspace`.
- `test/cli.test.ts` has many `runHarness(["factory", ...])` calls with no store override; before station defaults change, those tests need a shared temp-store wrapper so verification never writes to the real user data store.
- `test/factory-planning-apply-command.test.ts` and `test/cli.test.ts` currently read publication/apply lifecycle state through `resolveFactoryStateRoot({ workspace })`; those assertions must move to temp durable roots when publication wiring changes.
- `lib/factory-linear-adapter.ts:718` has a stale comment saying lifecycle under `.harness/factory` is canonical when present.
- Existing useful tests:
  - `test/factory-lifecycle.test.ts` covers reducer behavior, idempotent append, stale cache rebuild, explicit `factoryStateRoot`, and implementation events.
  - `test/factory-triage-input.test.ts` covers lifecycle overlay over Linear fallback metadata.
  - `test/factory-planning.workflow.test.ts` covers nested plan-review refs and final plan writes.
  - `test/factory-planning-apply-command.test.ts` and `test/cli.test.ts` cover planning lifecycle writes and publication commands.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Format check | `pnpm format:check` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Focused lifecycle tests | `pnpm test -- test/factory-lifecycle.test.ts test/factory-triage-input.test.ts` | all tests pass |
| Focused factory tests | `pnpm test -- test/factory-planning.workflow.test.ts test/factory-planning-apply-command.test.ts test/factory-implementation-run-context.test.ts test/cli.test.ts` | all tests pass |
| Full tests | `pnpm test` | all tests pass |
| Full gate | `pnpm check` | format, lint, typecheck, tests, build, smoke-dist pass |

## Skills for the Executor

| Skill/tool | Verified source | Use for |
|---|---|---|
| `implement-plan` | `skills/implement-plan/SKILL.md` | Execute this plan phase by phase; stop on drift. |
| `typescript-refactor` | `.agents/skills/typescript-refactor/SKILL.md` | Design typed resolver/config/provenance APIs without unsafe casts. |
| `vitest` | `.agents/skills/vitest/SKILL.md` | Add isolated tests for resolver precedence, locks, lifecycle recovery, and CLI behavior. |
| `node` | `.agents/skills/node/SKILL.md` | Implement filesystem locking, atomic writes, fsync, and Git child-process probing in Node. |
| `zod` | `.agents/skills/zod/SKILL.md` | Extend `harness.json`, lifecycle event, and metadata schemas. |
| `factory-operator` | `skills/factory-operator/SKILL.md` | Run final smoke tests with factory station commands and Linear-backed input. |
| `change-review-workflow` | `skills/change-review-workflow/SKILL.md` | After implementation and local gates, run the harness change review and triage findings. |

## Scope

In scope:

- `lib/factory-store.ts` (new): durable store resolver, repo id derivation, provenance, legacy detection, lock inspection.
- `lib/factory-locks.ts` (new): per-work-item lock acquire/release, stale detection/recovery, sync wait, and lock inspection helpers.
- `lib/factory-lifecycle.ts`: durable-state root resolution integration, lock-aware append/rebuild, atomic state writes, schemas.
- `lib/factory-lifecycle-writes.ts`: provenance and durable artifact path handling.
- `lib/config.ts` and `lib/schemas.ts`: `factory.store` config and role/config resolution support.
- `lib/factory-run-context.ts`, `lib/factory-planning-run-context.ts`, `lib/factory-implementation-run-context.ts`, `workflows/factory-planning.workflow.ts`: durable factory run directories, nested planning review run directory plumbing, and metadata/provenance. Do not change `lib/workflow-context.ts` defaults.
- `lib/factory-triage-input.ts`, `lib/factory-planning-handoff.ts`: durable lifecycle read paths and run metadata load/update behavior.
- `lib/factory-implementation-input.ts`: readiness regression consumer; keep requiring the approved plan file in the execution workspace after durable lifecycle metadata lands.
- `bin/factory-commands.ts`, `bin/harness.ts` where needed: CLI/env option surface, status output, publication behavior.
- `bin/factory-triage-cli.ts`, `bin/factory-planning-cli.ts`, `bin/factory-implementation-cli.ts`: dry-run CLI output warning fields for lifecycle inspect-mode warnings.
- Tests under `test/` matching existing patterns.
- Docs/skills: `docs/project-intent.md`, `README.md`, `docs/contributing/factory.md`, `docs/contributing/architecture.md`, `docs/contributing/script-command-surface.md`, `docs/contributing/setup-manifest.md`, `skills/factory-operator/SKILL.md`.
- Docs contracts: `test/docs-contracts.test.ts` assertions for factory lifecycle/generated artifacts.

Executor invariants from `docs/project-intent.md`:

- Keep examples and docs generic; do not add private downstream paths.
- Preserve standalone review defaults as workspace-local unless those workflows receive their own explicit `--runs-dir`.
- Keep provider adapters provider-focused; durable store resolution belongs in factory command/context plumbing, not in Cursor/Codex adapters.
- Do not silently merge or import legacy workspace-local `.harness/factory`; detect and warn only in v1.
- Keep Git as the source of truth for committed plans/code; durable metadata must not materialize or replace plan file contents.

Out of scope:

- Worktree orchestration or dispatch policy. Defer to FER-30.
- SQLite or any new database dependency.
- Cos-specific archiving.
- Treating Linear/GitHub as source of truth.
- Storing full committed plan/code contents as canonical durable source instead of Git.
- Changing Linear status semantics.
- Moving all standalone `harness run change-review` / `harness run plan-review` artifacts to the durable store. Only nested plan-review runs spawned by factory planning move by default.
- Moving low-level `harness run factory-triage` defaults. It keeps the current workspace run-dir default unless `--runs-dir` is set; only `harness factory *` station commands resolve the durable store by default.
- Automatic migration or silent merging of old workspace-local `.harness/factory` logs.
- Batch factory dispatch, Inngest, GitHub/Jira integrations.

## Design

### Store Policy

Add a single resolver that factory station commands call before reading lifecycle state or creating run contexts. `resolveFactoryStore` is the only production defaulting entrypoint for durable storage. Keep `resolveFactoryStateRoot({ workspace })` with its current explicit-override-or-workspace-local semantics for tests and low-level helpers; production command paths must pass `factoryStateRoot: resolution.factoryStateRoot` explicitly.

Target shape:

```ts
export type FactoryStoreResolution = {
  workspace: string;
  storeRoot: string;          // ${XDG_DATA_HOME:-~/.local/share}/harness/store or override
  projectId: string;          // repo-name-shorthash or explicit override
  projectRoot: string;        // <storeRoot>/projects/<projectId>
  factoryStateRoot: string;   // <projectRoot>/factory
  factoryRunsDir: string;     // <projectRoot>/runs/factory
  reviewRunsDir: string;      // <projectRoot>/runs/reviews
  repo: {
    name: string;
    id: string;
    idSource: "config" | "cli" | "env" | "origin" | "no-origin-fallback" | "workspace-fallback";
    normalizedOriginUrl?: string;
    originHash?: string;
    workspaceHash?: string;
  };
  overrides: {
    storeRoot?: "cli" | "env" | "config";
    projectId?: "cli" | "env" | "config";
    runsDir?: string;
    factoryStateRoot?: string;
  };
  warnings: string[];
};
```

Precedence:

1. CLI: `--factory-store-root <path>` and `--factory-store-project-id <id>`.
2. Env: `HARNESS_FACTORY_STORE_ROOT` and `HARNESS_FACTORY_STORE_PROJECT_ID`.
3. Config: `factory.store.root` and `factory.store.projectId`.
4. Defaults: `join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "harness/store")` and derived repo id.

Project id validation:

- Apply one shared parser to CLI, env, config, and derived project ids before constructing `projectRoot`.
- Require the input to equal its trimmed form, require 1-120 characters, allow only `[A-Za-z0-9._-]`, require an alphanumeric first character, and reject `.` / `..` explicitly.
- Reject path separators and invalid values with a source-specific configuration/CLI error; do not silently sanitize explicit overrides into a different id.
- After `projectRoot = resolve(storeRoot, "projects", projectId)`, verify it is a strict descendant of `resolve(storeRoot, "projects")` before returning the resolution. This is a defense-in-depth containment check.

The default must be outside `~/.harness` so it does not collide with the documented checkout install path. Tests must cover that a documented install at `~/.harness` resolves the default store outside that checkout.

Resolver side-effect invariant:

- `resolveFactoryStore`, `deriveFactoryRepoIdentity`, `detectLegacyFactoryState`, lock inspection, and `factory status` are path/metadata/inspection operations only. They must not call `mkdirSync` or create `storeRoot`, `projectRoot`, state dirs, run dirs, or lock dirs.
- The first durable-store directory creation happens only when a write path appends/rebuilds lifecycle state, creates a factory run context, creates a nested review run context, or explicitly writes an artifact.
- Add tests that call `resolveFactoryStore` and `factory status` against an empty temp store root and assert the store root/project tree still does not exist afterward.

Repo id derivation:

- Resolve workspace through existing config/Git root logic.
- Read `git config --get remote.origin.url`.
- Normalize by trimming, lowercasing host/owner/repo portions where safe, converting SCP-like Git URLs (`git@github.com:owner/repo.git`) to a canonical URL-ish string, stripping credentials, and removing trailing `.git`.
- Repo name is the final repo segment without `.git`.
- Project id is `${repoName}-${sha256(normalizedOriginUrl).slice(0, 12)}` sanitized to `[A-Za-z0-9._-]`.
- If the workspace is a Git repo but no origin exists, use `${repoName}-no-origin-${sha256(gitCommonDirOrWorkspace).slice(0, 12)}`, set `idSource: "no-origin-fallback"`, and include a warning recommending `factory.store.projectId` for long-lived repos.
- If the resolved workspace is not inside a Git repo at all, station commands must still succeed. `workspace-fallback` applies after Harness has a workspace path from explicit `--workspace <path>` or a discovered `harness.json` parent; it does not change bare-CWD workspace discovery rules. Use `idSource: "workspace-fallback"`, `repo.name = sanitized basename(resolvedWorkspace)`, `workspaceHash = sha256(resolved absolute workspace path).slice(0, 12)`, and `projectId = ${repo.name}-workspace-${workspaceHash}` unless an explicit CLI/env/config project id is supplied. Emit a warning recommending `factory.store.projectId` for durable non-git workspaces because the fallback is path-derived.
- Unit tests must never rely on default real HOME. Tests either pass CLI/env/config temp store roots into `resolveFactoryStore`, or pass explicit `factoryStateRoot` to low-level lifecycle helpers.

### Locking

Use local filesystem lock directories, not SQLite:

- Lock path: `<factoryStateRoot>/locks/<work-item-filename>.lock/owner.json`.
- The write-path acquire helper first creates only the parent `join(factoryStateRoot, "locks")` with `mkdirSync(..., { recursive: true })`, then acquires exclusivity with non-recursive atomic `mkdirSync(lockDir)`. Resolver, inspection, dry-run, fetch, and status paths must not create the parent.
- After acquiring the directory, publish `owner.json` immediately. If owner publication fails in-process, remove the just-acquired directory best-effort and rethrow.
- Define incomplete-owner behavior explicitly:
  - Missing `owner.json` is `owner-missing`; malformed/schema-invalid `owner.json` is `owner-invalid`.
  - Status reports either classification, lock-dir age, and a remediation warning without blocking or mutating it.
  - Acquire treats a recent incomplete owner as indeterminate and fails closed after the normal timeout.
  - An owner-missing lock may be broken after the same 30-minute stale threshold only with `rmdirSync(lockDir)` after re-checking that the same directory is still empty; `rmdirSync` must fail if an owner appeared. Never recursively remove an owner-missing lock.
  - An owner-invalid non-empty lock is never auto-broken because pid/hostname/token ownership cannot be confirmed; fail closed with typed diagnostics and require operator cleanup.
- Keep lifecycle lock helpers synchronous in v1 to match the current synchronous lifecycle API surface (`appendFactoryLifecycleEvent`, `loadFactoryLifecycleState`, `mergeLifecycleState`, and existing CLI/helper callers). Do not convert lifecycle APIs to async in FER-53.
- On lock exists, read `owner.json` non-blockingly for diagnostics, then sleep/retry until a bounded timeout. Use a dependency-free synchronous wait helper, for example `sleepSync(ms)` backed by `Atomics.wait` on a local `SharedArrayBuffer`, or an equivalent Node primitive with blocking semantics. Do not busy-spin.
- Use explicit bounded defaults:
  - `writeTimeoutMs = 5000` for append/rebuild/write paths.
  - `readTimeoutMs = 2000` for live lock-aware station input/readiness paths that may rebuild stale or corrupt projections. Inspect-only fetch/dry-run/status paths never wait on locks.
  - `pollIntervalMs = 50` by default, bounded to 25-100ms with simple jitter.
  - Expose test-only injectable timeout overrides so lock tests can run with short deterministic waits.
- If smoke testing shows the 5000ms write default or 2000ms read default is too long/short for normal local factory use, STOP and report with measured evidence instead of silently choosing another value.
- Document the trade-off: the current CLI/lifecycle flow is synchronous command execution, so short blocking waits are acceptable; an async lifecycle conversion is a broader API migration and is out of scope for FER-53.
- Lock waits must never surround provider calls, station execution, Linear/GitHub I/O, or review/model execution; they only protect lifecycle append/rebuild critical sections.
- CI and unit tests must always override lock timeouts to short deterministic values.
- Owner metadata: `pid`, `hostname`, `token` (UUID/random hex), `workspace`, `runDir` if known, `workItemKey`, `startedAt`, and process title if useful.
- Release removes the lock directory only if current `owner.json` still has this process's `pid`, `hostname`, and `token`.
- Same-host pid liveness uses `process.kill(pid, 0)`: alive on success or `EPERM`, dead on `ESRCH`, unknown on other errors or invalid pid.
- `appendFactoryLifecycleEvent` and stale-cache rebuild both run inside `withFactoryWorkItemLock`.
- Re-read events after acquiring the lock and re-check duplicate event id before append.
- Append JSONL, fsync event file, reduce all events, write state to `state/<name>.json.tmp-<pid>-<random>`, fsync temp file, atomic rename, fsync parent dir where possible.
- If fsync parent dir is unsupported on the platform, continue after best effort; tests should not require platform-specific fsync errors.
- Stale policy for v1:
  - On the same hostname, a lock is stale when `owner.pid` is not alive.
  - On any hostname, a lock is stale when `startedAt` is older than 30 minutes.
  - Hostname mismatch alone is not stale; report it as remote/unknown-owner.
  - `factory status` never breaks locks.
  - Append/rebuild acquire may break stale locks: if a lock is classified stale, remove the lock directory only after re-reading `owner.json` and confirming the same `pid`/`hostname`/`token` still owns it, then retry acquire once.
- If stale removal fails, if ownership changed, or if acquire still times out after the stale-break retry, fail closed with owner metadata, age, and stale classification.
- Lock timeout errors must use a typed error shape or class, not generic strings. CLI JSON/stderr must expose at least `workItemKey`, `lockPath`, owner `pid`, `hostname`, `token`, `workspace`, `runDir` when present, `startedAt`, `ageMs`, `stale`, incomplete-owner classification when present, and whether the operation was a read or write. Only live load-mode triage/planning/implementation readiness paths fail closed with those fields when a non-stale lock blocks beyond the configured timeout. `factory linear fetch`, factory dry-runs, and `factory status` are inspect-only: they never wait on or acquire lifecycle locks and report `lifecycle-lock-held` warnings instead.

### Legacy Workspace State

V1 behavior:

- Durable store is canonical for new reads/writes.
- Do not read or merge `<workspace>/.harness/factory/events` into the durable store.
- Detect legacy workspace-local lifecycle files in `factory status` and report warnings with paths and counts.
- If both durable and legacy state exist, status says durable wins and legacy is ignored.
- Migration command is out of scope.

### Run Artifacts

Default station run roots:

- Factory triage/planning/implementation default to `resolution.factoryRunsDir`.
- Nested plan-review runs from factory planning default to `resolution.reviewRunsDir`.
- Standalone `harness run change-review` and `harness run plan-review` keep current default `workspace/.harness/runs/reviews`.

`--runs-dir` remains an explicit run-artifact override. It must be recorded in run metadata under `factoryStore.overrides.runsDir`, and lifecycle metadata must still use the resolved durable `factoryStateRoot` unless a low-level test explicitly passes `factoryStateRoot`.

### Provenance

Add `factoryStore` or equivalent metadata to every factory station `meta.json`:

- `storeRoot`, `projectId`, `projectRoot`, `factoryStateRoot`, `factoryRunsDir`, `reviewRunsDir`.
- `repo` identity fields from the resolver.
- `execution.workspace`, `execution.branch`, `execution.head`.
- `overrides` and `warnings`.

Extend lifecycle event `execution` to include store/project/repo identity, not just workspace/runDir. Do not put credentials in normalized origin URLs.

Artifact paths in lifecycle event `data` must not become misleading `../../...` paths when run dirs move outside the workspace. Prefer run-relative paths for artifacts inside `runDir`, plus `execution.runDir` as the base. Use store-relative paths only when the artifact is outside the run dir.

## Steps

### Step 1: Document the approved boundary as planned work

Before changing code defaults, update source-of-truth docs with planned-work language so the architecture decision is explicit without claiming runtime behavior has already changed.

Update `docs/project-intent.md`:

- Keep current workspace-local artifact ownership labeled as current behavior.
- Add a planned FER-53 boundary note:
  - standalone review artifacts will keep target-repo `.harness/runs/reviews` defaults;
  - factory lifecycle and factory-owned run evidence will move to a durable factory store by default;
  - target repos will continue to own execution material (`harness.json`, shim, inbox, source, tests, committed plans/code).
- Preserve generic docs, provider-agnostic workflow, and no private downstream examples.

Update `docs/contributing/architecture.md` ownership language in the same step:

- Add planned-work language for durable store ownership.
- Keep current workspace-local `.harness/factory` and `.harness/runs/factory` ownership labeled as current until the final docs update step.
- State that target repos remain execution sandboxes and Git materialization points.
- State that standalone reviews remain workspace-local by default.

Plan artifact registration is already satisfied before execution: this reviewed plan exists at `dev/plans/FER-53-durable-factory-store.md`, and `dev/plans/README.md` registers it as `planned`. Do not copy or re-register it in Step 1. Any planned-work note in `docs/project-intent.md` must point at that active plan entry so the intent document does not reference only ignored `.harness/runs/` artifacts.

Tests:

- Do not change behavior yet.
- Do not change `test/docs-contracts.test.ts` path assertions in this step unless they only need wording for planned-work references. Present-tense path assertion changes belong in the final docs update step after behavior ships.
- Keep Step 1 language explicitly FER-53/planned-tense. Do not flip ownership claims or docs-contract path assertions to durable-store present tense until the final docs update step, after runtime behavior is implemented.
- Hard checkbox: Step 1 must not add present-tense durable-store path assertions to `test/docs-contracts.test.ts`; those assertions move only after the runtime cutover is implemented and verified.

**Verify**: `pnpm test -- test/docs-contracts.test.ts && pnpm format:check` -> pass.

### Step 2: Add durable store config schema and resolver

Create `lib/factory-store.ts`.

Implement:

- `FactoryStoreResolution` type.
- `resolveFactoryStore(input)` with CLI/env/config/default precedence.
- `deriveFactoryRepoIdentity(workspace)` using Git origin when available.
- `defaultFactoryStoreRoot()` using `XDG_DATA_HOME` when set and otherwise `join(homedir(), ".local/share", "harness", "store")`.
- `detectLegacyFactoryState(workspace, resolution)` returning warning details only.
- `factoryStoreMetadata(resolution, execution)` helper for run metadata.

Update `lib/schemas.ts`:

- Add `factory.store.root?: string`.
- Add `factory.store.projectId?: string` using the shared safe-project-id schema/parser from Store Policy rather than an unconstrained string.
- Keep schema strict under `factory.store`; unknown store keys should fail like other factory config sections.

Update `lib/config.ts`:

- Export `resolveFactoryStoreSettings` or expose config enough for `resolveFactoryStore`.
- Do not duplicate resolver logic in command files.

Tests:

- Add `test/factory-store.test.ts`.
- Cover CLI > env > config > default store root precedence.
- Cover CLI/env/config project id override.
- Cover invalid CLI/env/config project ids: empty/whitespace, `.`, `..`, separators, leading punctuation, over-length values, and traversal attempts. Assert resolver rejection and no directory creation outside or inside the temp store.
- Cover origin URL normalization for HTTPS and SSH/SCP forms.
- Cover no-origin fallback warning.
- Cover non-git workspace fallback from a plain temporary directory passed with explicit `--workspace <tempdir>` and a temp store root: `idSource: "workspace-fallback"`, sanitized basename repo name, project id with a hash of the resolved absolute workspace path, warning recommending `factory.store.projectId`, and no throw from factory planning dry-run.
- Cover default project root equals `<storeRoot>/projects/<repo-id>`.
- Cover resolver side effects: calling `resolveFactoryStore` for an empty temp store root computes paths but creates no files or directories.
- Cover default store root is outside a documented `~/.harness` checkout.
- Cover no credentials leak from origin URLs.
- Cover tests using temp store roots; no test should write under real `homedir()`.

**Verify**: `pnpm test -- test/factory-store.test.ts test/config.test.ts` -> all pass.

### Step 3: Make lifecycle append/rebuild lock-aware and atomic

Execute Step 3 in two commit-sized gates:

- Step 3a: lock protocol, atomic writes, typed lock errors, and injectable timeouts.
- Step 3b: lifecycle read modes, dry-run/fetch warning delivery, read-only fetch contract, and matching mutability docs.

Do not enable lock-aware rebuild behavior for station input until Step 3b has wired dry-run/fetch inspect paths and warnings.

#### Step 3a: Locks, atomic writes, and typed lock errors

Create `lib/factory-locks.ts`. Keep acquire/release/stale recovery/sync wait/inspection helpers there so `lib/factory-lifecycle.ts` remains focused on event schemas, reducer behavior, append orchestration, and load orchestration. Do not add registry/workflow layers for this migration.

Update `lib/factory-lifecycle.ts`:

- Keep `resolveFactoryStateRoot` low-level: explicit `factoryStateRoot` wins; otherwise it keeps current workspace-local fallback. Do not make this helper default to the durable store root.
- Add comments/types making `resolveFactoryStore` the only production durable defaulting entrypoint.
- Keep lock-aware lifecycle APIs synchronous. Implement any lock retry waits with the bounded synchronous wait primitive from the Locking section; do not introduce async lifecycle APIs in this ticket.
- Add `appendFactoryLifecycleEvent` locking:
  - Acquire per-work-item lock.
  - Re-read JSONL after lock.
  - Return existing event if duplicate id is found.
  - Append and fsync.
  - Rebuild state from full JSONL.
  - Atomic write state.
  - Release lock.
- Do not change `loadFactoryLifecycleState` rebuild behavior in Step 3a. Step 3a may lock append and atomic state publish only; lock-aware load/rebuild is enabled in Step 3b after inspect-mode call sites are wired.
- Make the public state writer lock-safe or remove it from the public write surface:
  - Preferred: keep `writeFactoryLifecycleState` private to `lib/factory-lifecycle.ts` and route all external writes through append/rebuild helpers that already hold the per-work-item lock.
  - If it must remain exported for tests, require an explicit lock token/context argument so it cannot perform an unlocked `writeFileSync`.
  - Add a regression or type-level test that no exported helper can write `state/<work-item>.json` without the per-work-item lock and atomic rename path.
- Keep `readFactoryLifecycleEvents` lock-free for status/read-only inspection.
- Add exported lock inspection helper for `factory status`.

Tests:

- Extend `test/factory-lifecycle.test.ts`.
- Duplicate id under lock remains idempotent.
- Event append rebuilds state from JSONL under the append lock.
- Same work item concurrent appends serialize. Do not try to prove overlapping synchronous critical sections with same-thread promises. Add a test-only injectable lock/wait seam for deterministic timeout and stale-break unit tests, and add at most one `child_process` integration test for real `mkdir` lock contention if needed. Keep timeouts short and deterministic; do not make `worker_threads`/`SharedArrayBuffer` the only proof.
- Different work item locks are independent.
- Lock metadata includes pid, hostname, token, workspace, startedAt.
- First acquire creates the `locks/` parent and still uses non-recursive atomic creation for the work-item lock directory.
- Owner publication failure releases the just-acquired lock directory best-effort.
- Missing owner files report `owner-missing`; recent owner-missing locks fail closed, while old owner-missing empty directories are removed only with an empty-directory `rmdirSync` re-check.
- Malformed owner files report `owner-invalid`, are never auto-broken, and fail closed with remediation diagnostics.
- State write uses temp+rename; no leftover temp file after success.
- Same-host dead pid reports stale.
- Lock older than 30 minutes reports stale.
- Hostname mismatch reports remote/unknown-owner but not stale by itself.
- Stale same-owner lock is removed on acquire after re-reading matching pid/hostname/token, then acquire retries once.
- Stale lock is not removed when owner token changes between stale classification and removal.
- Acquire timeout fails closed with owner metadata when a lock is not stale or stale removal is unsafe.
- Stale lock warning reports owner/age without blocking read.

**Step 3a verify**: `pnpm test -- test/factory-lifecycle.test.ts` -> lock protocol, atomic state publish, stale lock, timeout, and duplicate-id tests pass with injected short timeouts.

Step 3a STOP/regression: before leaving Step 3a, dry-run station input and `factory linear fetch` must still create no lifecycle lock/state directories. If append locking makes dry-run or fetch acquire locks before Step 3b inspect wiring exists, stop and fix the sequencing.

#### Step 3b: Read modes, dry-run/fetch warnings, and mutability docs

Add two lifecycle read modes:

- Enable lock-aware load/rebuild only after the Step 3b call-site checklist below is complete.
- `loadFactoryLifecycleState` first performs a side-effect-free read of JSONL and the state cache.
- If there are no events, or if the cache is fresh for the last event id, return without acquiring a lock or creating any store directories.
- Treat malformed JSON or schema-invalid state JSON as a corrupt rebuildable projection, not as canonical-log corruption. If state is missing, stale, or corrupt and a rebuild/write is required, acquire the per-work-item lock bounded by `readTimeoutMs`, re-read events/cache under the lock, rebuild only if still needed, atomically replace state, then release. Canonical JSONL parse/schema errors remain hard failures.
- `loadFactoryLifecycleState` remains lock-aware and may rebuild stale/missing/corrupt state. Use this for live station input/readiness and any path that can safely wait/fail while preparing a station.
- Add a lock-free inspection helper, for example `inspectFactoryLifecycleState`, that reads existing events/state and never writes, rebuilds on disk, or acquires a lock. When the cache is missing, stale, or corrupt, it may reduce valid canonical events in memory for a best-effort overlay and must return the matching lifecycle warning; corrupt cache uses `durable-state-stale` with a message that identifies invalid cached state.
- `factory status` must not call `loadFactoryLifecycleState` or any helper that can acquire a lifecycle write lock.
- Live station `resolveFactoryWorkItemInput` and `mergeLifecycleState` must use the load path that rebuilds stale/missing/corrupt projections under the lock when needed. They may wait up to `readTimeoutMs` only when a rebuild/write is required and then fail closed with owner metadata; they must not silently serve stale projections for live stations.
- `fetchFactoryLinearWorkItem` must use inspect/read-only mode by default. It must not rebuild/write lifecycle state, acquire lifecycle locks, or create store dirs; stale/missing/corrupt lifecycle state becomes a warning in fetch output.
- Dry-run station input must pass `lifecycleReadMode: "inspect"` and may use the side-effect-free inspection/read path while emitting stale/missing/corrupt-state warnings instead of rebuilding.
- Only `factory status`, `factory linear fetch`, and station dry-run input with `lifecycleReadMode: "inspect"` may use lock-free inspection.

Warning delivery contract:

- Add `FactoryLifecycleWarning = { code: "durable-state-missing" | "durable-state-stale" | "lifecycle-lock-held"; message: string; factoryStateRoot?: string; workItemKey?: string; lockOwner?: { pid?: number; hostname?: string; token?: string; startedAt?: string; ageMs?: number; classification?: "owner-missing" | "owner-invalid" } }`.
- Extend `FactoryResolvedWorkItemInput` and any station dry-run CLI JSON output that includes resolved input with `warnings?: FactoryLifecycleWarning[]`.
- Exact CLI JSON shapes:
  - `factory linear fetch` remains backward-compatible by keeping the fetched work item fields at the top level and adding optional `warnings?: FactoryLifecycleWarning[]`. Implement this as a `FactoryLinearFetchOutput = FactoryWorkItem & { warnings?: FactoryLifecycleWarning[] }` or equivalent; do not wrap existing output under `{ workItem }`.
  - Triage dry-run output from `bin/factory-triage-cli.ts` adds top-level `warnings?: FactoryLifecycleWarning[]` and forwards `FactoryResolvedWorkItemInput.warnings`.
  - Planning dry-run output from `bin/factory-planning-cli.ts` adds top-level `warnings?: FactoryLifecycleWarning[]` and forwards resolved-input lifecycle warnings.
  - Implementation dry-run output from `bin/factory-implementation-cli.ts` adds top-level `warnings?: FactoryLifecycleWarning[]` and forwards resolved-input/readiness lifecycle warnings.
  - Human-readable dry-run output should print warning messages in the existing warning/output channel, but JSON assertions are authoritative.
- Live station paths should surface lock failures as typed errors, not warnings.
- Add focused triage and planning dry-run tests where durable lifecycle state is missing/stale/corrupt or a lock is held; assert `warnings[].code` and `factoryStateRoot` are present and no lifecycle lock/state directories are created by the dry-run.
- Add focused fetch tests where durable lifecycle state is stale/missing/corrupt or a lock is held; assert existing work item fields remain top-level and `warnings[].code` is present without lifecycle writes.
- Add `test/factory-linear-fetch.test.ts` for helper-level fetch coverage if focused fetch tests do not already exist outside `test/cli.test.ts`. It must assert `fetchFactoryLinearWorkItem` uses inspect/read-only mode, returns top-level `warnings[].code`, and creates no lifecycle lock/state directories when durable state is stale/missing/corrupt or a lock is held.
- Add focused tests that omitted `lifecycleReadMode` on station-facing helpers throws a clear configuration error.
- Add focused CLI/helper tests proving dry-run triage/planning/implementation pass `"inspect"`, live triage/planning/implementation pass `"load"`, and `factory linear fetch` passes `"inspect"` before lock-aware rebuild behavior is enabled.

Concrete Step 3b production call-site checklist:

- `bin/factory-commands.ts` `factory triage` action:
  - `--dry-run` calls `resolveFactoryWorkItemInput` with `lifecycleReadMode: "inspect"`.
  - live mode calls `resolveFactoryWorkItemInput` with `lifecycleReadMode: "load"`.
  - dry-run forwards `resolvedInput.warnings` to `factoryTriageCliOutput(..., { warnings })` or an equivalent explicit output parameter.
- `bin/factory-commands.ts` `factory planning run` action:
  - `--dry-run` calls `resolveFactoryWorkItemInput` with `lifecycleReadMode: "inspect"`.
  - live mode calls `resolveFactoryWorkItemInput` with `lifecycleReadMode: "load"`.
  - dry-run forwards `resolvedInput.warnings` to `factoryPlanningCliOutput(..., { warnings })` or an equivalent explicit output parameter.
- `bin/factory-commands.ts` `factory implementation run` action:
  - `--dry-run` uses inspect-mode resolved input/readiness and forwards lifecycle warnings to `factoryImplementationCliOutput(..., { warnings })` or an equivalent explicit output parameter.
  - live mode uses load-mode readiness before running implementation.
- `bin/factory-commands.ts` `factory linear fetch` action:
  - `fetchFactoryLinearWorkItem` calls `mergeLifecycleState` with `lifecycleReadMode: "inspect"`.
  - CLI output keeps work item fields top-level and adds optional `warnings`.
- `bin/factory-triage-cli.ts`, `bin/factory-planning-cli.ts`, and `bin/factory-implementation-cli.ts` must accept explicit warning input and put `warnings?: FactoryLifecycleWarning[]` at top-level JSON output.

STOP if any dry-run path omits warning forwarding, still calls `"load"`, or relies on omitted `lifecycleReadMode`.

Read-mode tests:

- Lock-free inspection returns current state/event facts without rebuilding a stale cache.
- Lock-free inspection ignores malformed/schema-invalid cached state, returns a best-effort in-memory projection from valid JSONL, emits `durable-state-stale`, and performs no writes.
- Lock-free inspection does not wait on a held lock.
- Lock-aware load rebuilds stale cache under the lock.
- Lock-aware load rebuilds malformed/schema-invalid cached state from valid JSONL under the lock and atomically replaces it.
- A held non-stale lock causes live station `resolveFactoryWorkItemInput` to fail closed with the typed lock timeout error and owner metadata within the configured `readTimeoutMs` test timeout only when stale/missing/corrupt state requires a rebuild; fresh-cache and empty-event reads create no lock dirs and do not wait. `factory linear fetch` remains inspect/read-only and reports lock/stale/corrupt state as warnings.
- Dry-run station input with stale/missing/corrupt lifecycle state does not rebuild or acquire locks; it returns best-effort overlay plus a warning.
- Append paths use `writeTimeoutMs`; live load-mode station input/readiness rebuilds use `readTimeoutMs`. Fetch, dry-run, and status inspection never use either wait timeout because they never acquire lifecycle locks. Tests override write/read timeouts to short deterministic values and assert live CLI JSON/stderr exposes the required owner fields instead of a generic `Error` string.
- Lock acquire tests use low test timeouts and prove the synchronous wait helper does not busy-spin indefinitely. For timeout/stale-break behavior, use the injectable wait/lock seam; for real filesystem contention, use a single `child_process` integration test if unit coverage is insufficient.

Docs/contracts in this step:

- Update `docs/contributing/script-command-surface.md` mutability language in the same step as read-mode behavior changes:
  - `factory linear fetch` remains read-only for lifecycle state; it can report lifecycle warnings but must not rebuild/write lifecycle projections.
  - Dry-run factory stations are side-effect-free for lifecycle state and can warn when durable lifecycle state is stale/missing/corrupt.
  - Live triage/planning/implementation readiness paths may rebuild stale/missing/corrupt lifecycle projections under lock.
- Update `docs/contributing/factory.md` lock/rebuild/dry-run language for these behavior changes, but keep durable path ownership claims planned-tense until the final docs step.
- Update docs-contract tests only for command mutability/read-mode claims here; do not add present-tense durable path ownership assertions in Step 3.

**Step 3b verify**: `pnpm test -- test/factory-triage-input.test.ts test/factory-planning-input.test.ts test/factory-implementation-input.test.ts test/factory-linear-fetch.test.ts test/factory-triage-cli.test.ts test/factory-planning-cli.test.ts test/factory-implementation-cli.test.ts` -> all pass, including omitted-mode, dry-run inspect, live load, fetch inspect/read-only, top-level warning output, and no dry-run/fetch lock/state directory creation assertions. Defer full `test/cli.test.ts` coverage to Step 4a after the shared temp-store wrapper exists.

### Step 4: Route factory station state, run dirs, and lifecycle artifact paths through the store

This is one executable cutover step. Do not flip default factory run dirs or nested review run dirs to the durable store until the same change also ships `factoryStore` meta, publication fallback, nested `reviewRunsDir` wiring, and `formatLifecycleArtifactPath` regression coverage. Step 4 is done only when all items in this section and the Step 4b artifact-path subsection below are implemented and verified together.

Step 4 commit gates, in order:

1. Test safety gate: create the shared temp-store helper and migrate every harness-factory spawning test helper to it. No durable default behavior changes before this gate passes.
2. Artifact-path gate: implement `formatLifecycleArtifactPath`, migrate lifecycle writers, and add no-`..` regression tests while run defaults are still workspace-local or explicitly injected. No durable run-dir default flip before this gate passes.
3. Station cutover gate: route station input/fetch/publication/lifecycle appends/run contexts through `resolveFactoryStore`, flip factory station run dirs and nested review dirs to durable defaults, and export `factoryStore` meta.

Each gate must have its focused verify command and should be a separate implementation commit boundary. Gate 3 may not start until Gates 1 and 2 pass.

#### Step 4a: Test safety gate

Update station command setup in `bin/factory-commands.ts`:

- Add common options to `harness factory status`, `factory linear fetch`, `triage`, `planning run`, `implementation run`, `planning publish`, and `planning mark-plan-merged` where useful:
  - `--factory-store-root <path>`
  - `--factory-store-project-id <id>`
- Read `HARNESS_FACTORY_STORE_ROOT` and `HARNESS_FACTORY_STORE_PROJECT_ID` via `process.env`.
- Before flipping defaults or routing direct helper reads through durable state, add a concrete shared test helper module for all factory command and lifecycle-helper tests that can reach durable store resolution:
  - Create `test/factory-store-test-helpers.ts`.
  - Export `withTempFactoryStore(fn)` that creates a temp store root/project id, passes an explicit env object/override values to the callback, and runs after-test assertions. It must not mutate ambient `process.env`; in-process resolver/helper tests pass the provided env explicitly.
  - Export `runFactoryHarness(args, options)` for `harness factory ...` CLI tests. It must inject the temp durable store by default through CLI flags or the spawned process's explicit `env` object, never by mutating ambient `process.env`, and fail if called for a production factory command without a temp store.
  - `runFactoryHarness()` must apply a mechanical rule: if `args[0] === "factory"` and the command is status/fetch/triage/planning/implementation/publication or any path that may reach `resolveFactoryStore`, inject temp store env/flags automatically. Only allowlist help/usage/error-before-resolve invocations such as `["factory", "--help"]`, unknown subcommands that exit before store resolution, or explicit low-level workspace-local tests with an inline reason.
  - Explicitly exempt non-store factory commands that do not resolve durable state: `factory linear list`, `factory linear create`, and `factory dispatch`. Future non-store factory commands need an inline exemption reason in tests before bypassing temp-store injection.
  - Export helper assertions that fail if any test writes under the real `homedir()`/`XDG_DATA_HOME` default `harness/store` or creates unexpected durable store files outside the temp root.
  - `test/cli.test.ts` must use `runFactoryHarness()` for every `harness factory ...` invocation that can reach store resolution before any default flip lands.
  - Delete or rewrite local clones such as private `runHarness` wrappers in `test/factory-implementation-cli.test.ts`; every helper that spawns `harness factory ...` must delegate to `runFactoryHarness()` or inject an explicit temp store root/project id.
  - Step 4 is blocked until `rg -n 'spawnSync|runHarness\\(|\\[\"factory\"|\\['\"'\"'factory'\"'\"'' test` has been audited and every production factory CLI path is wrapped or explicitly exempted as low-level workspace-local behavior.
  - `test/factory-planning-apply-command.test.ts`, `test/factory-implementation-cli.test.ts`, `test/factory-triage-input.test.ts`, `test/factory-planning-input.test.ts`, `test/factory-implementation-input.test.ts`, and lifecycle helper tests that call production triage/planning/implementation/publication/input helpers directly must pass explicit temp store root/project id, explicit `factoryStateRoot`, or explicit `allowWorkspaceLocalStateRoot` according to the helper under test.
  - The audit must include every occurrence of `spawnSync`, `runHarness(`, `["factory"`, and `['factory'` under `test/`; this readable inventory is authoritative if the inline grep command above is hard to copy.
  - Do not rely on fake real HOME unless the helper owns a temp `HOME` and `XDG_DATA_HOME`.
- Update existing factory triage/planning/implementation/linear-fetch/status/publication CLI tests and direct production-helper tests to use those helpers or pass explicit temp store roots. Tests that intentionally verify low-level `harness run factory-triage` may stay workspace-local.
- Add after-test assertions/helpers that fail if any factory CLI or production-helper verification writes outside its temp store root or creates an unexpected real `${XDG_DATA_HOME:-~/.local/share}/harness/store` tree.

**Gate 1 verify**:

```sh
rg -n "spawnSync|runHarness\\(|\\[\"factory\"|\\['factory'" test
pnpm test -- test/cli.test.ts test/factory-implementation-cli.test.ts test/factory-planning-apply-command.test.ts test/factory-triage-input.test.ts test/factory-planning-input.test.ts test/factory-implementation-input.test.ts
```

Expected: every grep hit is either routed through `runFactoryHarness()`, passes explicit temp durable store env/flags, or is documented as help/error-before-resolve or low-level workspace-local behavior. Focused tests pass and the helper assertion reports no writes under the real default user store. Gate 1 proves wrapper adoption and real-store protection only; Gate 3 owns helper signature/wiring proofs for `fetchFactoryLinearWorkItem`, `runFactoryPlanningWithLinearApply`, `runFactoryPlanningPublicationWithLinearApply`, and `runFactoryImplementationWithLifecycle`.

#### Step 4b: Artifact-path gate

Implement `formatLifecycleArtifactPath` and migrate lifecycle writers before any durable factory run-dir or nested review-dir default flip.

Add one lifecycle artifact path helper and use it everywhere lifecycle `data` records an artifact path:

```ts
formatLifecycleArtifactPath({
  workspace,
  runDir,
  projectRoot,
  path,
}): string
```

Contract:

- If `path` is not absolute, treat it as a run artifact field and first normalize it with `resolve(runDir, path)`.
- If `path` is under `runDir`, return the path relative to `runDir`.
- Else if `path` is under durable `projectRoot`, return a store/project-relative path.
- Else return an absolute path.
- Never return a `relative(workspace, path)` value that starts with `..`.
- Existing old event files with workspace-relative values remain readable.

Fields that must use this helper:

- Triage: `routeArtifactPath`, `triageArtifactPath`, failed `summaryPath`.
- Planning: failed `summaryPath`, completed `reviewFindingsPath`, `planReviewRefPath`; ensure the referenced review run can be located when nested review runs are under durable `runs/reviews`.
- Planning Linear comments/output: `bin/factory-commands.ts` `linearPlanningCompletedInput` and any `renderLinearPlanning*` callers must format `draftPlanPath`, `reviewFindingsPath`, `approvedPlanPath`, or similar displayed paths with `formatLifecycleArtifactPath` or an equivalent run/store-aware display formatter, not `relative(meta.workspace, ...)`, when run dirs are outside the workspace.
- Implementation: failed `summaryPath`, `rawOutputPath`, `streamLogPath`, `workspaceStatusPath`; completed `diffPath`, `changeReviewHandoffPath`, `rawOutputPath`, `streamLogPath`, `workspaceStatusPath`.
- Plan publication events do not need artifact paths beyond plan path/PR/commit metadata.

**Gate 2 verify**:

```sh
rg -n 'relative\\(.*workspace' lib/factory-lifecycle-writes.ts bin/factory-commands.ts
pnpm test -- test/factory-lifecycle.test.ts test/factory-triage-input.test.ts test/factory-planning.workflow.test.ts test/factory-planning-apply-command.test.ts test/factory-implementation.workflow.test.ts test/factory-implementation-run-context.test.ts
```

Expected: the `rg` audit has no lifecycle/display path formatting hits using `relative(...workspace...)` in `lib/factory-lifecycle-writes.ts` or `bin/factory-commands.ts`, unless a remaining hit has an inline justification proving it is not a lifecycle artifact or Linear display path. Focused lifecycle writer/comment tests pass with temp durable `runDir`/`projectRoot` injection, and assertions prove every listed lifecycle artifact/comment path field, including `linearPlanningCompletedInput` display paths, is run-relative, store-relative, or absolute, and never starts with `..`. Triage bare artifact names such as `factory-route.md` are already run-relative; keep them on the helper path without re-rooting through `workspace`.

#### Step 4c: Station cutover gate

Apply the station fail-closed cutover in this exact sub-order:

1. Extend helper signatures while workspace fallback still works:
   - Station-facing append/load/merge/fetch/publication helpers accept or require `factoryStateRoot?: string` as needed.
   - Wire every `harness factory ...` production call site to resolve the durable store and pass `resolution.factoryStateRoot`.
   - Preserve the Step 3b read-mode wiring: dry-runs/fetch remain inspect/read-only with warnings, live triage/planning/implementation remain load-mode readiness paths.
   - This includes live triage imports/appends, `runFactoryPlanningWithLinearApply`, every planning terminalization path, implementation lifecycle paths, publication fallback, `resolveFactoryWorkItemInput`, `mergeLifecycleState`, and `fetchFactoryLinearWorkItem`.
2. Add regression coverage before enabling the throw:
   - Exercise every live/non-dry-run station path with a temp durable store root.
   - Fail if any lifecycle event/state file is created under `<workspace>/.harness/factory`.
   - STOP if any live station path still relies on workspace-local fallback.
3. Only after sub-steps 1 and 2 pass, enable the fail-closed contract:
   - Station-facing append/load/merge/fetch/publication helpers must require `factoryStateRoot` once called from `harness factory ...` command paths.
   - `appendWorkItemImportedEvent`, `appendTriageStartedEvent`, `appendTriageTerminalEvent`, `appendPlanningStartedEvent`, `appendPlanningTerminalEvent`, `appendImplementationStartedEvent`, `appendImplementationTerminalEvent`, `appendPlanPrOpenedEvent`, and `appendPlanPrMergedEvent` must not call the soft workspace fallback unless `allowWorkspaceLocalStateRoot` or an equivalent explicit low-level/test flag is set.
   - Low-level helpers may keep `resolveFactoryStateRoot({ workspace })` workspace-local semantics only when the caller passes an explicit `allowWorkspaceLocalStateRoot: true` or similarly named test-only/low-level flag.
   - `harness factory ...` command paths must never set that flag; they must resolve the durable store and pass `resolution.factoryStateRoot`.
   - If a station-facing helper is called without `factoryStateRoot` and without the explicit low-level flag, it must throw a clear configuration error instead of writing to `<workspace>/.harness/factory`.
   - Add a regression that a station append helper called without `factoryStateRoot` throws and does not create `<workspace>/.harness/factory`.
- Resolve the store before `resolveFactoryWorkItemInput`.
- Pass `factoryStateRoot: resolution.factoryStateRoot` into `resolveFactoryWorkItemInput` while preserving the Step 3b `lifecycleReadMode`.
- In `fetchFactoryLinearWorkItem`, mirror the publication helper store contract instead of hiding all store resolution inside the helper:
  - Extend input with `factoryStateRoot?: string`, `factoryStoreRoot?: string`, `factoryStoreProjectId?: string`, and `env?: NodeJS.ProcessEnv`.
  - If `factoryStateRoot` is supplied, pass it directly to `mergeLifecycleState` with `lifecycleReadMode: "inspect"` and do not re-resolve the store.
  - Otherwise resolve through `resolveFactoryStore({ workspace, cli/env/config })`, then pass `factoryStateRoot: resolution.factoryStateRoot` and `lifecycleReadMode: "inspect"` into `mergeLifecycleState`.
  - Direct station-input tests and CLI tests must cover both explicit `factoryStateRoot` and CLI/env/config durable-store paths, and assert fetch remains read-only when lifecycle state is stale/missing/corrupt.
- Pass factory run root into `createFactoryRunContext`, `createFactoryPlanningRunContext`, and `createFactoryImplementationRunContext` unless `--runs-dir` is explicitly set.
- Pass `factoryStateRoot` into all lifecycle append helpers. Explicit call-site checklist:
  - Triage station action passes `resolution.factoryStateRoot` into `appendWorkItemImportedEvent`, `appendTriageStartedEvent`, and `appendTriageTerminalEvent`.
  - Extend `runFactoryPlanningWithLinearApply(input)` with `factoryStateRoot?: string`; station action passes `resolution.factoryStateRoot`; the helper forwards it into `appendWorkItemImportedEvent`, `appendPlanningStartedEvent`, and every `appendPlanningTerminalEvent` call, including failure terminalization.
  - Implementation station action passes `resolution.factoryStateRoot` into existing `runFactoryImplementationWithLifecycle`; that helper already accepts `factoryStateRoot` and forwards it to implementation append helpers.
  - Publication commands keep the meta-then-resolver fallback below.
- Publication command fallback order must be concrete:
  1. load existing planning `meta.json`;
  2. set `factoryStateRoot = meta.factoryStore?.factoryStateRoot ?? resolveFactoryStore({ workspace: meta.workspace, cli/env/config }).factoryStateRoot`;
  3. when `meta.factoryStore` is absent, build `resolvedFactoryStore = factoryStoreMetadata(resolution, execution)` and warning code/message `factory-store-meta-missing`;
  4. before appending lifecycle events, call the concrete meta update helper described below with `{ factoryStore: resolvedFactoryStore, warnings: appendUnique(meta.warnings, warning) }` so `meta.json` persists the fallback store metadata and warning;
  5. include `warnings: [{ code: "factory-store-meta-missing", message, factoryStateRoot }]` and `factoryStore: resolvedFactoryStore` in `factoryPlanningPublicationCliOutput` JSON when fallback was used;
  6. pass `factoryStateRoot` into `appendPlanPrOpenedEvent({ meta: updatedMeta, factoryStateRoot })` and `appendPlanPrMergedEvent({ meta: updatedMeta, factoryStateRoot })`.
- Extend planning meta persistence explicitly:
  - Add `factoryStore?: FactoryStoreMeta` and `warnings?: Array<{ code: string; message: string; factoryStateRoot?: string }>` to `FactoryPlanningRunMeta`.
  - Extend `FactoryPlanningRunMetaSchema` to parse those fields directly; do not rely only on `.passthrough()` for fallback metadata.
  - Extend the exported planning meta JSON shape so new `meta.json` files write `factoryStore` from the run context.
  - Add `updateFactoryPlanningRunMeta(runDir, patch)` in `lib/factory-planning-handoff.ts` or an adjacent module. It must load `meta.json`, validate it, set `factoryStore`, append warnings uniquely by `code` + `factoryStateRoot`, write atomically, and return the updated meta.
  - Keep `updateFactoryPlanningHandoff` focused on handoff/factory metadata unless widening it is cleaner; if widened, update `FactoryPlanningHandoffPatch` to include `factoryStore` and `warnings` explicitly.
  - Do not hide fallback warnings only in stderr; CLI JSON must include them.
- Extend publication CLI output explicitly:
  - Update `factoryPlanningPublicationCliOutput` and its return/output type, for example `FactoryPlanningPublicationOutput`, to accept and emit `factoryStore?: FactoryStoreMeta` and `warnings?: Array<{ code: string; message: string; factoryStateRoot?: string }>`.
  - Thread those fields from `runFactoryPlanningPublicationWithLinearApply` into the CLI output helper for legacy-meta fallback cases.
  - The legacy-meta publication test must assert both updated `meta.json` and CLI JSON include `factoryStore.factoryStateRoot` and `warnings[0].code === "factory-store-meta-missing"`.
- Add a focused publication test with legacy planning `meta.json` lacking `factoryStore`: after `planning publish` or `mark-plan-merged`, CLI JSON contains `warnings[0].code === "factory-store-meta-missing"`, updated `meta.json` contains the same warning plus `factoryStore.factoryStateRoot`, and lifecycle append uses that durable root.
- Extend `runFactoryPlanningPublicationWithLinearApply(input)` so the publication helper receives the same store override surface as the CLI:
  - `factoryStoreRoot?: string`
  - `factoryStoreProjectId?: string`
  - `env?: NodeJS.ProcessEnv`
  - resolver/config inputs needed by `resolveFactoryStore`
- `factory planning publish` and `factory planning mark-plan-merged` must parse `--factory-store-root` / `--factory-store-project-id`, pass them into `runFactoryPlanningPublicationWithLinearApply`, and let that helper resolve `meta.factoryStore` first, then CLI/env/config fallback from `meta.workspace`.
- Do not change `bin/harness.ts` low-level `harness run factory-triage` default. It remains workspace-local unless `--runs-dir` is passed.

Update run context types:

- Add a shared serializable `FactoryStoreMeta` shape, derived from `FactoryStoreResolution`, with `storeRoot`, `projectId`, `projectRoot`, `factoryStateRoot`, `factoryRunsDir`, `reviewRunsDir`, `repo`, `overrides`, and `warnings`.
- Before any lifecycle append helper writes store/repo fields into `execution`, extend `ExecutionSchema` in `lib/factory-lifecycle.ts` to allow those fields. This schema change is part of Step 4, not a later phase, because Step 4 routes station writes through durable roots and immediately starts exporting `factoryStore` provenance. The updated `ExecutionSchema` must:
  - keep old event files valid when they only contain `workspace` and optional `runDir`/`branch`/`head`;
  - allow optional `storeRoot`, `projectId`, and `factoryStateRoot`;
  - allow optional strict `repo: { name: string; id: string; idSource: "config" | "cli" | "env" | "origin" | "no-origin-fallback" | "workspace-fallback"; originHash?: string; workspaceHash?: string }`;
  - exclude `normalizedOriginUrl` from lifecycle events even after credential scrubbing; it may remain in local run `factoryStore` metadata, but lifecycle execution provenance uses identifiers/hashes only;
  - remain strict so accidental provenance keys still fail validation.
- Extend context options:
  - `FactoryRunContextFactoryOptions.factoryStore?: FactoryStoreMeta`
  - `FactoryPlanningRunContextOptions.factoryStore?: FactoryStoreMeta`
  - `FactoryPlanningRunContextOptions.reviewRunsDir?: string`
  - `FactoryImplementationRunContextOptions.factoryStore?: FactoryStoreMeta`
- Extend the concrete planning context object/type, not just options:
  - `FactoryPlanningRunContext` must expose `reviewRunsDir?: string`.
  - `createFactoryPlanningRunContext` must set `ctx.reviewRunsDir = options.reviewRunsDir`.
  - test-only factory helpers that construct planning contexts must either pass `reviewRunsDir` through or intentionally leave it `undefined`.
  - `undefined` remains the compatibility value: nested `createWorkflowContext` then keeps today’s workspace-local review default.
- Station commands must call `resolveFactoryStore`, pass `factoryStore: factoryStoreMetadata(resolution, ...)` into `createFactoryRunContext`, `createFactoryPlanningRunContext`, and `createFactoryImplementationRunContext`, and pass `reviewRunsDir: resolution.reviewRunsDir` into planning.
- `FactoryRunMeta`, `FactoryPlanningRunMeta`, and `FactoryImplementationRunMeta` must write `factoryStore` into every `meta.json` export.
- Add or preserve `execution` on run meta with at least `workspace`, `runDir`, optional `branch`, and optional `head`. Build branch/head from a soft Git probe that never fails the station outside Git repos.
- Lifecycle execution helpers in `lib/factory-lifecycle-writes.ts` must consume run meta, not re-resolve from workspace:
  - `executionFromMeta(meta: FactoryRunMeta)`
  - `planningExecution(meta: FactoryPlanningRunMeta)`
  - `implementationExecution(meta: FactoryImplementationRunMeta)`
- Because `ExecutionSchema` is extended earlier in this step, those helpers may include `meta.factoryStore` fields and soft Git branch/head in lifecycle event `execution` during Step 4. Publication fallback depends on `meta.factoryStore.factoryStateRoot`; do not omit it from exported meta.
- `workflows/factory-planning.workflow.ts` uses `runsDir: ctx.reviewRunsDir` in nested `createWorkflowContext`. Passing `undefined` is intentional and preserves today's workspace-local default through `createWorkflowContext`; do not use a non-null assertion or `join(undefined, ...)`.

Keep standalone review behavior:

- Do not change `lib/workflow-context.ts` default for normal `harness run plan-review` / `change-review`.
- Only factory planning passes durable `reviewRunsDir`.

Tests:

- Add/extend CLI tests for default durable run dirs under a temporary fake home/store root. Do not write real `~/.harness` in tests; use CLI/env override or injected env.
- Factory triage live helper writes lifecycle under durable `factoryStateRoot`, not workspace `.harness/factory`.
- Triage station test fails if `<workspace>/.harness/factory` is created when a temp store root is configured.
- `factory linear fetch` overlays lifecycle state from durable `factoryStateRoot` under a temp store root.
- Factory planning dry-run writes factory run artifacts under durable factory runs root.
- Planning live/failure helper tests fail if lifecycle appends land under `<workspace>/.harness/factory` when `factoryStateRoot` is supplied.
- Factory planning nested plan-review writes under durable reviews root and `plan-review-ref.json` points there.
- Factory implementation dry-run/live context writes under durable factory runs root.
- Implementation station test fails if lifecycle appends land under `<workspace>/.harness/factory` when a temp store root is configured.
- Explicit `--runs-dir` still writes run artifacts there and records the override, while lifecycle state remains at durable `factoryStateRoot`.
- `test/factory-planning.workflow.test.ts` covers both paths: with injected temp `reviewRunsDir`, `ctx.reviewRunsDir` is populated and nested plan-review uses the durable reviews root; without `reviewRunsDir`, `ctx.reviewRunsDir` is `undefined` and the existing workspace-local review default remains intentional.
- Update `test/factory-planning-apply-command.test.ts` and related CLI publication tests to seed/read lifecycle state under a temp `factoryStateRoot`, including the legacy-meta fallback warning case.
- Update `test/factory-implementation-cli.test.ts` to use the shared temp-store wrapper for every `harness factory implementation ...` CLI invocation or to pass explicit temp store env/flags. This file must be part of Step 4 verification because implementation CLI calls can otherwise hit the real default store after cutover.
- Audit every test file that shells out to `harness factory ...` or calls production factory input helpers that can reach `resolveFactoryStore`; if a command/helper can reach durable store resolution, it must use the temp-store wrapper, an explicit temp store root, or an explicit `factoryStateRoot`. Keep a helper assertion that fails on unexpected writes outside the temp store.
- `test/factory-triage-input.test.ts`, `test/factory-planning-input.test.ts`, and `test/factory-implementation-input.test.ts` must be handled explicitly: either keep narrowly documented low-level workspace-local tests for `resolveFactoryStateRoot({ workspace })` with `allowWorkspaceLocalStateRoot`, or point production merge/readiness cases at a temp durable `factoryStateRoot`.
- Publication/apply tests must stop asserting lifecycle through `resolveFactoryStateRoot({ workspace })` except for explicit low-level legacy fallback tests.
- Publication tests cover both new meta with `factoryStore` and legacy meta without it; the legacy case must show the fallback warning and append to the resolver-selected durable root.

Step 4 single done gate:

- Gate 1 complete: all production `harness factory ...` test invocations use `runFactoryHarness()` or explicit temp durable store env/flags, and help/error-before-resolve exemptions are documented inline.
- Gate 2 complete: `formatLifecycleArtifactPath` is implemented before durable run-dir default flips, and no-`..` regressions cover the listed triage/planning/implementation lifecycle fields plus Linear planning comment/display paths.
- Gate 3 complete: every production station call site passes `resolution.factoryStateRoot`, fail-closed missing-root behavior is enabled afterward, `factoryStore` meta is exported, nested `reviewRunsDir` is durable, and publication fallback persists/prints warnings.
- Durable factory state roots are used for station input, fetch, lifecycle appends, publication, and implementation readiness.
- Durable factory run dirs and nested review run dirs are used by default for `harness factory ...` station commands.
- Station-facing helpers fail closed rather than falling back to `<workspace>/.harness/factory` unless an explicit low-level/test-only workspace-local flag is set.
- Helper-level proofs cover `fetchFactoryLinearWorkItem`, `runFactoryPlanningWithLinearApply`, `runFactoryPlanningPublicationWithLinearApply`, and `runFactoryImplementationWithLifecycle` with temp `factoryStateRoot`/store overrides before fail-closed behavior is enabled.
- `factoryStore` meta is present in run metadata and lifecycle execution provenance.
- Publication commands use `meta.factoryStore.factoryStateRoot` first and warn when falling back through CLI/env/config resolution for legacy meta.
- `lib/factory-linear-adapter.ts` comments say durable-store lifecycle is canonical when present and workspace-local lifecycle is legacy/ignored in v1.
- `formatLifecycleArtifactPath` is implemented and all listed lifecycle artifact fields are regression-tested against `..` paths under temp durable run roots.
- The shared `test/factory-store-test-helpers.ts` wrapper is used by every test path that can reach production durable store resolution.
- The implementation readiness regression proves durable lifecycle `plan-approved` still requires the approved plan file materialized in the current workspace.

**Verify**: `pnpm test -- test/factory-triage-input.test.ts test/factory-planning-input.test.ts test/factory-planning.workflow.test.ts test/factory-planning.workflow-failures.test.ts test/factory-planning-apply-command.test.ts test/factory-implementation-input.test.ts test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts test/factory-implementation-cli.test.ts test/cli.test.ts` -> all pass and includes the no-`..` artifact-path assertion under temp durable store roots and nested review run-dir assertions for success and failure paths.

Private execution helper guidance:

- Extend the existing private helpers in `lib/factory-lifecycle-writes.ts` in place unless tests require export:
  - `executionFromMeta(meta: FactoryRunMeta)`
  - `planningExecution(meta: FactoryPlanningRunMeta)`
  - `implementationExecution(meta: FactoryImplementationRunMeta)`
- These helpers should copy optional execution fields from run meta/factory store metadata into lifecycle `execution`: `workspace`, `runDir`, `branch`, `head`, `storeRoot`, `projectId`, `factoryStateRoot`, and the exact strict `repo` identity above. They must not copy `normalizedOriginUrl`, credentials, or raw remote URLs into lifecycle events.
- Publication events should reuse the same execution/provenance contract when they derive lifecycle state from planning `meta.json`.

### Step 5: Make factory status report store, locks, and legacy warnings

Update `lib/factory-inbox.ts` or add `lib/factory-status.ts`:

- Prefer a thin `lib/factory-status.ts` composer that calls the existing inbox status helper and adds store/lock/legacy fields. Avoid changing `factoryInboxStatus` return semantics unless necessary, so inbox unit tests stay focused on inbox behavior.
- Preserve existing inbox fields for compatibility.
- Add `store` object:
  - `storeRoot`, `projectId`, `projectRoot`, `factoryStateRoot`, `factoryRunsDir`, `reviewRunsDir`, `repo`, `warnings`.
- Add `locks`:
  - held locks with workItemKey/filename, owner pid/hostname/workspace/runDir when parseable, startedAt, ageMs, stale boolean/warning, and `owner-missing` / `owner-invalid` classification when applicable.
- Add `legacyFactoryState`:
  - workspace-local path, event count, state count, ignored boolean, warnings.
- If the durable store has no lifecycle events/state for the project but legacy workspace-local `.harness/factory` exists, status must show a first-class warning: durable store starts empty for this project and legacy workspace-local lifecycle is ignored in v1.

Update `bin/factory-commands.ts` `factory status`:

- Accept store root/project id options and env/config.
- Do not block on held locks.
- Do not create run dirs or state dirs just by running status.
- Use only the lock-free lifecycle inspection helper from Step 3. Do not call `loadFactoryLifecycleState`, `mergeLifecycleState`, or any helper that can acquire/rebuild under a lifecycle lock.

Tests:

- Existing inbox status tests still pass after output grows.
- Status reports active store root/project id.
- Status reports held/stale/incomplete-owner locks using prepared lock dirs.
- Status reports same-host dead pid stale, old lock stale, remote/unknown-owner hostname mismatch, owner-missing, and owner-invalid without mutating any lock.
- Status reports ignored workspace-local `.harness/factory` when files exist.
- Status reports the empty-durable-store plus ignored-legacy warning as a top-level warning, not only nested detail.
- Status does not create `.harness/runs/factory`.
- Status against an empty temp durable store root creates no `storeRoot`, `projectRoot`, state, run, or lock directories.
- Status does not wait for or fail on a held lifecycle lock; it reports the lock metadata and any existing state/events as observed.

**Verify**: `pnpm test -- test/cli.test.ts test/factory-inbox.test.ts test/factory-lifecycle.test.ts` -> all pass.

### Step 6: Update docs

Update docs after code behavior is real:

- `docs/project-intent.md`
  - Confirm the revised invariant from Step 1 matches shipped behavior.
  - Keep current-vs-planned language accurate.
- `README.md`
  - Factory artifacts default to `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/...`.
  - Explain that the default is intentionally outside the documented harness checkout path `~/.harness`.
  - Workspace `.harness/inbox/factory` and shim remain workspace-local.
  - `--factory-store-root`, `--factory-store-project-id`, env vars, and `factory.store` config.
  - Standalone reviews remain workspace-local unless their own `--runs-dir` is used.
  - `harness runs prune` remains explicit-path based for durable factory runs; use `--runs-dir <store>/projects/<repo-id>/runs/factory` until a store-aware prune command exists.
- `docs/contributing/factory.md`
  - Replace lifecycle source-of-truth wording with durable store wording.
  - Document JSONL + per-work-item locks + state as projection.
  - Document dry-run lifecycle behavior: dry-run input overlay is side-effect-free, does not rebuild stale projections or acquire lifecycle locks, and warns when durable lifecycle state may be stale.
  - Document legacy workspace-local state warning/no silent merge. Make the cutover explicit: after FER-53, the durable store starts empty for a repo id unless new factory stations have written there; old workspace-local `.harness/factory` is detected and ignored, not imported.
  - Document local filesystem locking assumption; network filesystem locking out of scope.
  - Add a temporary note that operator skill docs and prune commands must point at durable factory roots.
- `docs/contributing/architecture.md`
  - Move factory lifecycle/run ownership from target repo to durable store.
  - Keep target repo owning shim, inbox, source, tests, plans, and Git materialization.
- `docs/contributing/script-command-surface.md`
  - Update artifact-writing rows and status behavior.
- `docs/contributing/setup-manifest.md`
  - Replace factory lifecycle/run rows with durable store paths.
  - Keep workspace-local `.harness/factory` rows only as legacy ignored local state, if documented.
  - Update prune notes for durable factory runs.
- `skills/factory-operator/SKILL.md`
  - Update command guidance to say lifecycle/factory run evidence defaults to durable store.
  - Update Linear fetch wording to durable lifecycle merge.
  - Document that dry-runs can warn about stale durable lifecycle state without rebuilding it; live station runs perform rebuilds under lock when needed.
  - Update artifact lookup/prune guidance to use reported `runDir` and store roots, not assumed workspace-local paths.
  - Add a visible cutover warning: an empty durable store is expected after upgrade until factory commands write new lifecycle events; legacy workspace `.harness/factory` is ignored.
- `test/docs-contracts.test.ts`
  - Update factory lifecycle generated artifact assertions from workspace-local `.harness/factory/events` / `state` to durable store paths and legacy warning language.
- `scripts/smoke-dist.ts`
  - Update factory help assertions for every command that gains `--factory-store-root` and `--factory-store-project-id`: status, linear fetch, triage, planning run/publish/mark-plan-merged, and implementation run.
  - If smoke-dist does not cover one of those commands today, add a focused CLI help test and reference it in this step.

**Verify**: `pnpm test -- test/docs-contracts.test.ts && pnpm format:check` -> pass.

### Step 7: Full verification and smoke tests

Automated verification:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm check`

Manual/local smoke without real `~/.harness` writes:

```bash
STORE="$(mktemp -d)/store"
WORKSPACE="$(mktemp -d)"
cd "$WORKSPACE"
git init
git remote add origin git@github.com:example/example-repo.git
cat > harness.json <<'JSON'
{ "base": "main" }
JSON
node /path/to/harness/bin/harness.ts factory status --workspace "$WORKSPACE" --factory-store-root "$STORE"
```

Expected:

- JSON contains `store.storeRoot == "$STORE"`.
- JSON contains `store.projectRoot` under `$STORE/projects/`.
- No `.harness/runs/factory` created in `$WORKSPACE`.

Factory dry-run smoke:

```bash
cat > "$WORKSPACE/item.json" <<'JSON'
{
  "id": "local-1",
  "source": "file",
  "title": "Durable store smoke",
  "body": "Verify durable run artifact placement.",
  "labels": []
}
JSON
node /path/to/harness/bin/harness.ts factory triage --workspace "$WORKSPACE" --item-file item.json --dry-run --factory-store-root "$STORE"
```

Expected:

- stdout `runDir` is under `$STORE/projects/<repo-id>/runs/factory`.
- No lifecycle event is written because dry-run.

Linear-backed smoke, authorized operator only:

1. Use a throwaway Linear issue in the configured Harness project. Its body should clearly request planning so triage routes `ready-to-plan`.
2. Run:

```bash
HARNESS_FACTORY_STORE_ROOT="$STORE" LINEAR_API_KEY=... node /path/to/harness/bin/harness.ts factory triage --workspace /path/to/repo --linear-issue FER-TEST
HARNESS_FACTORY_STORE_ROOT="$STORE" LINEAR_API_KEY=... node /path/to/harness/bin/harness.ts factory linear fetch FER-TEST --workspace /path/to/repo
HARNESS_FACTORY_STORE_ROOT="$STORE" LINEAR_API_KEY=... node /path/to/harness/bin/harness.ts factory planning run --workspace /path/to/repo --linear-issue FER-TEST --dry-run
node /path/to/harness/bin/harness.ts factory status --workspace /path/to/repo --factory-store-root "$STORE"
```

Expected:

- Triage writes lifecycle events/state under `$STORE/projects/<repo-id>/factory`.
- Linear fetch output merges durable lifecycle fields over Linear fallback metadata.
- Planning dry-run reads the durable ready-to-plan state and writes factory run artifacts under `$STORE/projects/<repo-id>/runs/factory`.
- Status reports the active store root, no dependency on Cos archiving, and no workspace-local lifecycle source of truth.

## Done Criteria

All must hold:

- [ ] Default factory lifecycle events/state write under `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/factory`, or a test/operator override, not workspace `.harness/factory`.
- [ ] Default factory station run artifacts write under `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/runs/factory`.
- [ ] Factory planning nested plan-review artifacts write under `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/runs/reviews`.
- [ ] Default store root is outside a documented harness checkout at `~/.harness`.
- [ ] Explicit project ids from CLI/env/config are validated as safe single path segments, traversal attempts fail before directory creation, and `projectRoot` containment is checked.
- [ ] Factory CLI tests inject temp store roots for station/status/publication/fetch commands through spawn-scoped env/flags, in-process tests pass explicit env objects without mutating ambient `process.env`, and verification fails if it writes outside those temp roots.
- [ ] Gate 1 wrapper adoption is complete: every production `harness factory ...` test path uses `runFactoryHarness()` or explicit temp durable store env/flags; help/error-before-resolve exemptions are documented.
- [ ] Gate 2 artifact-path migration is complete before durable run-dir flips: no lifecycle artifact path or Linear planning comment/display path under temp durable run roots starts with `..`.
- [ ] Gate 3 station cutover is complete as a unit: production call sites pass `resolution.factoryStateRoot`, fail-closed missing-root behavior is enabled only after that wiring, `factoryStore` meta is written, and nested `reviewRunsDir` uses the durable store.
- [ ] Standalone review workflows still default to workspace `.harness/runs/reviews`.
- [ ] Low-level `harness run factory-triage` still defaults to workspace `.harness/runs/factory` unless `--runs-dir` is set.
- [ ] CLI/env/config/default precedence is tested.
- [ ] Repo id derivation and explicit project id override are tested, including no-origin fallback.
- [ ] Per-work-item locking is tested for first-use parent creation, atomic non-recursive acquisition, same issue serialization, different issue independence, idempotent duplicate handling, stale lock reporting, and incomplete-owner handling.
- [ ] Stale/missing/corrupt state projection rebuilds from valid JSONL; inspect-only paths warn and perform no writes.
- [ ] `resolveFactoryWorkItemInput` merges lifecycle state from the durable store.
- [ ] `factory linear fetch` overlays durable lifecycle state in inspect/read-only mode and reports stale/missing/corrupt/lock warnings without waiting, rebuilding, or writing lifecycle projections.
- [ ] Planned implementation still fails when the approved plan file is absent from the execution workspace.
- [ ] `factory status` reports store root, locks, stale warnings, and ignored legacy workspace-local state without blocking.
- [ ] `factory status` reports empty durable store plus ignored legacy workspace-local lifecycle as a first-class warning.
- [ ] `factory status` uses lock-free lifecycle inspection and never acquires/rebuilds lifecycle state.
- [ ] Factory station `meta.json` files include `factoryStore` metadata, and lifecycle `execution` fields include the exact strict store/project/repo provenance schema without `normalizedOriginUrl`.
- [ ] Lifecycle artifact paths for durable run dirs never start with `..` and use run-relative or store-relative/absolute paths.
- [ ] Docs reflect workspace/store/projection/Git split.
- [ ] Step 1 docs remained planned-tense only; no present-tense durable-store docs-contract assertions were added before the runtime cutover and final docs step.
- [ ] Present-tense `docs/project-intent.md` durable-store ownership claims land only in Step 6 after runtime behavior and tests are complete.
- [ ] `pnpm check` passes.
- [ ] Linear-backed smoke executed or explicitly skipped with reason (missing credentials or no throwaway issue).

## STOP Conditions

Stop and report if:

- Current code no longer has the workspace-local defaults identified above.
- Step 1 would require present-tense durable-store ownership or docs-contract path assertions before runtime behavior ships.
- Supporting non-git workspace fallback appears to require changing bare-CWD `resolveHarnessWorkspace` / Git-root discovery behavior instead of using an explicit resolved `--workspace` path or `harness.json` parent.
- A clean implementation appears to require changing Linear status semantics.
- A clean implementation appears to require worktree orchestration, batch dispatch, Inngest, GitHub/Jira mutation, or Cos archiving.
- You cannot implement per-work-item locking with local filesystem primitives without a new dependency.
- Valid-owner stale-lock recovery cannot safely compare owner `pid`/`hostname`/`token` before removing a lock, or owner-missing recovery cannot use empty-directory-only `rmdirSync` after the age/recheck contract.
- `factory.store` config cannot be added without breaking existing `harness.json` parsing.
- Publication commands cannot reliably find durable lifecycle state from run metadata.
- Any production path would rely on `resolveFactoryStateRoot({ workspace })` to find the durable store instead of passing a root from `resolveFactoryStore`.
- Tests require writing to real `~/.harness` instead of temp store roots.
- Any verification run writes factory store data outside its configured temp store root.
- Existing committed plan/code materialization would be bypassed by durable metadata.
- Any verification command fails twice after targeted fixes.

## Maintenance Notes

- SQLite is intentionally deferred. Revisit only if JSONL + per-work-item locks fail under real factory concurrency or cross-issue queries become important.
- Network filesystem locking is out of scope for v1; document local filesystem assumptions.
- Future FER-30 worktree execution should call the store resolver instead of deriving paths from worktree directories.
- Any future artifact pruning command must understand durable store roots and avoid deleting active lock/run evidence.
- Reviewers should scrutinize path provenance carefully: no credentials in origin URLs, no misleading workspace-relative paths for durable artifacts, and no silent merge of legacy workspace-local logs.
