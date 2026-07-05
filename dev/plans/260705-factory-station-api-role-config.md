# Plan 260705-factory-station-api-role-config: Normalize factory station API and role config

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in the "STOP conditions" section occurs, stop and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `dev/plans/260704-factory-intake-routing.md`
- **Category**: dx

## Why this matters

The factory surface is currently split between an explicit low-level workflow
(`harness run factory-triage`) and a broad batch command
(`harness factory dispatch`). The next stations need a cleaner operator API:
`harness factory <station> --item-file ...`, with agent/model selection coming
from config role blocks instead of station-specific flag sprawl. This plan adds
that foundation before the planning station depends on it.

## Current state

Relevant files:

- `bin/factory-commands.ts` registers `harness factory status` and
  `harness factory dispatch`.
- `bin/harness.ts` registers low-level `harness run factory-triage` and passes
  parser helpers into factory commands.
- `lib/config.ts` has flat `resolveHarnessOptions(...)`, returning internal
  `agentProvider`, model, Codex options, and refs.
- `lib/schemas.ts` validates top-level `defaultAgent` and `agents`, but has no
  typed `factory` block.
- `lib/factory-dispatch.ts` owns local inbox status and batch dispatch.
- `test/config.test.ts`, `test/cli.test.ts`, `test/factory-dispatch.test.ts`,
  and `scripts/smoke-dist.ts` cover current command/config behavior.
- `README.md`, `docs/contributing/architecture.md`,
  `docs/contributing/script-command-surface.md`, and
  `docs/contributing/setup-manifest.md` document the current dispatch surface.

Current factory command registration:

```ts
// bin/factory-commands.ts
export function addFactoryCommands(parent: Command, options: FactoryCommandOptions): void {
  const factory = parent.command("factory").description("Manage local factory intake");
  addFactoryStatusCommand(factory);
  addFactoryDispatchCommand(factory, options);
}
```

Current dispatch command is batch-oriented and exposes direct agent flags:

```ts
// bin/factory-commands.ts
parent
  .command("dispatch")
  .description("Dispatch local factory inbox items through factory triage")
  .option("--agent <provider>", "triage agent provider: cursor or codex", ...)
  .option("--model <id>", "agent model override")
```

Current config schema has no factory station roles:

```ts
// lib/schemas.ts
export const HarnessConfigSchema = z
  .object({
    base: z.string().optional(),
    defaultAgent: z.enum(AGENT_PROVIDERS).optional(),
    agents: z.object({ ... }).passthrough().optional(),
  })
  .passthrough()
```

Desired naming model from `dev/todo/260704-factory-planner-station.md`:

```text
harness run     = low-level workflow primitive
harness factory = operator / queue / station orchestration

harness factory triage --item-file item.json
harness factory planning --item-file item.json
```

Public config vocabulary:

- `agent` = backend identity (`cursor` or `codex`)
- `role` = job inside a station (`triager`, `planner`, `reviewer`)
- `station` = lifecycle step (`triage`, `planning`, later implementation)
- `provider` / `agentProvider` = internal names only

## Commands you will need

| Purpose       | Command                                                                                                                | Expected on success |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Install       | `pnpm install`                                                                                                         | exit 0              |
| Typecheck     | `pnpm typecheck`                                                                                                       | exit 0, no errors   |
| Lint          | `pnpm lint`                                                                                                            | exit 0              |
| Format check  | `pnpm format:check`                                                                                                    | exit 0              |
| Build         | `pnpm build`                                                                                                           | exit 0              |
| Focused tests | `pnpm test -- test/config.test.ts test/cli.test.ts test/factory-dispatch.test.ts test/factory-triage.workflow.test.ts` | all pass            |
| Smoke         | `pnpm smoke:dist`                                                                                                      | exit 0              |
| Full check    | `pnpm check`                                                                                                           | exit 0              |

## Suggested executor toolkit

| Skill                 | Use for                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `node`                | Commander CLI wiring, Node 24 TypeScript import style, filesystem command tests. |
| `typescript-refactor` | Typed config/resolver shapes and avoiding duplicate option models.               |
| `zod`                 | Strict `factory` config schemas and config validation errors.                    |
| `vitest`              | Config, CLI, inbox status, and smoke-oriented regression tests.                  |

## Scope

**In scope**:

- `lib/schemas.ts`
- `lib/config.ts`
- `bin/factory-commands.ts`
- `bin/harness.ts` only for parser/helper wiring if needed
- `lib/factory-dispatch.ts`
- `test/config.test.ts`
- `test/cli.test.ts`
- `test/factory-dispatch.test.ts`
- `scripts/smoke-dist.ts`
- `README.md`
- `docs/contributing/architecture.md`
- `docs/contributing/script-command-surface.md`
- `docs/contributing/setup-manifest.md`

