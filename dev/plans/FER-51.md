# Plan 260709-linear-create: Add constrained Linear intake create

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If a STOP condition occurs, stop and report. Do not improvise a broader
> Linear client.

## Requirements

- Add `harness factory linear create` as a tiny intake-authoring helper, not a
  station.
- Require `LINEAR_API_KEY` and `factory.linear`.
- Always create in configured `factory.linear.teamKey`, configured
  `factory.linear.projectId`, and configured `factory.linear.statuses.intake`.
- Require a non-empty title and non-empty body content.
- Accept body content from exactly one command source:
  - `--body "..."`
  - `--body-file path.md`
  - stdin, only when neither body flag is present
- Print compact JSON only:
  - `{ "identifier": "TEAM-123", "url": "...", "id": "linear:TEAM-123" }`
- Do not add `--dry-run`, `--apply`, `--format`, labels, assignee, priority,
  parent issue, status override, batch create, auto-triage, or GitHub/Jira
  create.
- Do not append lifecycle events or create factory run artifacts. The first live
  station remains the import boundary.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Issue**: FER-51

## Why this matters

Backlog intake currently needs ad-hoc Linear SDK scripts or the Linear UI. A
constrained harness command keeps repeated dogfood issue creation on the same
workspace-bound Linear config as factory list/fetch, while avoiding a broad
Linear authoring client. The command is intentionally a new, narrow write path:
it authors one intake issue and exits with a handoff identifier for later
`harness factory linear fetch` or station commands.

Project intent constraints from `docs/project-intent.md` apply here: durable
docs must stay generic and standalone, provider-specific behavior belongs behind
adapters, and current behavior must stay clearly separated from planned work.
For this feature, that means keep the Linear write behind the Linear adapter,
use generic target-repo examples only, and add no lifecycle/run artifacts for
create.

## Current state

- Verified branch: `plan/FER-51-linear-create`; `git status --short` was clean
  before this draft was written.
