# Plan 260625-cursor-sdk-runtime: Add an opt-in Cursor SDK runtime

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: migration
- **Spec review**: reviewed twice with Cursor `review-spec`; simplification
  feedback accepted

## Why this matters

Harness currently runs Cursor reviewers through a double subprocess path:
`lib/cursor-agent.ts` spawns the repo wrapper in
`providers/cursor/cursor-agent.ts`, which then spawns Cursor CLI `agent`.
Codex already uses an in-process SDK adapter in
`providers/codex/codex-agent.ts`.

Cursor now has a TypeScript SDK with stable agent IDs, run IDs, request IDs,
structured run status, cancellation, resume support, explicit model selection,
local/cloud runtimes, model listing, and future support for custom tools and
dispatcher-style workflows. This plan adds an opt-in SDK runtime for Cursor
while keeping the CLI runtime as the default until review safety is proven.

The scope is intentionally thin: runtime switch, SDK adapter, structured output,
timeout/cancel, auth errors, git mutation guard, docs, and tests. Streaming
artifacts, `--progress`, live validation scripts, dispatcher agents, custom
tools, and cloud runtime are follow-ups.

## Current state

- `package.json` - Node project metadata. Harness requires Node `>=24`, uses
  pnpm, and already depends on `@openai/codex-sdk`.
- `lib/agents.ts` - provider contract. `AgentRunInput` has `workspace`,
  `prompt`, optional `schemaPath`, `model`, Codex-only policy fields, and
  `maxRuntimeMs`.
- `lib/agent-provider.ts` - provider factory. Cursor uses `createCursorAgent`
  from `lib/cursor-agent.ts`; Codex uses `providers/codex/codex-agent.ts`.
- `lib/cursor-agent.ts` - current Cursor harness provider. It spawns the local
  wrapper with `--mode ask`, `--workspace`, `--stdin`, `--schema`, `--model`,
  and `--max-runtime-ms`.
- `providers/cursor/cursor-agent.ts` - standalone Cursor CLI wrapper. Keep it;
  it remains useful as a shell delegation tool and CLI fallback runtime.
- `providers/cursor/lib/schema.ts` - runtime-agnostic schema prompt wrapping
  and JSON parsing. Reuse it for SDK structured output.
- `providers/codex/codex-agent.ts` - SDK provider exemplar. Match its injected
  factory, timeout, raw artifact, and fake-based test style.
- `lib/config.ts` and `lib/schemas.ts` - `harness.json` parsing and option
  resolution. Cursor currently only accepts `agents.cursor.model`.
- `bin/harness.ts` - CLI options. Cursor-specific option today is
  `--cursor-agent`; Codex-specific options are rejected unless `--agent codex`
  is active.
- `lib/workflow-context.ts` - creates the provider, writes reviewer prompts and
  artifacts, validates `ReviewOutputSchema`, and exports `meta.json` and
  `summary.md`.
- `workflows/review-steps.ts` - starts selected review agents concurrently with
  `Promise.allSettled`.

Current provider contract:

```ts
// lib/agents.ts
export type AgentRunInput = {
  workspace: string;
  prompt: string;
  schemaPath?: string;
  model?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
  maxRuntimeMs: number;
};

export type Agent = {
  name: AgentProviderName;
  run(input: AgentRunInput): Promise<AgentRunResult>;
};
```

Current Cursor CLI provider behavior:

```ts
// lib/cursor-agent.ts
const args = [
  cursorAgentPath,
  "--format",
  "json",
  "--output-format",
  "json",
  "--mode",
  "ask",
  "--workspace",
  workspace,
  "--stdin",
  "--max-runtime-ms",
  String(maxRuntimeMs),
];
if (schemaPath) args.push("--schema", schemaPath);
if (model) args.push("--model", model);
```

Cursor SDK facts from the attached docs:

- Package name is `@cursor/sdk`; attached docs reference `@cursor/sdk@1.0.19`.
- Requires Node.js 22.13+; harness already requires Node 24.
- Auth requires `CURSOR_API_KEY` or `apiKey` passed to `Agent.create`.
- `Agent.create()` returns a stable `agentId` before a prompt is sent.
- `agent.send()` returns a `Run` with `stream()`, `wait()`, `cancel()`,
  `conversation()`, `status`, `requestId`, `model`, and `durationMs`.
- SDK mode is `mode: "plan" | "agent"`; there is no documented `ask` mode.
- Cursor SDK local sandboxing is environment-dependent and is not equivalent to
  Codex `read-only`.
