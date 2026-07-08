# Plan 260708-linear-status-list: Add read-only Linear status listing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Issue**: https://linear.app/ferueda/issue/FER-31/endpoint-to-pull-all-backlog

## Requirements

Build a read-only way to retrieve Linear issues by configured factory status,
especially the configured `Backlog` and `Needs Plan` statuses, without bringing
back repo-managed todo files.

The first implementation slice is a factory CLI command plus a small library
adapter method, not an HTTP endpoint:

- Add `harness factory linear list`.
- Select statuses by keys from `factory.linear.statuses`, not by hard-coded
  board names. Examples: `--status intake`, `--status needsPlan`.
- Print JSON to stdout. Do not write files, move inbox items, mutate Linear,
  open PRs, or run factory stations.
- Return lightweight issue summaries suitable for backlog scanning. Do not
  return full `FactoryWorkItem` payloads with descriptions/comments. Users can
  call existing `harness factory linear fetch TEAM-123` for a selected issue.
- Support pagination and an explicit all-pages mode so operators can retrieve a
  whole status backlog when needed.
- Preserve existing Linear scope checks: configured team, status map, and
  optional `factory.linear.projectId`.

Alignment constraints from `docs/project-intent.md`:

- Keep provider-specific Linear logic behind `lib/factory-linear-adapter.ts`.
- Keep this command read-only; mutating Linear remains limited to explicit
  `--apply` station and handoff commands.
- Durable docs must use generic target-repo examples such as `/path/to/repo`,
  not developer-local paths.
- Do not describe planned HTTP, dispatch, or Inngest behavior as current
  behavior.

## Current State

The repository is a Node 24+ TypeScript ESM CLI. Commands and gates are in
`package.json`:

```json
// package.json:16-31
"scripts": {
  "build": "tsc -p tsconfig.build.json",
  "check": "make check",
  "test": "vitest run",
  "typecheck": "tsc -p tsconfig.json --noEmit"
}
```

Current Linear command surface is single-issue only:

```ts
// bin/factory-commands.ts:137-154
function addFactoryLinearCommand(parent: Command): void {
  const linear = parent.command("linear").description("Read Linear issues as factory work items");

  linear
    .command("fetch")
    .description("Fetch one Linear issue and print a factory work item")
    .argument("<issue>", "Linear issue identifier, e.g. TEAM-123")
    .option("--workspace <path>", "target repo")
    .action(async (issue: string, options: FactoryLinearFetchOptions) => {
      const settings = resolveFactoryLinearSettings({ workspace: options.workspace });
      const apiKey = process.env.LINEAR_API_KEY;
      if (!apiKey) {
        throw new Error("LINEAR_API_KEY is required for Linear commands.");
      }
      const adapter = createLinearFactoryAdapter({ apiKey, settings });
      const workItem = await adapter.fetchWorkItem(issue);
      console.log(JSON.stringify(workItem, null, 2));
    });
}
```

`lib/factory-linear-adapter.ts` already owns Linear read and explicit apply
operations. The public adapter type currently has `fetchWorkItem` plus status
validation and mutating apply helpers, but no list/query method:

```ts
// lib/factory-linear-adapter.ts:51-68
export type LinearFactoryAdapter = {
  fetchWorkItem: (issueRef: string) => Promise<FactoryWorkItem>;
  validateStatusMap: () => Promise<LinearStatusMapValidation>;
  applyTriageStarted: (input: LinearTriageApplyInput) => Promise<LinearTriageUpdatePlan>;
  applyTriageCompleted: (input: LinearTriageCompletedInput) => Promise<LinearTriageUpdatePlan>;
  applyTriageFailed: (input: LinearTriageFailedInput) => Promise<LinearTriageUpdatePlan>;
  applyPlanningStarted: (input: LinearPlanningApplyInput) => Promise<LinearPlanningUpdatePlan>;
  applyPlanningCompleted: (input: LinearPlanningCompletedInput) => Promise<LinearPlanningUpdatePlan>;
  applyPlanningFailed: (input: LinearPlanningFailedInput) => Promise<LinearPlanningUpdatePlan>;
  applyPlanningPublished: (input: LinearPlanningHandoffInput) => Promise<LinearPlanningHandoffUpdatePlan>;
  applyPlanningMerged: (input: LinearPlanningMergedInput) => Promise<LinearPlanningHandoffUpdatePlan>;
};
```