- Dependencies are declared but not installed in this planning sandbox:
  `node bin/harness.ts factory linear --help` failed with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'commander'`. Executor should run
  install before code gates.
- `package.json` scripts:
  - `pnpm typecheck` -> `tsc -p tsconfig.json --noEmit`
  - `pnpm test` -> `vitest run`
  - `pnpm build` -> `tsc -p tsconfig.build.json`
  - `pnpm smoke:dist` -> `node scripts/smoke-dist.ts`
  - `pnpm check` -> `make check`
- `package.json` pins `@linear/sdk` to `88.0.0`, `commander` to `15.0.0`,
  TypeScript to `6.0.3`, and Vitest to `4.1.9`.
- `bin/factory-commands.ts:177-209` registers only `linear list` and
  `linear fetch`. `list` validates `--status`, resolves `factory.linear`, checks
  `LINEAR_API_KEY`, parses configured status keys, calls the adapter, and prints
  pretty JSON.
- `bin/factory-commands.ts:211-232` has `fetchFactoryLinearWorkItem(...)`, a
  useful pattern for a testable create helper with injectable settings and
  adapter factory.
- `lib/factory-linear-adapter.ts:63-80` defines `LinearFactoryAdapter`. It has
  fetch/list/apply methods only; no create method.
- `lib/factory-linear-adapter.ts:120-139` creates the SDK client and facade.
  This is where the new adapter method should be wired.
- `lib/factory-linear-adapter.ts` already keeps extracted Linear behavior behind
  private deps objects: `LINEAR_PLANNING_APPLY_DEPS` and `LINEAR_LIST_DEPS`.
  Create should follow that pattern instead of exporting private helper
  functions or duplicating team/state resolution.
- `lib/factory-linear-adapter.ts:440-493` maps a Linear issue into
  `FactoryWorkItem`. Create must not reuse this as stdout; compact ack is the
  locked v1 output.
- `lib/factory-linear-list.ts:81-135` shows the preferred pattern for
  constrained Linear behavior behind the adapter: validate inputs, use
  configured status names/project filter, return typed JSON.
- `lib/factory-linear-types.ts:1-7` defines the local SDK surface. It currently
  includes `issue`, `issues`, `teams`, `updateIssue`, and `createComment`; it
  needs a narrow `createIssue` surface for v1 create.
- `lib/factory-run-context.ts:125-131` has the existing relative file convention
  for factory item files: resolve absolute paths unchanged, otherwise
  `join(workspace, itemFile)`, then fail if the file does not exist. Reuse this
  behavior for `--body-file`, but read UTF-8 markdown body content instead of
  parsing JSON.
- `docs/contributing/factory.md:193-225` documents list/fetch as read-only,
  project-scoped, and status-map validated. Create docs must preserve that
  model while calling out the new write class.
- `docs/contributing/script-command-surface.md:30-35` classifies list/fetch as
  read-only and station apply paths as Linear mutations. This table must be
  updated so create does not look like a station or an apply path.
- `README.md:122-130` says Linear list/fetch use `LINEAR_API_KEY` and
  `factory.linear`, and `--apply` is explicit for triage/planning mutations.
  Update this without suggesting create needs `--apply`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0, `node_modules/` available |
| SDK API check | `rg -n "createIssue|IssuePayload" node_modules/@linear/sdk` | hits showing the v88 create method and payload contract |
| Focused adapter tests | `pnpm test -- test/factory-linear-adapter.test.ts` | exit 0 |
| Focused CLI tests | `pnpm test -- test/cli.test.ts` | exit 0 |
| Docs contract tests | `pnpm test -- test/docs-contracts.test.ts` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0 |
| Format check | `pnpm format:check` | exit 0 |
| Build | `pnpm build` | exit 0, `dist/` built |
| Dist smoke | `pnpm smoke:dist` | exit 0 |
| Full gate | `pnpm check` | exit 0 |

## Skills for the executor

| Skill/tool | Verified source | Use for |
| --- | --- | --- |
| `implement-plan` | `skills/implement-plan/SKILL.md` | Execute this plan phase by phase; stop on drift or scope mismatch. |
| `factory-operator` | `skills/factory-operator/SKILL.md` | Preserve factory command vocabulary, Linear mutation boundaries, and docs wording. |
| `node` | `.agents/skills/node/SKILL.md` | Maintain Node native TypeScript patterns: `.ts` imports, type-only imports, no enums/namespaces/parameter properties. |
| `typescript-refactor` | `.agents/skills/typescript-refactor/SKILL.md` | Add typed adapter contracts without unsafe casts or broad `unknown` plumbing. |
| `vitest` | `.agents/skills/vitest/SKILL.md` | Add isolated Vitest coverage for adapter, CLI input validation, and help text. |

## Scope

**In scope:**

- `bin/factory-commands.ts`
- `lib/factory-linear-adapter.ts`
- `lib/factory-linear-types.ts`
- New helper file if useful: `lib/factory-linear-create.ts`
- `test/factory-linear-adapter.test.ts`
- `test/factory-linear-test-helpers.ts`
- `test/cli.test.ts`
- `scripts/smoke-dist.ts`
- `README.md`
- `docs/contributing/factory.md`
- `docs/contributing/script-command-surface.md`
- `docs/contributing/architecture.md`
- `docs/contributing/setup-manifest.md`
- `skills/factory-operator/SKILL.md`

**Out of scope:**

- `workflows/*` station behavior.
- `lib/factory-lifecycle*` event contracts.
- Planning/triage apply semantics.
- `FactoryWorkItem` schema changes.
- `factory.linear.statuses` schema changes.
- `dev/plans/README.md` implementation bookkeeping unless the plan publication
  process explicitly asks for it.
- Any live Linear test in CI.
- Any `--dry-run`, `--apply`, `--format`, status override, label, assignee,
  priority, parent issue, template, duplicate detection, batch import, or
  auto-triage feature.
- Package upgrades unless the locked SDK type check proves the current version
  cannot create an issue.

## Steps

### Step 1: Install and verify SDK create surface

Run:

```bash
pnpm install --frozen-lockfile
rg -n "createIssue|IssuePayload" node_modules/@linear/sdk
```

Confirm the installed `@linear/sdk@88.0.0` exposes an issue create method. The
expected input shape is a client method equivalent to:

```ts
client.createIssue({
  teamId,
  projectId,
  stateId,
  title,
  description,
})
```

Also inspect the return type. In `@linear/sdk` v88, `createIssue` returns an
`IssuePayload`-style object with `success` and a lazy `issue` relation. The
adapter implementation must not treat the mutation result as the created issue.
Expected output handling:

```ts
const result = await client.createIssue(...);
if (!result.success) throw new Error("Linear issue create failed.");
const issue = await result.issue;
```

If the installed API uses a different method or payload, adapt only the narrow
SDK call inside the adapter. Do not redesign the command.

**Verify**: `rg -n "createIssue|IssuePayload" node_modules/@linear/sdk` -> SDK
type/source hits show both the create method and the response payload shape.

### Step 2: Add the constrained adapter create operation

Implement the create behavior behind `LinearFactoryAdapter`, not directly in
the CLI action.

Preferred shape:

- Add a small `lib/factory-linear-create.ts` to keep
  `lib/factory-linear-adapter.ts` from growing further. The adapter file is
  already about 764 lines, above the repo guideline.
- Define:
  - `LinearCreateWorkItemInput = { title: string; body: string }`
  - `LinearCreateWorkItemResult = { id: string; identifier: string; url: string }`
  - `createLinearWorkItem(...)`
- Update `LinearFactoryAdapter` with:
  - `createWorkItem: (input: LinearCreateWorkItemInput) => Promise<LinearCreateWorkItemResult>`
- Update `createLinearFactoryAdapterForClient(...)` to pass private adapter
  helpers into `createLinearWorkItem(...)`.
- Add a private `LINEAR_CREATE_DEPS` object in `lib/factory-linear-adapter.ts`
  with exactly the private helpers create needs:
  `validateStatusMap`, `fetchTeam`, and `fetchWorkflowState`. Pass this deps
  object into `createLinearWorkItem(...)`, mirroring the existing
  `LINEAR_LIST_DEPS` / `LINEAR_PLANNING_APPLY_DEPS` extraction pattern. Do not
  export those private helpers and do not duplicate their logic in the new file.
- Update `LinearClientLike` with the narrow SDK surface needed by create. Add a
  payload type only as broad as needed to check `success` and await the created
  issue's identifier/url.

Required adapter behavior:

1. Trim title/body at the boundary.
2. Reject empty/whitespace title before any Linear mutation.
3. Reject empty/whitespace body before any Linear mutation.
4. Require `settings.projectId`; throw
   `factory.linear.projectId is required for Linear create.` before mutation
   when missing. List/fetch may keep optional project scope; create must not.
5. Call `validateStatusMap(client, settings)` so create has the same configured
   status-map validation posture as list/fetch.
6. Resolve configured team by `teamKey`.
7. Resolve configured intake workflow state from `settings.statuses.intake`.
8. Call the SDK create method with only `teamId`, `projectId`, `stateId`,
   trimmed `title`, and trimmed `description`.
9. Check the create result:
   - if `result.success` is false, throw `Linear issue create failed.`
   - await the lazy created issue relation, e.g. `const issue = await result.issue`
   - throw a clear error if the awaited issue is missing `identifier` or `url`
10. Return compact ack JSON from the awaited created issue:

```json
{
  "identifier": "ENG-124",
  "url": "https://linear.app/acme/issue/ENG-124/example",
  "id": "linear:ENG-124"
}
```

11. Do not call `updateIssue`, `createComment`, lifecycle writers, or station
    code.

If the SDK returns a payload without an issue identifier or URL, throw a clear
error instead of guessing or performing a broad search.

**Verify**: `pnpm test -- test/factory-linear-adapter.test.ts` -> existing tests
plus new create tests pass.

### Step 3: Add the CLI command and body-source resolver

In `bin/factory-commands.ts`:

- Add `FactoryLinearCreateOptions` with `workspace`, `title`, `body`, and
  `bodyFile`.
- Register:

```bash
harness factory linear create --workspace /path/to/repo --title "..." --body "..."
harness factory linear create --workspace /path/to/repo --title "..." --body-file path.md
printf '%s\n' "body" | harness factory linear create --workspace /path/to/repo --title "..."
```

- Broaden the parent `linear` command description from
  `"Read Linear issues as factory work items"` to wording that covers both
  read and create, for example `"Use Linear factory intake helpers"`. Keep
  `--title`, `--body`, and `--body-file` only on the `create` subcommand.
- Use `.requiredOption("--title <title>", "Linear issue title")`.
- Add `.option("--body <body>", "Linear issue body")`.
- Add `.option("--body-file <path>", "Linear issue body markdown file")`.
- Do not add `--dry-run` or `--apply`.
- Add a testable exported helper, similar to `fetchFactoryLinearWorkItem(...)`,
  for example `createFactoryLinearWorkItem(...)`, with injectable environment,
  settings resolver, and adapter factory.
- Resolve body source before constructing the Linear adapter:
  - If both `--body` and `--body-file` are present, throw
    `--body and --body-file are mutually exclusive`.
  - For `--body-file`, use the same path rule as
    `assertFactoryItemFileExists(workspace, itemFile)` in
    `lib/factory-run-context.ts`: absolute paths stay absolute; relative paths
    resolve with `join(workspace, bodyFile)`.
  - Verify the resolved body file exists before reading it.
  - Read body-file content with `readFileSync(resolvedPath, "utf8")`.
  - If neither body flag is present and stdin is a TTY, throw
    `one of --body, --body-file, or stdin is required`.
  - If neither body flag is present and stdin is not a TTY, read fd `0`.
  - Treat stdin as the selected source only when no body flag exists. Do not
    read stdin when an explicit body flag exists.
  - Reject empty/whitespace body content after reading.
- Validate `factory.linear` and `LINEAR_API_KEY` with the same error text class
  as list/fetch:
  - `factory.linear is required in harness.json for Linear commands...`
  - `LINEAR_API_KEY is required for Linear commands.`
- Print only `JSON.stringify(result, null, 2)`.

**Verify**: `pnpm test -- test/cli.test.ts` -> existing tests plus new create
CLI tests pass.

### Step 4: Add focused tests

Add adapter tests in `test/factory-linear-adapter.test.ts`:

- Creates one issue with configured team id, configured project id, configured
  intake state id, trimmed title, and trimmed description.
- Returns compact ack with `id: "linear:<identifier>"`.
- Rejects missing `settings.projectId` before calling `createIssue`.
- Rejects whitespace title/body before calling `createIssue`.
- Does not call `updateIssue` or `createComment`.
- Continues to validate configured statuses before creation.
- Throws when `createIssue` returns `success: false`.
- Awaits the lazy `result.issue` relation and uses that issue's `identifier` and
  `url` for compact output.
- Throws when the awaited created issue relation is missing identifier or URL.

Update test helpers:

- Add `createIssue` to fake `LinearClientLike` clients.
- Add `createWorkItem` to `fakeLinearAdapter(...)` in
  `test/factory-linear-test-helpers.ts`, defaulting to a throwing function unless
  a test overrides it.

Add CLI tests in `test/cli.test.ts`:

- `harness factory linear --help` includes `create`.
- `harness factory linear create --help` includes `--workspace`, `--title`,
  `--body`, and `--body-file`.
- Create help does not include `--dry-run` or `--apply`.
- Missing config with `LINEAR_API_KEY` set reports `factory.linear is required`.
- Missing API key with valid config reports `LINEAR_API_KEY is required`.
- `--body` plus `--body-file` is rejected before config/API-key checks.
- Missing all body sources is rejected before config/API-key checks.
- Whitespace `--title` or body is rejected before mutation through the exported
  helper.
- Exported helper invokes a fake adapter and returns compact JSON for inline,
  file, and stdin-style body input.

Update `scripts/smoke-dist.ts`:

- Check `harness factory linear --help` includes `create`.
- Check `harness factory linear create --help` includes the command usage,
  `--title`, `--body`, `--body-file`, and does not include `--dry-run` or
  `--apply`.

**Verify**:

```bash
pnpm test -- test/factory-linear-adapter.test.ts test/cli.test.ts
pnpm build
pnpm smoke:dist
```

Expected: all commands exit 0.

### Step 5: Update docs and operator skill

Update docs to name create as intake authoring, not a station:

- `README.md`
  - Add one create example near list/fetch.
  - Update Linear paragraph to say list/fetch are read-only; create is a
    constrained Linear write that creates one configured project intake issue
    and prints compact JSON; triage/planning `--apply` remain station status and
    comment mutations.
- `docs/contributing/factory.md`
  - Add a short "Linear Create" subsection after list/fetch.
  - State required `factory.linear.projectId`.
  - State body sources and non-empty body/title.
  - State no lifecycle events and no run artifacts.
  - State fetch remains the path to full `FactoryWorkItem`.
- `docs/contributing/script-command-surface.md`
  - Add `harness factory linear create` to source CLI commands.
  - Add a mutation class or update notes so create is clearly a constrained
    external tracker mutation, not read-only and not a station apply path.
  - Add `harness factory linear create --help` to the generated-help list.
- `docs/contributing/architecture.md`
  - Add create to current public CLI surfaces.
  - Update the Linear adapter paragraph to mention constrained issue creation
    and the absence of lifecycle/station artifacts.
- `docs/contributing/setup-manifest.md`
  - Add create to the `LINEAR_API_KEY` auth paragraph and distinguish it from
    station `--apply`.
- `skills/factory-operator/SKILL.md`
  - Add create to command examples.
  - Add guidance: use it only for Harness backlog intake when the target repo's
    `factory.linear` config should own team/project/intake status; use Linear UI
    or chief tooling for rich editing.
  - Preserve stop condition: do not mutate Linear outside documented create and
    explicit station apply paths.

**Verify**:

```bash
pnpm test -- test/docs-contracts.test.ts
```

Expected: exit 0.

### Step 6: Run final gates and inspect diff

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test -- test/factory-linear-adapter.test.ts test/cli.test.ts test/docs-contracts.test.ts
pnpm build
pnpm smoke:dist
pnpm check
git diff -- bin/factory-commands.ts lib/factory-linear-adapter.ts lib/factory-linear-types.ts lib/factory-linear-create.ts test/factory-linear-adapter.test.ts test/factory-linear-test-helpers.ts test/cli.test.ts scripts/smoke-dist.ts README.md docs/contributing/factory.md docs/contributing/script-command-surface.md docs/contributing/architecture.md docs/contributing/setup-manifest.md skills/factory-operator/SKILL.md
git status --short
```

Expected:

- All commands exit 0.
- Diff contains only in-scope files.
- `git status --short` lists only intended source/docs/test changes and ignored
  build artifacts if the local repo normally shows them.

## Test plan

- Adapter unit coverage proves the constrained payload and no side-effect drift.
- CLI unit coverage proves help surface, validation order, body source behavior,
  and compact output through injected adapter.
- Dist smoke coverage proves built CLI help exposes create.
- Docs contract coverage catches broken command inventory assumptions.
- Full `pnpm check` catches format, lint, typecheck, unit, build, and smoke
  regressions.

## Done criteria

All must hold:

- [ ] `harness factory linear create --help` exists and documents only
      `--workspace`, `--title`, `--body`, and `--body-file` for this command.
- [ ] Create rejects missing/empty title and missing/empty body before Linear
      mutation.
- [ ] Create rejects missing `factory.linear`, missing `LINEAR_API_KEY`, and
      missing `factory.linear.projectId`.
- [ ] Create validates configured status map and uses
      `factory.linear.statuses.intake`.
- [ ] Create sends only team/project/state/title/description fields to Linear.
- [ ] Create checks the SDK mutation success flag, awaits the returned lazy
      issue relation, and builds output from that awaited issue.
- [ ] Create prints compact JSON with `identifier`, `url`, and
      `id: "linear:<identifier>"`.
- [ ] No lifecycle events, run artifacts, station calls, Linear comments, or
      status updates are added by create.
- [ ] Docs and `factory-operator` describe create as a constrained intake helper,
      not a station.
- [ ] `pnpm check` exits 0.

## STOP conditions

Stop and report if:

- Installed `@linear/sdk@88.0.0` has no issue-create API, or its returned
  payload cannot provide created issue identifier and URL without a broad search.
- Existing code around the cited `bin/factory-commands.ts` or
  `lib/factory-linear-adapter.ts` locations has materially drifted.
- Implementing create appears to require lifecycle events, factory run
  directories, provider invocation, station workflows, or `FactoryWorkItem`
  schema changes.
- A reviewer asks for labels, assignees, priority, parent issue, status override,
  dry-run, apply, batch import, or work-item format in v1.
- A step's verification fails twice after a focused fix attempt.
- Any required implementation file falls outside the in-scope list.
- Live Linear credentials or private downstream repo paths would need to be
  committed or embedded in tests/docs.

## Maintenance notes

- Future create options should be added only after repeated operator pain, not
  by mirroring the Linear UI.
- If `factory.linear.projectId` ever becomes required globally, consolidate the
  validation in config. Until then, keep the stricter project requirement local
  to create so list/fetch behavior does not regress.
- If full work-item JSON is later needed, prefer a follow-up
  `harness factory linear fetch <identifier>` or an explicit new format flag in
  a separate plan.
- Reviewers should scrutinize validation order, the exact Linear create payload,
  and absence of lifecycle/station side effects.