- `local.autoReview` is best-effort and not a security boundary.
- Hooks are file-based only; there is no programmatic hook callback.

Decision for this plan:

- Use SDK `mode: "agent"` and steer review behavior through the prompt.
- Keep SDK runtime opt-in.
- Treat auto-review as defense-in-depth only.
- Use a git before/after guard as the mutation backstop.
- Serialize SDK review steps at the workflow layer to avoid concurrent reviewers
  invalidating each other's mutation guard.

Repo conventions:

- ESM TypeScript with explicit `.ts` imports and `import type` for type-only
  imports.
- Prefer const arrays plus union types over enums; see `AGENT_PROVIDERS` in
  `lib/agents.ts`.
- Provider tests use fake factories or fake subprocesses rather than live
  network calls; see `providers/codex/codex-agent.test.ts` and
  `test/cursor-agent.test.ts`.
- Use `safeParse` at runtime boundaries; see `lib/schemas.ts`.
- Keep stdout machine-readable for CLI commands.

## Commands you will need

| Purpose                 | Command                                                                                                                                                  | Expected on success |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Install deps            | `pnpm install`                                                                                                                                           | exit 0              |
| Focused SDK tests       | `pnpm vitest run providers/cursor/cursor-sdk-agent.test.ts test/config.test.ts test/cli.test.ts test/workflow-context.test.ts test/review-steps.test.ts` | all tests pass      |
| Existing provider tests | `pnpm vitest run providers/cursor/cursor-agent.test.ts providers/codex/codex-agent.test.ts test/cursor-agent.test.ts`                                    | all tests pass      |
| Full local gate         | `pnpm check`                                                                                                                                             | exit 0              |

## Suggested executor toolkit

| Skill                    | Use it for                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `node`                   | Node 24 TypeScript, timeout/cancel handling, process cleanup, direct `.ts` execution.               |
| `typescript-refactor`    | Extending provider/config types without unsafe casts or enum syntax.                                |
| `vitest`                 | Fake SDK tests for auth errors, timeout, cancellation, mutation detection, and config/CLI behavior. |
| `zod`                    | Adding `agents.cursor.runtime` validation in `HarnessConfigSchema`.                                 |
| `change-review-workflow` | Running review after implementation with `--handoff-stdin`.                                         |

Reference docs:

- Cursor SDK README and samples from the upstream Cursor repository were used
  during planning.
- Current Cursor wrapper skill: `skills/cursor-cli/SKILL.md`
- Current provider tests: `providers/codex/codex-agent.test.ts`,
  `test/cursor-agent.test.ts`, `providers/cursor/cursor-agent.test.ts`

## Scope

**In scope**:

- `package.json`
- `pnpm-lock.yaml`
- `lib/agents.ts`
- `lib/schemas.ts`
- `lib/config.ts`
- `bin/harness.ts`
- `lib/agent-provider.ts`
- `lib/cursor-agent.ts`
- `providers/cursor/cursor-sdk-agent.ts` (create)
- `providers/cursor/cursor-sdk-agent.test.ts` (create)
- `providers/cursor/lib/schema.ts` (reuse; modify only if required for SDK)
- `lib/workflow-context.ts`
- `workflows/review-steps.ts`
- `test/config.test.ts`
- `test/cli.test.ts`
- `test/workflow-context.test.ts`
- `test/review-steps.test.ts`
- `README.md`
- `dev/plans/README.md`

**Out of scope**:

- Do not make SDK the default Cursor runtime.
- Do not delete `providers/cursor/cursor-agent.ts` or `lib/cursor-agent.ts`.
- Do not remove `--cursor-agent`; it remains the CLI runtime override.
- Do not add streaming event artifacts or `--progress`.
- Do not add a live validation script in this PR.
- Do not add cloud Cursor runtime, dispatcher agents, subagents, custom tools,
  or resume workflows.
- Do not add `.cursor/hooks.json` to target repos.
- Do not change Codex provider behavior except where shared types require it.

## Steps

### Step 1: Add Cursor runtime types and config validation

Add a Cursor runtime discriminator while keeping `cursor` as one provider.

Target shape:

```ts
// lib/agents.ts
export const CURSOR_RUNTIMES = ["cli", "sdk"] as const;
export type CursorRuntime = (typeof CURSOR_RUNTIMES)[number];
export const DEFAULT_CURSOR_RUNTIME = "cli" satisfies CursorRuntime;
```

Extend:

- `AgentProviderOptions` in `lib/agent-provider.ts`
- `HarnessOptions` and `ResolvedHarnessOptions` in `lib/config.ts`
- `WorkflowOptions` in `lib/workflow-context.ts`