Single-issue fetch validates the status map, resolves one issue, fetches labels
and comments, maps Linear status to `factoryStage`, and returns a
`FactoryWorkItem`:

```ts
// lib/factory-linear-adapter.ts:435-443
return FactoryWorkItemSchema.parse({
  id: `linear:${issue.identifier}`,
  source: "linear",
  title: issue.title,
  body: renderLinearIssueBody(issue, commentResult.comments),
  url: issue.url,
  labels,
  metadata,
});
```

Human issue identifiers are currently resolved through `client.issues` by team
key and issue number:

```ts
// lib/factory-linear-adapter.ts:460-466
const connection = await client.issues({
  filter: {
    team: { key: { eq: canonicalTeamKey(parsed.teamKey) } },
    number: { eq: parsed.number },
  },
  first: 2,
});
```

Status-map validation already checks configured status names against the Linear
team workflow:

```ts
// lib/factory-linear-adapter.ts:476-489
const team = await fetchTeam(client, settings.teamKey);
const states = await team.states({ first: STATUS_FETCH_LIMIT });
const existingNames = new Set(states.nodes.map((state) => normalizeName(state.name)));
const missing = unique(Object.values(settings.statuses)).filter(
  (statusName) => !existingNames.has(normalizeName(statusName)),
);
```

`FactoryLinearConfigSchema` already defines the configurable status keys the new
command should accept:

```ts
// lib/schemas.ts:29-40
const FactoryLinearStatusesSchema = z
  .object({
    intake: z.string().min(1),
    parked: z.string().min(1),
    needsInfo: z.string().min(1),
    needsPlan: z.string().min(1),
    needsPlanReview: z.string().min(1),
    readyToImplement: z.string().min(1),
    triaging: z.string().min(1),
    planning: z.string().min(1),
    triageFailed: z.string().min(1),
    planningFailed: z.string().min(1),
  })
  .strict();
```

`LinearConnectionLike` exposes only `hasNextPage` and `hasPreviousPage` today.
The list command needs cursor pagination, so extend this local interface with
optional `endCursor`:

```ts
// lib/factory-linear-types.ts:9-14
export type LinearConnectionLike<T> = {
  nodes: T[];
  pageInfo?: {
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
};
```

Docs explicitly mark current `harness factory linear fetch` as read-only:

```md
<!-- docs/contributing/factory.md:152-155 -->
The fetch command is read-only. It validates `factory.linear.statuses` against
the configured team workflow, verifies the issue belongs to the configured
`factory.linear.projectId` when set, fetches the issue description, labels, and
recent comments, then prints JSON suitable for `--item-file`.
```

Docs that will become stale when `list` ships:

- `docs/contributing/architecture.md` current public CLI surfaces list
  `harness factory linear fetch`, but not a status-list command.
- `docs/contributing/architecture.md` currently describes only one-issue Linear
  fetch in the Linear adapter paragraph.
- `docs/contributing/setup-manifest.md` currently lists
  `harness factory linear fetch` as a `LINEAR_API_KEY` consumer, but not
  `harness factory linear list`.
- `skills/factory-operator/SKILL.md` currently shows
  `harness factory linear fetch TEAM-123 --workspace /path/to/repo`, but not
  backlog/status listing.

Maintainability note: `lib/factory-linear-adapter.ts` is currently about 713
lines, just over the repo's soft ~700 LOC guideline from `AGENTS.md`.

Factory stop conditions ban broader orchestration or tracker mutation:

```md
<!-- docs/contributing/factory.md:397-404 -->
- reviving `harness factory dispatch`
- moving every inbox item in a batch
- mutating GitHub, Jira, or Inngest from current station commands
- mutating Linear outside explicit `harness factory triage --linear-issue ... --apply`
  or `harness factory planning run --linear-issue ... --apply`
- committing `.harness/runs/*`
```

Existing tests to match:

- `test/factory-linear-adapter.test.ts:620-663` verifies `fetchWorkItem` query
  variables and normalized work item output.
- `test/factory-linear-adapter.test.ts:971-978` verifies comments are paged
  with `{ last: 20 }` and truncation metadata is recorded for single-issue
  fetch.
- `test/cli.test.ts:271-299` verifies Linear help and missing config/API-key
  errors through the real CLI.
- `scripts/smoke-dist.ts:75-83` smoke-checks built `harness factory linear`
  and `harness factory linear fetch` help.

## Commands You Will Need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Targeted adapter tests | `pnpm test -- test/factory-linear-adapter.test.ts` | exit 0, new list tests pass |
| Targeted CLI tests | `pnpm test -- test/cli.test.ts` | exit 0, Linear command help/error tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no TypeScript errors |
| Dist smoke | `pnpm smoke:dist` | exit 0, built CLI help includes list command |
| Full gate | `pnpm check` | exit 0 |

## Skills For The Executor

| Step | Verified skill/tool | Why |
| --- | --- | --- |
| All steps | `implement-plan` | Execute this plan phase-by-phase and update plan checkboxes if the copied plan is tracked. |
| Adapter and output typing | `typescript-refactor` | Keep exported list result types, status-key unions, and helper boundaries precise. |
| CLI/runtime code | `node` | Match the repo's Node ESM/native TypeScript CLI patterns and async error handling. |
| Tests | `vitest` | Add isolated adapter and CLI regression tests with existing fake clients. |
| Final review | `change-review-workflow` | Run implementation, quality, and simplify review after code changes. |

## Scope

**In scope**:

- `lib/factory-linear-types.ts`
- `lib/factory-linear-adapter.ts`
- `bin/factory-commands.ts`
- `test/factory-linear-adapter.test.ts`
- `test/factory-linear-test-helpers.ts`
- `test/cli.test.ts`
- `scripts/smoke-dist.ts`
- `README.md`
- `docs/contributing/factory.md`
- `docs/contributing/architecture.md`
- `docs/contributing/script-command-surface.md`
- `docs/contributing/setup-manifest.md`
- `skills/factory-operator/SKILL.md`

**Out of scope**:

- No HTTP endpoint, server, webhook, Inngest backend, GitHub/Jira adapter, or
  `harness factory dispatch`.
- No station execution from the list command.
- No Linear mutation: no status updates, labels, assignees, comments, or
  project changes.
- No repo-managed backlog/todo files and no new local inbox movement.
- No changes to planning/triage apply status transitions.
- No change to `FactoryWorkItem` shape. The list command returns summaries;
  existing `fetch` remains the way to get full work item JSON.
- No new dependency.

## Design

Add a new adapter method:

```ts
listWorkItemsByStatus: (input: LinearListWorkItemsInput) => Promise<LinearIssueList>
```

Use these exported types in `lib/factory-linear-adapter.ts`:

```ts
export type LinearFactoryStatusKey = keyof FactoryLinearSettings["statuses"];

export type LinearListWorkItemsInput = {
  statusKeys: LinearFactoryStatusKey[];
  first?: number;
  after?: string;
  all?: boolean;
};

export type LinearIssueSummary = {
  id: string; // "linear:ENG-123"
  source: "linear";
  identifier: string;
  title: string;
  url: string;
  status?: string;
  statusType?: string;
  factoryStage?: FactoryStage; // omitted for comment-derived Needs Clarification stages
  projectId?: string;
  projectName?: string;
  projectUrl?: string;
  assignee?: string;
  priority?: number | null;
  priorityLabel?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type LinearIssueList = {
  teamKey: string;
  projectId?: string;
  statusKeys: LinearFactoryStatusKey[];
  statusNames: string[];
  issues: LinearIssueSummary[];
  pageInfo: {
    fetchedPages: number;
    hasNextPage: boolean;
    endCursor?: string;
  };
};
```

CLI behavior:

```bash
LINEAR_API_KEY=... harness factory linear list --workspace /path/to/repo --status intake
LINEAR_API_KEY=... harness factory linear list --workspace /path/to/repo --status needsPlan
LINEAR_API_KEY=... harness factory linear list --workspace /path/to/repo --status intake --status needsPlan --all
LINEAR_API_KEY=... harness factory linear list --workspace /path/to/repo --status intake --first 25 --after <cursor>
```

Output is JSON:

```json
{
  "teamKey": "ENG",
  "projectId": "00000000-0000-0000-0000-000000000000",
  "statusKeys": ["intake"],
  "statusNames": ["Backlog"],
  "issues": [
    {
      "id": "linear:ENG-123",
      "source": "linear",
      "identifier": "ENG-123",
      "title": "Endpoint to pull all backlog",
      "url": "https://linear.app/acme/issue/ENG-123/endpoint-to-pull-all-backlog",
      "status": "Backlog",
      "factoryStage": "incoming",
      "projectId": "00000000-0000-0000-0000-000000000000",
      "projectName": "Harness",
      "priority": 0,
      "priorityLabel": "No priority",
      "updatedAt": "2026-07-08T01:35:40.256Z"
    }
  ],
  "pageInfo": {
    "fetchedPages": 1,
    "hasNextPage": false
  }
}
```

Implementation notes:

- Use configured status keys, not raw status strings. Error on unknown keys with
  a message listing allowed keys.
- Default `first` to `50`; reject values below `1` or above `100`.
- If `--all` is false, fetch one page and return `pageInfo.hasNextPage` and
  `pageInfo.endCursor` when Linear provides one.
- If `--all` is true, loop until `hasNextPage` is false. If Linear reports
  `hasNextPage: true` without an `endCursor`, throw a clear error instead of
  looping.
- Do not fetch issue comments or render `FactoryWorkItem.body` in list mode.
- Reuse `factoryStageForStatus`, `assertTeamMatches`, `assertProjectMatches`,
  `assigneeName`, `formatDate`, `compactJsonRecord`, and `validateStatusMap`.
  Because list mode intentionally does not fetch comments, do not report
  `factoryStage` for issues whose status maps to `settings.statuses.needsInfo`;
  `fetchWorkItem` is required to distinguish generic `needs-info` from
  comment-derived `plan-needs-human`.
- Reject `--all` combined with `--after`. `--all` means fetch from the first
  page through the end; `--after` is for a single explicit page.
- Query Linear by configured team, configured status names, and configured
  project when present. Still assert team/project per returned issue, as
  `fetchWorkItem` does.
- `lib/factory-linear-adapter.ts` is already about 713 lines. Keep this first
  slice in the adapter if the implementation stays small and cohesive; if the
  file grows materially past roughly 750 lines, extract a small private helper
  module for list query/pagination and summary mapping instead of further
  inflating the main adapter.

## Steps

### Step 1: Add list types, status-key parsing, and pagination support

In `lib/factory-linear-types.ts`, extend `LinearConnectionLike.pageInfo`:

```ts
pageInfo?: {
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  endCursor?: string;
};
```

In `lib/factory-linear-adapter.ts`:

- Export `LinearFactoryStatusKey`, `LinearListWorkItemsInput`,
  `LinearIssueSummary`, and `LinearIssueList`.
- Add a helper to parse/validate status keys:

```ts
export function parseLinearFactoryStatusKeys(
  settings: FactoryLinearSettings,
  values: string[],
): LinearFactoryStatusKey[] {
  const allowed = Object.keys(settings.statuses) as LinearFactoryStatusKey[];
  // return unique keys in input order; throw on unknown key
}
```

Keep this helper pure and covered by tests.

Do not add `listWorkItemsByStatus` to `LinearFactoryAdapter` in this step unless
you also implement and wire the method in the same edit. Keeping the interface
unchanged here avoids a temporary object-literal type error before Step 2.

**Verify**: `pnpm typecheck` exits 0.

### Step 2: Implement and wire listWorkItemsByStatus

In `lib/factory-linear-adapter.ts`, implement:

```ts
async function listWorkItemsByStatus(
  client: LinearClientLike,
  settings: FactoryLinearSettings,
  input: LinearListWorkItemsInput,
): Promise<LinearIssueList>
```

Also in this step:

- Add `listWorkItemsByStatus` to `LinearFactoryAdapter`.
- Wire `createLinearFactoryAdapterForClient` so the returned adapter exposes
  `listWorkItemsByStatus: (listInput) => listWorkItemsByStatus(input.client, input.settings, listInput)`.
- Update `test/factory-linear-test-helpers.ts` in the same edit with a default
  `fakeLinearAdapter.listWorkItemsByStatus` stub that throws
  `listWorkItemsByStatus should not run`. `tsconfig.json` includes
  `test/**/*.ts`, so this must happen in the same phase as the interface change
  to keep `pnpm typecheck` green.

Algorithm:

1. Validate `input.statusKeys` is non-empty.
2. Validate `first` is an integer from `1` to `100`, defaulting to `50`.
3. Call `validateStatusMap(client, settings)` before issue queries.
4. Convert status keys to configured status names with `settings.statuses[key]`.
5. Before relying on the query shape, inspect local `@linear/sdk` types if
   `node_modules/@linear/sdk` is present; otherwise add/keep a mocked query
   assertion in `test/factory-linear-adapter.test.ts` that captures the exact
   variables passed to `client.issues`. Fetch issues through `client.issues`
   with:

```ts
{
  filter: {
    team: { key: { eq: canonicalTeamKey(settings.teamKey) } },
    state: { name: { in: statusNames } },
    ...(settings.projectId ? { project: { id: { eq: settings.projectId } } } : {}),
  },
  first,
  ...(after ? { after } : {}),
}
```

6. For each returned issue, resolve `state`, `team`, `project`, and `assignee`.
7. Reuse existing team/project assertion helpers.
8. Build `LinearIssueSummary`. Do not fetch labels or comments. For statuses
   matching `settings.statuses.needsInfo`, omit `factoryStage` because the
   exact stage can be comment-derived and list mode deliberately skips comments.
9. If `input.all` is true and `pageInfo.hasNextPage` is true, continue with
   `pageInfo.endCursor`. Throw if the cursor is missing.
10. Return `LinearIssueList` with `fetchedPages`, final `hasNextPage`, and final
   `endCursor`.

If local type or API evidence shows the Linear SDK uses a different filter shape
for status name or project id, STOP and report the exact discovered shape before
changing this plan. Do not guess around Linear query syntax.

**Verify**:

```bash
pnpm typecheck
```

Expected: exit 0. If the only failures are missing new behavior tests, continue
to Step 3 and run the targeted test command there.

### Step 3: Add adapter regression tests

In `test/factory-linear-adapter.test.ts`, add tests matching existing fake
client style:

- `parseLinearFactoryStatusKeys` accepts `["intake", "needsPlan"]`, preserves
  input order, dedupes repeats, and rejects unknown keys with allowed keys in
  the error.
- `listWorkItemsByStatus` queries Linear with configured team key, configured
  status names, `first`, and optional project filter.
- It returns lightweight summaries with `id`, `source`, `identifier`, `title`,
  `url`, `status`, project metadata, assignee, priority, dates, and
  `factoryStage` only when the stage is not comment-derived.
- It does not call `issue.comments` or `issue.labels`; make those fake methods
  throw in the list test.
- It rejects issues outside configured project before returning output.
- It handles single-page pagination by returning `hasNextPage` and `endCursor`.
- It handles `all: true` by fetching multiple pages.
- It rejects `all: true` combined with `after`.
- It throws when `all: true`, `hasNextPage: true`, and `endCursor` is missing.
- It rejects empty status key arrays and invalid `first` values.

**Verify**: `pnpm test -- test/factory-linear-adapter.test.ts` exits 0.

### Step 4: Add the CLI command

In `bin/factory-commands.ts`:

- Add `FactoryLinearListOptions`.
- Add a `list` subcommand under `addFactoryLinearCommand`.
- Keep the existing `fetch` command unchanged.
- Validate `--status` and the `--all`/`--after` combination before resolving
  config/API key. Match the planning station pattern at
  `bin/factory-commands.ts:228-230`, where CLI usage validation runs before
  role/config resolution so usage errors win.
- Resolve `factory.linear`, require `LINEAR_API_KEY`, parse status keys with
  `parseLinearFactoryStatusKeys(settings, options.status)`, create the adapter,
  call `adapter.listWorkItemsByStatus`, and print `JSON.stringify(result, null,
  2)`.

CLI shape:

```ts
linear
  .command("list")
  .description("List Linear issues by configured factory status")
  .option("--workspace <path>", "target repo")
  .option("--status <key>", "factory.linear.statuses key; repeatable", collectValues, [])
  .option("--first <count>", "page size, 1-100 (default: 50)", boundedFirstPageSize, 50)
  .option("--after <cursor>", "Linear pagination cursor")
  .option("--all", "fetch every page", false)