**Out of scope**:

- Provider session continuation.
- `harness factory planning`.
- GitHub, Linear, Jira, Inngest, comments, labels, branches, or PRs.
- A full lifecycle state machine.
- Per-role factory CLI flags such as `--planner-agent` or `--review-model`.
- Compatibility aliases for `harness factory dispatch`.

## Steps

### Step 1: Add strict factory config schema

Edit `lib/schemas.ts`.

Add a `factory` block under `HarnessConfigSchema`:

```json
{
  "factory": {
    "triage": {
      "roles": {
        "triager": {
          "agent": "cursor",
          "model": "claude-opus-4-8"
        }
      }
    },
    "planning": {
      "maxReviewIterations": 3,
      "roles": {
        "planner": { "agent": "cursor", "model": "claude-opus-4-8" },
        "reviewer": {
          "agent": "codex",
          "model": "gpt-5.5",
          "modelReasoningEffort": "high"
        }
      }
    }
  }
}
```

Rules:

- `factory` root must reject unknown station keys.
- `triage.roles` must reject unknown role keys; only `triager` is valid.
- `planning.roles` must reject unknown role keys; only `planner` and
  `reviewer` are valid.
- Role objects must reject unknown fields.
- Valid role fields: `agent`, `model`, `executable`, `sandboxMode`,
  `approvalPolicy`, `modelReasoningEffort`.
- `agent` is optional and falls back later; when present it must be
  `cursor` or `codex`.
- `planning.maxReviewIterations` must be a positive integer when present.
- Reject Codex-only fields on non-Codex roles:
  `executable`, `sandboxMode`, `approvalPolicy`, `modelReasoningEffort`.
- Validate Codex-only fields using the effective role agent, not only the
  declared role agent:

```text
effectiveAgent = role.agent ?? config.defaultAgent ?? "cursor"
```

A role with no explicit `agent`, `defaultAgent: "cursor"`, and
`modelReasoningEffort` must be rejected.

- Reject unsupported Cursor models using `CURSOR_SDK_MODEL_MODES`.
- Keep existing top-level `.passthrough()` behavior for unrelated config keys.
  Only the nested `factory` schema should be strict.

Add exported inferred types only if callers need them; otherwise keep the
schema local and expose resolver types from `lib/config.ts`.

**Verify**: `pnpm test -- test/config.test.ts` -> existing tests pass before
new tests are added.

### Step 2: Add factory role resolver

Edit `lib/config.ts`.

Add public types:

```ts
export type FactoryStationName = "triage" | "planning";
export type FactoryStationRole = "triager" | "planner" | "reviewer";

export type FactoryRoleAgent = {
  agent: AgentProviderName;
  model?: string;
  codexPathOverride?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
};
```

Add:

```ts
export function resolveFactoryRoleAgent(
  input:
    | {
        workspace?: string;
        station: "triage";
        role: "triager";
      }
    | {
        workspace?: string;
        station: "planning";
        role: "planner" | "reviewer";
      },
  cwd = process.cwd(),
): FactoryRoleAgent & { workspace: string };
```

Add a small planning settings resolver for the dependent planning station:

```ts
export type FactoryPlanningSettings = {
  maxReviewIterations: number;
};

export function resolveFactoryPlanningSettings(
  options: { workspace?: string },
  cwd = process.cwd(),
): FactoryPlanningSettings & { workspace: string };
```

Resolution:

```text
factory.planning.maxReviewIterations -> 3
```

The schema already guarantees any configured value is a positive integer.

Resolution rules:

```text
role.agent -> defaultAgent -> cursor
role.model -> agents.<resolved-agent>.model -> DEFAULT_AGENT_MODELS[resolved-agent]
role.executable -> agents.codex.executable
role.sandboxMode -> agents.codex.sandboxMode
role.approvalPolicy -> agents.codex.approvalPolicy
role.modelReasoningEffort -> agents.codex.modelReasoningEffort -> DEFAULT_CODEX_REASONING_EFFORT
```

Important:

- If `factory.planning.roles.reviewer.agent` is `codex`, reviewer inherits
  from `agents.codex`, even when `defaultAgent` is `cursor`.
- If a station exists but omits a role entry, resolve that missing role exactly
  like an absent factory block. For example, `factory.planning.roles` may
  configure only `reviewer`; `planner` still falls back through
  `defaultAgent -> cursor`.