with:

```ts
cursorRuntime?: CursorRuntime;
```

The runtime must flow through:

```text
bin/harness.ts ReviewOptions
  -> resolveHarnessOptions(...)
  -> createWorkflowContext(resolvedOptions)
  -> createAgentProvider({ provider, cursorRuntime, ... })
```

Update `HarnessConfigSchema` so this is valid:

```json
{
  "defaultAgent": "cursor",
  "agents": {
    "cursor": {
      "runtime": "sdk",
      "model": "composer-2.5"
    }
  }
}
```

Resolution rule in `lib/config.ts`:

```ts
cursorRuntime:
  options.cursorRuntime ??
  (agentProvider === "cursor" ? agentConfig.runtime : undefined) ??
  DEFAULT_CURSOR_RUNTIME,
```

Rules:

- CLI option wins over `harness.json`.
- `agents.cursor.runtime` wins over default.
- Default runtime is `"cli"`.
- Codex never reads or acts on runtime.

**Verify**:

```bash
pnpm vitest run test/config.test.ts test/workflow-context.test.ts
```

Expected: all pass. New tests cover default runtime, config runtime, CLI
override precedence, invalid runtime rejection, and
`createWorkflowContextForTest` receiving `cursorRuntime: "sdk"` in injected
`agentProviderFactory` options.

### Step 2: Add CLI runtime option without changing defaults

Update `bin/harness.ts`:

- Add `--runtime <runtime>` with allowed values `cli,sdk`.
- Pass it to `resolveHarnessOptions`.
- Reject `--runtime` unless the resolved provider is Cursor.
- Keep `--cursor-agent` valid only for Cursor.
- Reject `--runtime sdk --cursor-agent ...` because `--cursor-agent` only
  applies to CLI runtime.
- Preserve stdout as final JSON only.

Update `agentMeta` in `lib/workflow-context.ts` so Cursor dry-run and completed
run metadata include `runtime: "cli" | "sdk"`. Codex metadata remains
unchanged except for existing Codex policy fields.

Update help tests in `test/cli.test.ts`.

**Verify**:

```bash
pnpm vitest run test/cli.test.ts test/config.test.ts
```

Expected: all pass.

### Step 3: Add the Cursor SDK provider

Create `providers/cursor/cursor-sdk-agent.ts` with a small injected factory
pattern. Do not mock the whole exported `Agent` class in tests.

Define minimal local interfaces for the SDK objects used by harness:

```ts
type CreateCursorSdkAgent = (options: CursorSdkCreateOptions) => Promise<CursorSdkAgent>;

type CursorSdkAgent = {
  agentId: string;
  send(prompt: string): Promise<CursorSdkRun>;
  [Symbol.asyncDispose]?(): Promise<void>;
  close?(): void;
};

type CursorSdkRun = {
  id: string;
  requestId?: string;
  stream(): AsyncGenerator<unknown, void>;
  wait(): Promise<{
    status: "finished" | "error" | "cancelled";
    result?: string;
    durationMs?: number;
  }>;
  cancel(): Promise<void>;
};
```

Adapter behavior:

- Fail fast when `options.apiKey ?? process.env.CURSOR_API_KEY` is missing.
  Error message must say: `CURSOR_API_KEY required for Cursor SDK runtime`.
- Use `Agent.create`, not `Agent.prompt`, because stable IDs, cancellation, and
  future resume require the agent handle.
- Use local runtime only:

  ```ts
  await Agent.create({
    apiKey,
    model: input.model ? { id: input.model } : undefined,
    mode: "agent",
    local: {
      cwd: input.workspace,
      settingSources: [],
      autoReview: true,
    },
  });
  ```

- Reuse `loadSchema`, `wrapPrompt`, and `parseStructuredOutput` from
  `providers/cursor/lib/schema.ts`.
- Send the wrapped prompt.
- Create and dispose a fresh SDK agent inside each `run()` invocation. Do not
  cache a singleton SDK agent.
- For the MVP, do not expose stream events to the workflow. Use `run.wait()` for
  the final result. If SDK behavior requires draining `run.stream()` for
  progress, drain it internally but do not add event artifacts in this plan.
- Use `run.cancel()` on timeout. Return `ok:false`, `exitCode: 124`, and a
  timeout message.
- Dispose with `await agent[Symbol.asyncDispose]()` when available. Fall back
  to `agent.close?.()` only when async disposal is unavailable.