```

`collectValues` and `boundedFirstPageSize` do not exist in
`bin/factory-commands.ts` today. Add local helpers there instead of importing
from unrelated skill scripts or weakening the 1-100 cap:

```ts
function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function boundedFirstPageSize(value: string): number {
  const parsed = positiveInteger(value);
  if (parsed > 100) {
    throw new InvalidArgumentError("must be between 1 and 100");
  }
  return parsed;
}
```

Then use `boundedFirstPageSize` in the `--first` option. Match the existing
`InvalidArgumentError` pattern in `bin/factory-commands.ts:483-488`.

Use this action shape:

```ts
.action(async (options: FactoryLinearListOptions) => {
  if (options.status.length === 0) {
    throw new Error("--status is required");
  }
  if (options.all && options.after) {
    throw new InvalidArgumentError("--all cannot be combined with --after");
  }
  const settings = resolveFactoryLinearSettings({ workspace: options.workspace });
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is required for Linear commands.");
  }
  const statusKeys = parseLinearFactoryStatusKeys(settings, options.status);
  const adapter = createLinearFactoryAdapter({ apiKey, settings });
  const result = await adapter.listWorkItemsByStatus({
    statusKeys,
    first: options.first,
    after: options.after,
    all: options.all,
  });
  console.log(JSON.stringify(result, null, 2));
});
```

Do not add `--apply`, station flags, direct agent flags, or raw status-name
flags.

**Verify**: `pnpm test -- test/cli.test.ts` should pass after CLI tests are
added in Step 5.

### Step 5: Add CLI and smoke tests

In `test/cli.test.ts`:

- Update `harness factory linear help exits cleanly` to expect both `fetch` and
  `list`.
- Add `harness factory linear list help exits cleanly` asserting command usage,
  `--status`, `--first`, `--after`, `--all`, and `--workspace`.
- Add `harness factory linear list requires a status` with a temp workspace and
  no `--status`; expect exit 1 and a clear `--status is required` message.
- Add `harness factory linear list requires Linear config` with `--status intake`
  and `LINEAR_API_KEY=test-key`.
- Add `harness factory linear list requires a Linear API key` with valid Linear
  config and empty `LINEAR_API_KEY`.
- Add `harness factory linear list rejects --all with --after`; this should fail
  before config/API-key resolution and mention the conflicting flags.
- Add a bad status-key test if the CLI path can reach it without live network;
  otherwise keep this covered in adapter tests.

In `scripts/smoke-dist.ts`:

- Check `harness factory linear --help` includes `list`.
- Check `harness factory linear list --help` includes command usage and
  `--status`.

**Verify**:

```bash
pnpm test -- test/cli.test.ts
pnpm smoke:dist
```

Both commands exit 0.

### Step 6: Update docs

Update docs only where command ownership, examples, or mutability model changes.
Do not duplicate every generated flag.

Required edits:

- `README.md`: add one `harness factory linear list --status intake --workspace /path/to/repo`
  example near the existing `fetch` example, and mention that Linear list is
  read-only and prints issue summaries.
- `docs/contributing/factory.md`: in the Linear Adapter section, document the
  new list command, status-key selection, lightweight output, pagination/all
  behavior, the "use fetch for full FactoryWorkItem" boundary, and the fact that
  comment-derived stages such as `plan-needs-human` require `fetch`.
- `docs/contributing/architecture.md`: add `harness factory linear list` to the
  current public CLI surfaces and update the Linear adapter paragraph so it
  documents both one-issue fetch and status listing.
- `docs/contributing/script-command-surface.md`: add
  `harness factory linear list` to the source CLI command list and read-only
  command class. Keep exact flags owned by generated help.
- `docs/contributing/setup-manifest.md`: update the `LINEAR_API_KEY` section to
  name `harness factory linear list` beside `harness factory linear fetch`.
- `skills/factory-operator/SKILL.md`: add one
  `harness factory linear list --status intake --workspace /path/to/repo`
  example near the existing fetch command, and briefly state it is read-only
  backlog discovery by configured status key.

Do not change factory status-transition docs except to state that list is
read-only and does not move statuses.

**Verify**:

```bash
pnpm test -- test/docs-contracts.test.ts
```

Exit 0. Keep `docs/contributing/script-command-surface.md` command ownership
and read-only tables manually aligned with the new command; the docs-contract
test is a general hygiene gate, not the canonical CLI inventory source.

### Step 7: Run gates and review

Run the focused and full gates:

```bash
pnpm test -- test/factory-linear-adapter.test.ts test/cli.test.ts test/docs-contracts.test.ts
pnpm typecheck
pnpm smoke:dist
pnpm check
```

Expected: all exit 0.

Then run the harness change review workflow using `change-review-workflow`:

Use this minimum handoff content in place of the placeholder:

```text
Goal: add read-only Linear status listing for configured factory statuses.
Changed files: <list every changed path>.
Scope: CLI command, Linear adapter list method, tests, docs.
Out of scope: tracker mutation, station execution, HTTP/Inngest/dispatch.
Verification: <command> - <pass/fail>; repeat for every command run.
Open questions: <none, or exact blockers>.
Review focus: read-only guarantee, status-key parsing, pagination, docs accuracy.
```

```bash
cat <<'HANDOFF' | harness run change-review --workspace . --base main --head HEAD --handoff-stdin --verbose
Goal: add read-only Linear status listing for configured factory statuses.
Changed files: <list every changed path>.
Scope: CLI command, Linear adapter list method, tests, docs.
Out of scope: tracker mutation, station execution, HTTP/Inngest/dispatch.
Verification: <command> - <pass/fail>; repeat for every command run.
Open questions: <none, or exact blockers>.
Review focus: read-only guarantee, status-key parsing, pagination, docs accuracy.
HANDOFF
```

Run from the active harness checkout, or substitute the active checkout path for
`.` when needed. If reviewing uncommitted work, follow the skill guidance for
ensuring the review head includes the worktree changes. Triage all findings as
Implement, Adapt, or Decline with code-backed rationale.

## Test Plan

Add and run tests that prove:

- Status keys are config keys, not raw board names.
- The list query uses configured status names and team key.
- Optional project scope is applied to the query and asserted per issue.
- Output is lightweight summaries, with no comments or labels fetches.
- `factoryStage` is omitted for `needsInfo` list results because the precise
  planning-attention stage depends on comments.
- Pagination works for one page, explicit cursor page, and `all: true`.
- `--all` combined with `--after` is rejected.
- `all: true` fails closed when Linear says another page exists without an
  `endCursor`.
- CLI help exposes `list`; CLI errors are deterministic for missing status,
  missing config, and missing API key.
- Docs/smoke checks know the command exists.

Use existing tests as patterns:

- Adapter tests: `test/factory-linear-adapter.test.ts`.
- CLI spawn tests: `test/cli.test.ts`.
- Dist help checks: `scripts/smoke-dist.ts`.

## Done Criteria

All must hold:

- [ ] `harness factory linear list --help` exits 0 and shows `--status`.
- [ ] `harness factory linear list --status intake` requires
  `factory.linear` config and `LINEAR_API_KEY`, matching existing fetch error
  style.
- [ ] `LinearFactoryAdapter` exposes `listWorkItemsByStatus`.
- [ ] List output contains issue summaries and omits full issue body/comments.
- [ ] `harness factory linear fetch` behavior and output remain unchanged.
- [ ] The new list command does not call `updateIssue` or `createComment`.
- [ ] `pnpm test -- test/factory-linear-adapter.test.ts test/cli.test.ts test/docs-contracts.test.ts`
  exits 0.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm smoke:dist` exits 0.