- Return internal field `agent`; callers can map it to existing
  `agentProvider` options.
- Do not overload `resolveHarnessOptions`; keep the station-role resolver small
  and explicit.
- Preserve current behavior when `factory` is absent.

**Verify**: `pnpm typecheck` -> exit 0.

### Step 3: Test config validation and resolution

Edit `test/config.test.ts`.

Add tests for:

- absent `factory` resolves `triage/triager` to `defaultAgent` then `cursor`;
- `factory.triage.roles.triager` resolves model override;
- `factory.planning.roles.planner` and `reviewer` resolve independently;
- reviewer with `agent: "codex"` inherits `agents.codex` model, executable,
  sandbox, approval, and reasoning fields;
- `factory.planning.maxReviewIterations` resolves configured value and defaults
  to `3`;
- misspelled station key is rejected;
- misspelled role key such as `reviwer` is rejected;
- unknown role field is rejected;
- Codex-only field on Cursor role is rejected;
- Codex-only field is rejected when a role omits `agent` but effective agent is
  Cursor via `defaultAgent` or fallback;
- partial factory blocks with missing role entries still resolve via fallback;
- unsupported Cursor model is rejected;
- Codex model strings remain permissive.

Use current `Invalid harness.json:` assertions and match stable error substrings,
not full Zod text.

**Verify**: `pnpm test -- test/config.test.ts` -> all pass.

### Step 4: Replace dispatch with explicit triage station command

Edit `bin/factory-commands.ts`.

Replace `addFactoryDispatchCommand(...)` with
`addFactoryTriageStationCommand(...)`.

Command shape:

```bash
harness factory triage --workspace /path/to/repo --item-file work-item.json
```

Options:

```text
--workspace <path>
--item-file <path>      required
--runs-dir <path>
--max-runtime-ms <ms>
--dry-run
--verbose
```

Rules:

- No `--agent`, `--model`, `--codex-executable`, `--sandbox`,
  `--approval-policy`, or `--reasoning-effort` on `harness factory triage`.
- Resolve triage agent settings from `factory.triage.roles.triager`.
- Call the existing `runFactoryTriage` workflow with one item.
- Reuse the same item-file and output behavior as `harness run factory-triage`.
  Today `assertItemFileExists(...)`, `readFactoryWorkItemFile(...)`, and
  `factoryTriageCliOutput(...)` live in `bin/harness.ts`; extract them to a
  small shared CLI helper module if needed so both commands stay identical.
- Map resolver output into `createFactoryRunContext(...)` explicitly:

```ts
createFactoryRunContext({
  workspace,
  runsDir,
  workItem,
  agentProvider: role.agent,
  codexPathOverride: role.codexPathOverride,
  model: role.model,
  sandboxMode: role.sandboxMode,
  approvalPolicy: role.approvalPolicy,
  modelReasoningEffort: role.modelReasoningEffort,
  maxRuntimeMs,
  dryRun,
  signal,
  eventSink,
  agentProviderFactory: createAgentProvider,
});
```

- Copy the current SIGINT/SIGTERM abort wiring from the low-level
  `factory-triage` action.
- Keep `harness run factory-triage` unchanged; it remains the low-level
  primitive with direct overrides.
- Remove `harness factory dispatch` from the command tree. Do not add a legacy
  alias.

Output should be exactly the `factoryTriageCliOutput(meta)` shape used by
`harness run factory-triage`:

```json
{
  "runId": "...",
  "workflow": "factory-triage",
  "status": "completed",
  "workspace": "...",
  "runDir": "...",
  "workItem": {
    "id": "...",
    "source": "file",
    "title": "..."
  },
  "route": "ready-to-plan",
  "nextAction": "create-plan",
  "summaryPath": "summary.md",
  "triagePath": "factory-triage.json",
  "routePath": "factory-route.json",
  "routeSummaryPath": "factory-route.md"
}
```

Exit code:

- `0` for completed and dry-run statuses;
- `1` for failed triage meta.

**Verify**: `pnpm test -- test/cli.test.ts` -> existing tests will fail until
updated in Step 5.

### Step 5: Keep status, retire batch dispatch tests

Decide what to do with `lib/factory-dispatch.ts` after Step 4:

- Keep `factoryInboxStatus(...)` because `harness factory status` still uses it.
- Remove or stop exporting `dispatchFactoryInbox(...)`, batch result types, and
  live move helpers if no production caller remains.