- Return `AgentRunResult` with `structuredOutput`, raw SDK result data, and
  stable metadata (`agentId`, `run.id`, `requestId`, `durationMs`) under `raw`.

Failure mapping:

- Thrown SDK creation/send errors: `ok:false`, `exitCode: 1`; include
  `name`, `message`, `stack`, and SDK fields such as `code`, `status`,
  `requestId`, `isRetryable`, and `helpUrl` when present.
- `wait()` result `status: "error"`: `ok:false`, `exitCode: 1`; include the raw
  run result.
- `wait()` result `status: "cancelled"`: `ok:false`, `exitCode: 130`; include
  the raw run result.
- Only `status: "finished"` proceeds to `parseStructuredOutput`.

Read-only safeguard:

- Treat `mode: "agent"` as SDK execution mode, not as read-only enforcement.
- Before sending, capture workspace status outside `.harness/` artifacts.
  Prefer a helper that runs:

  ```bash
  git status --porcelain=v1 -z -- . ':!.harness'
  ```

  If pathspec exclusion is not portable in the target Git version, STOP and
  report instead of silently checking the whole workspace.

- After the run finishes or fails, capture the same status again.
- If status changed, return `ok:false` with:
  `Cursor SDK runtime modified the workspace during a review run`.
- Include before/after status strings in `raw` for diagnosis.

Update `lib/agent-provider.ts`:

- If provider is Cursor and runtime is `"sdk"`, create `createCursorSdkAgent`.
- Branch to SDK before calling `resolveCursorAgentPath`.
- If runtime is `"cli"`, keep current behavior and `resolveCursorAgentPath`.

**Verify**:

```bash
pnpm vitest run providers/cursor/cursor-sdk-agent.test.ts test/cursor-agent.test.ts providers/codex/codex-agent.test.ts
```

Expected: all pass. New SDK tests cover missing key, successful schema output,
timeout cancellation, thrown SDK errors, `wait()` error/cancelled statuses,
one-agent-per-run isolation, and workspace mutation detection.

### Step 4: Serialize SDK review runs at the workflow layer

Do not implement a hidden workspace lock in the provider.

Update workflow execution so SDK Cursor review steps run sequentially when
`cursorRuntime === "sdk"`. CLI Cursor and Codex should keep current concurrent
behavior.

Suggested shape:

- Add a boolean or execution mode to the workflow context, e.g.
  `serialReviewExecution` or `reviewConcurrency: "parallel" | "serial"`.
- Set it to serial only when provider is Cursor and runtime is SDK.
- Update `runReviewSteps` to preserve current parallel behavior by default and
  use a simple `for...of` loop for serial mode.
- Preserve output ordering and failed-review metadata shape.

Rationale: the SDK read-only guard compares before/after git status. Running
three SDK reviewers in the same workspace concurrently can make the guard noisy
or misleading. Workflow-level serialization is simpler than a provider-level
queue.

**Verify**:

```bash
pnpm vitest run test/review-steps.test.ts test/workflow-context.test.ts
```

Expected: existing parallel tests still pass, and new tests prove SDK mode runs
steps sequentially while default mode remains parallel.

### Step 5: Document the experimental SDK runtime

Update `README.md`:

- Add `agents.cursor.runtime: "cli" | "sdk"`.
- State default is `"cli"` until SDK read-only behavior is proven.
- State SDK requires `CURSOR_API_KEY`; CLI can still use `agent login`.
- State SDK runtime is not equivalent to CLI ask mode.
- State git mutation detection is the actual enforcement backstop; Cursor SDK
  local sandboxing is environment-dependent and not required by harness.
- Include a config example:

  ```json
  {
    "defaultAgent": "cursor",
    "agents": {
      "cursor": {
        "runtime": "sdk",
        "model": "composer-2.5"
      }
    }
  }
  ```

Do not update `skills/change-review-workflow/SKILL.md` to recommend SDK yet.
The skill should continue giving simple default instructions; SDK is an
experimental runtime.

Update `dev/plans/README.md` status during implementation:

- `in_progress` while executing this plan
- `done` only after all done criteria and review are complete

**Verify**:

```bash
pnpm check
```

Expected: exit 0.

### Step 6: Run full verification and review

Run:

```bash
pnpm vitest run providers/cursor/cursor-sdk-agent.test.ts test/config.test.ts test/cli.test.ts test/workflow-context.test.ts test/review-steps.test.ts
pnpm vitest run providers/cursor/cursor-agent.test.ts providers/codex/codex-agent.test.ts test/cursor-agent.test.ts
pnpm check
```