- [ ] `pnpm check` exits 0.
- [ ] `git diff` shows no unrelated refactors and no changes outside the
  in-scope files unless a STOP condition was raised and approved.

## STOP Conditions

Stop and report before continuing if:

- The current code no longer has `harness factory linear fetch` in
  `bin/factory-commands.ts` or `fetchWorkItem` in `lib/factory-linear-adapter.ts`.
- Linear SDK local types or official generated types contradict the query shape
  in this plan for filtering by status name or project id.
- Implementing list requires adding an HTTP server, Inngest flow, dispatch
  command, tracker mutation, or batch station execution.
- Requirements change toward returning full `FactoryWorkItem` objects for every
  listed issue; that is a larger, higher-cost API contract and should be
  replanned.
- The adapter cannot retrieve stable cursors for pagination.
- Focused tests fail twice after a reasonable fix attempt.
- You need to modify files outside the in-scope list.

## Maintenance Notes

This command creates the operator-facing backlog discovery surface. Future
orchestrator work should call the adapter method rather than shelling out, but
should preserve the same read-only contract.

Reviewer scrutiny points:

- Is `list` truly read-only? Look for accidental `updateIssue` or
  `createComment` calls.
- Does the output contract stay lightweight and stable?
- Are status keys tied to `factory.linear.statuses` instead of hard-coded
  Linear board names?
- Is pagination safe from infinite loops?
- Did docs avoid promising hosted endpoints, dispatch, or tracker mutation?