- Rename `lib/factory-dispatch.ts` to `lib/factory-inbox.ts` only if the edit is
  clean. If renamed, update all imports and tests in the same step.

Update tests:

- Rename `test/factory-dispatch.test.ts` to `test/factory-inbox.test.ts` if the
  module is renamed.
- Keep status tests: pending sorted, invalid pending item, failed item summary,
  relative inbox dir.
- Remove batch dispatch tests that assert processed/failed moves.
- Add CLI tests for `harness factory triage` help and dry-run.
- Add CLI test that `harness factory dispatch --help` exits with unknown command
  or help error.
- Assert `harness factory triage --help` does not include direct agent/model
  flags.

**Verify**:

```bash
pnpm test -- test/cli.test.ts test/factory-inbox.test.ts test/factory-triage.workflow.test.ts
```

Expected: all selected tests pass. If the file was not renamed, use the actual
remaining test filename.

### Step 6: Update docs and smoke surfaces

Update only current user-facing command docs:

- `README.md`
- `docs/contributing/architecture.md`
- `docs/contributing/script-command-surface.md`
- `docs/contributing/setup-manifest.md`
- `scripts/smoke-dist.ts`

Before editing docs, read `docs/project-intent.md` and keep these constraints:
present-tense source-of-truth wording, generic target-repo examples such as
`/path/to/repo`, and clear separation between current behavior and future
planned GitHub/Inngest behavior.

Required docs changes:

- Replace current `harness factory dispatch` usage with
  `harness factory triage --item-file ...`.
- Keep `harness factory status`.
- Explain that `harness factory triage` is the station-level command and
  `harness run factory-triage` is the low-level workflow primitive.
- Mention factory station agent/model selection comes from `harness.json`
  `factory.<station>.roles`.
- Remove claims that factory station commands process every inbox file.

Required smoke changes:

- `pnpm smoke:dist` checks:
  - `harness run factory-triage --help`;
  - `harness factory status --help`;
  - `harness factory triage --help`;
  - no check for `harness factory dispatch`.

**Verify**:

```bash
pnpm smoke:dist
pnpm test -- test/docs-contracts.test.ts
```

Expected: both pass.

### Step 7: Final verification

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test -- test/config.test.ts test/cli.test.ts test/factory-inbox.test.ts test/factory-triage.workflow.test.ts
pnpm test
pnpm check
```

If `test/factory-inbox.test.ts` was not created, substitute the actual inbox
status test filename.

Expected:

- all commands exit 0;
- no generated `.harness/` artifacts are staged;
- `git status --short` shows only intended source, test, doc, and smoke files.

## Test plan

- `test/config.test.ts`: strict factory schema and role resolution.
- `test/cli.test.ts`: `harness factory triage`, removed `dispatch`, no direct
  station agent/model flags.
- `test/factory-inbox.test.ts` or remaining dispatch test file: status-only
  local inbox behavior.
- `scripts/smoke-dist.ts`: distributed CLI smoke help surface.
- Existing `test/factory-triage.workflow.test.ts`: unchanged low-level triage
  workflow behavior.

## Done criteria

- [ ] `harness factory triage --item-file <path> --dry-run` works for one item.
- [ ] `harness factory triage --help` has no direct agent/model override flags.
- [ ] `harness factory dispatch` is no longer a valid command.
- [ ] `harness run factory-triage` still works and still accepts direct
      low-level overrides.
- [ ] `factory.triage.roles.triager` resolves agent/model config.
- [ ] `factory.planning.roles.planner` and `reviewer` resolve for later plans.
- [ ] `factory.planning.maxReviewIterations` resolves from config and defaults
      to `3`.
- [ ] Unknown factory station, role, and role fields are rejected.
- [ ] Codex-only fields on non-Codex roles are rejected.
- [ ] Current docs and smoke references no longer present `dispatch` as a
      current command.
- [ ] `pnpm check` exits 0.

## STOP conditions

Stop and report if:

- Removing `dispatch` would break an already-merged consumer outside the in-scope
  CLI/tests/docs.
- `resolveHarnessOptions` must be rewritten broadly to support role resolution.
- Factory role config cannot be represented without loosening schema validation.
- You need to add planning station behavior to finish this slice.
- You need GitHub, Linear, Jira, Inngest, tracker state, or batch station logic.
- A verification command fails twice after a focused fix attempt.

## Maintenance notes

Reviewers should scrutinize naming and config vocabulary. Public docs should use
`agent` for backend choice, `role` for station jobs, and `station` for factory
steps. Internal code can still use `agentProvider` where it already exists, but
that name should not leak into the new factory config shape.