Then run `change-review-workflow` on the implementation. Use all review roles
unless prior passing roles can be explicitly skipped from a follow-up cycle.

**Verify**: all commands exit 0, and the review run is either `pass` or all
accepted findings are fixed and re-reviewed.

## Deferred follow-ups

These are useful, but not part of this MVP:

- Stream SDK events into `<stage>-events.ndjson`.
- Add `--progress` and render compact progress to stderr.
- Add `AgentRunEvent` / `onEvent` to the shared provider contract.
- Add a live `scripts/validate-cursor-sdk-runtime.ts` script.
- Use `Cursor.models.list()` for account-specific model discovery.
- Add SDK cloud runtime, custom tools, dispatcher agents, or resume workflows.

## Test plan

New tests:

- `providers/cursor/cursor-sdk-agent.test.ts`
  - missing `CURSOR_API_KEY` returns `ok:false` with actionable error
  - successful run calls `Agent.create` with local cwd, model `{ id }`,
    `mode: "agent"`, and local safety options
  - final `result.result` is parsed via shared schema helper
  - timeout calls `run.cancel()` and returns exit code `124`
  - thrown SDK errors preserve diagnostic fields
  - `wait()` `status: "error"` and `status: "cancelled"` return failures
  - workspace mutation detection returns `ok:false`
- `test/config.test.ts`
  - default Cursor runtime is `cli`
  - `agents.cursor.runtime` resolves to `sdk`
  - explicit CLI options override config runtime
  - invalid runtime value is rejected with a Zod path
  - Cursor runtime config is ignored for Codex provider
- `test/cli.test.ts`
  - help includes `--runtime`
  - invalid runtime value is rejected
  - `--agent codex --runtime sdk` is rejected
  - `--runtime sdk --cursor-agent ...` is rejected
  - dry-run metadata includes Cursor runtime when active
- `test/workflow-context.test.ts`
  - `cursorRuntime` reaches injected `agentProviderFactory`
  - dry-run metadata includes `agent.runtime` for Cursor
- `test/review-steps.test.ts`
  - default review execution remains parallel
  - SDK review execution can run serially while preserving metadata shape

Existing tests to preserve:

- `test/cursor-agent.test.ts` for CLI runtime subprocess behavior
- `providers/cursor/cursor-agent.test.ts` for standalone CLI wrapper behavior
- `providers/codex/codex-agent.test.ts` for Codex SDK behavior
- Existing `test/review-steps.test.ts` concurrency and failure behavior

## Done criteria

All must hold:

- [x] `agents.cursor.runtime` supports `cli` and `sdk`; default is `cli`.
- [x] `--runtime sdk` runs the new SDK provider for Cursor.
- [x] `--agent codex --runtime sdk` is rejected.
- [x] `--cursor-agent` still works for Cursor CLI runtime.
- [x] Missing `CURSOR_API_KEY` for SDK runtime fails with a clear actionable
      error and does not invoke Cursor SDK.
- [x] SDK provider records stable IDs/request metadata in raw artifacts.
- [x] Workspace mutation detection exists for SDK review runs and ignores
      `.harness/` artifacts.
- [x] Cursor SDK review steps run serially in one harness process.
- [x] `pnpm check` exits 0.
- [x] `README.md` documents SDK runtime as experimental and not default.
- [x] `dev/plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- `@cursor/sdk@1.0.19` is unavailable or its exported API does not match the
  attached docs (`Agent.create`, `send`, `wait`, `cancel`).
- SDK `mode: "agent"` is rejected by the installed SDK.
- The SDK cannot run without loading user/project settings unless
  `settingSources: []` is accepted.
- The SDK cannot provide final assistant text through `RunResult.result`.
- Unit tests require a real `CURSOR_API_KEY`; tests must use fakes/mocks.
- The git status pathspec excluding `.harness` is not portable.
- The implementation starts to require streaming artifacts, progress UI, cloud
  runtime, custom tools, dispatcher agents, hooks, or resume workflows.

## Maintenance notes

- CLI remains the default Cursor runtime. Promotion to SDK default needs a
  separate decision after real review runs prove structured output and clean git
  status.
- `providers/cursor/cursor-agent.ts` remains the standalone CLI wrapper used by
  the `cursor-cli` skill and as fallback runtime.
- Cursor SDK local sandboxing is not required because support is
  environment-dependent. Reviewers should scrutinize the git mutation guard and
  the README wording.
- Streaming/status output is deliberately deferred. Add it after the SDK runtime
  proves useful, not before.
