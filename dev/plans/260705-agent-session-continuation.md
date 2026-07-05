# Plan 260705-agent-session-continuation: Add provider session continuation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in the "STOP conditions" section occurs, stop and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: dx

## Why this matters

The factory planning station must let the same planner handle review findings
after writing the first plan. Today providers return a raw `sessionId`, but
`AgentRunInput` cannot resume a prior Codex thread or Cursor agent. This plan
adds one shared session reference across providers so later factory loops can
preserve planner context without provider-specific code.

## Current state

Relevant files:

- `lib/agents.ts` defines provider names, `AgentRunInput`, and
  `AgentRunResult`.
- `providers/codex/codex-agent.ts` starts a new Codex thread for every run and
  returns `sessionId: thread.id`.
- `providers/cursor/cursor-sdk-agent.ts` creates a new Cursor SDK agent for
  every run and returns `sessionId: sdkAgent.agentId`.
- `providers/codex/codex-agent.test.ts` and
  `providers/cursor/cursor-sdk-agent.test.ts` assert current `sessionId`
  behavior.
- `providers/registry.ts` returns provider agents and should not need a public
  API change.

Current shared result shape:

```ts
// lib/agents.ts
export type AgentRunResult =
  | {
      ok: true;
      structuredOutput?: unknown;
      raw: unknown;
      sessionId?: string;
      usage?: unknown;
    }
  | { ok: false; ... };
```

Current Codex behavior:

```ts
// providers/codex/codex-agent.ts
const thread = codex.startThread(buildThreadOptions(input));
...
return withWorkspaceGuard({
  ok: true,
  structuredOutput: parsed.value,
  raw: turn,
  sessionId: thread.id ?? undefined,
  usage: turn.usage ?? undefined,
}, ...);
```

Current Cursor behavior:

```ts
// providers/cursor/cursor-sdk-agent.ts
sdkAgent = await createSdkAgent({ apiKey, model: modelResult.value, mode: "agent", local: ... });
...
return withWorkspaceGuard({
  ok: true,
  structuredOutput: structuredOutput.value,
  raw,
  sessionId: sdkAgent.agentId,
}, ...);
```

Provider capabilities confirmed in
`dev/todo/260704-factory-planner-station.md`:

- Codex SDK supports `codex.resumeThread(savedThreadId)`.
- Cursor SDK supports `Agent.resume(agentId, options)`.
- Cursor local agent ids start with `agent-`; cloud ids start with `bc-`.
- Both providers persist enough session state for resume to be the first
  factory implementation path.

## Commands you will need

| Purpose       | Command                                                                                                                  | Expected on success |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Install       | `pnpm install`                                                                                                           | exit 0              |
| Typecheck     | `pnpm typecheck`                                                                                                         | exit 0, no errors   |
| Lint          | `pnpm lint`                                                                                                              | exit 0              |
| Format check  | `pnpm format:check`                                                                                                      | exit 0              |
| Build         | `pnpm build`                                                                                                             | exit 0              |
| Focused tests | `pnpm test -- providers/codex/codex-agent.test.ts providers/cursor/cursor-sdk-agent.test.ts test/agent-provider.test.ts` | all pass            |
| Full check    | `pnpm check`                                                                                                             | exit 0              |

## Suggested executor toolkit

| Skill                 | Use for                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `node`                | Async provider execution, abort/timeout handling, stream cleanup.      |
| `typescript-refactor` | Shared discriminated session type and migration from `sessionId`.      |
| `vitest`              | Provider fake tests for resume, mismatch, abort, and no-session cases. |

## Scope

**In scope**:

- `lib/agents.ts`
- `lib/agent-session.ts`
- `providers/codex/codex-agent.ts`
- `providers/codex/codex-agent.test.ts`
- `providers/cursor/cursor-sdk-agent.ts`
- `providers/cursor/cursor-sdk-agent.test.ts`
- `test/agent-provider.test.ts` if result shape assertions exist there
- `test/agent-session.test.ts`
- any focused type updates in workflows/tests caused by replacing `sessionId`

**Out of scope**:

- Factory planning station.
- New CLI flags for session ids.
- Context replay fallback when resume fails.
- Durable session registry or database.
- Live smoke tests requiring credentials. Add optional documented commands only
  if useful; do not make CI depend on live providers.
- GitHub, Linear, Inngest, tracker state, or lifecycle transitions.

## Steps

### Step 1: Replace raw `sessionId` with `AgentSessionRef`

Edit `lib/agents.ts`.

Add:

```ts
export type AgentSessionRef = {
  provider: AgentProviderName;
  id: string;
  raw?: unknown;
};
```

Update `AgentRunInput`:

```ts
export type AgentRunInput = {
  ...
  session?: AgentSessionRef;
};
```

Update success `AgentRunResult`:

```ts
{
  ok: true;
  structuredOutput?: unknown;
  raw: unknown;
  session?: AgentSessionRef;
  usage?: unknown;
}
```

Remove `sessionId` from the shared type. Fix compile errors by updating callers
and tests. Do not keep both fields unless an intermediate compile step requires
it; the final state must have one source of truth.

**Verify**: `pnpm typecheck` -> expected to fail only on provider/test callsites
that still use `sessionId`.

### Step 2: Add Codex resume support

Edit `providers/codex/codex-agent.ts`.

Extend local `CodexClient`:

```ts
type CodexClient = {
  startThread(options: ThreadOptions): CodexThread;
  resumeThread(id: string, options?: ThreadOptions): CodexThread;
};
```

Add helper:

```ts
function openCodexThread(codex: CodexClient, input: AgentRunInput): CodexThread | AgentRunResult {
  if (!input.session) return codex.startThread(buildThreadOptions(input));
  if (input.session.provider !== "codex") return providerMismatchResult(...);
  return codex.resumeThread(input.session.id, buildThreadOptions(input));
}
```

Rules:

- If `input.session.provider !== "codex"`, return `ok: false` with exit code 1
  before calling the SDK.
- Preserve existing `buildThreadOptions(input)` fields on start and resume.
- Continue to use workspace guard around the provider run.
- Keep stream logging behavior unchanged.
- Return:

```ts
session: {
  provider: "codex",
  id: thread.id,
  raw: { kind: "codex-thread" }
}
```

- If Codex returns `thread.id === null`, omit `session`. Do not invent an id.

**Verify**: `pnpm typecheck` -> remaining failures should be tests or Cursor.

### Step 3: Test Codex continuation

Edit `providers/codex/codex-agent.test.ts`.

Update existing expectations from `result.sessionId` to `result.session`.

Add tests:

- no `input.session` calls fake `startThread(...)`, not `resumeThread(...)`;
- `input.session: { provider: "codex", id: "thread-123" }` calls
  `resumeThread("thread-123", threadOptions)`, not `startThread(...)`;
- successful resumed run returns `session.provider === "codex"` and id from
  the resumed thread;
- provider mismatch with `{ provider: "cursor", id: "agent-123" }` fails
  before SDK thread start/resume;
- resume failure returns existing `Codex agent failed: ...` style error and
  does not lose stream/error artifacts.

Use existing fake `CodexClient` patterns in the test file. Avoid live SDK calls.

**Verify**: `pnpm test -- providers/codex/codex-agent.test.ts` -> all pass.

### Step 4: Add Cursor resume support

Edit `providers/cursor/cursor-sdk-agent.ts`.

Add a testable resume dependency:

```ts
type ResumeCursorSdkAgent = (
  agentId: string,
  options: CursorSdkAgentOptions,
) => Promise<CursorSdkAgentInstance>;

export type CursorSdkAgentFactoryOptions = {
  apiKey?: string;
  createSdkAgent?: CreateCursorSdkAgent;
  resumeSdkAgent?: ResumeCursorSdkAgent;
};
```

Default to:

```ts
const resumeSdkAgent = options.resumeSdkAgent ?? CursorSdkAgent.resume;
```

Extract the options builder used for both create and resume:

```ts
function buildCursorAgentOptions(
  input: AgentRunInput,
  apiKey: string,
  model: CursorSdkModelSelection,
) {
  return {
    apiKey,
    model,
    mode: "agent",
    local: {
      cwd: input.workspace,
      settingSources: [],
      autoReview: true,
    },
  } satisfies CursorSdkAgentOptions;
}
```

Rules:

- If no `input.session`, call `createSdkAgent(options)`.
- If `input.session.provider !== "cursor"`, return `ok: false` before calling
  the SDK.
- If `input.session.provider === "cursor"`, call
  `resumeSdkAgent(input.session.id, options)`.
- Keep disposing SDK handles after each run.
- Keep abort/timeout handling and stream logging behavior unchanged.
- Return:

```ts
session: {
  provider: "cursor",
  id: sdkAgent.agentId,
  raw: { kind: "cursor-agent" }
}
```

**Verify**: `pnpm typecheck` -> exit 0 after all references are migrated.

### Step 5: Test Cursor continuation

Edit `providers/cursor/cursor-sdk-agent.test.ts`.

Update existing expectations from `result.sessionId` to `result.session`.

Add tests:

- no `input.session` calls fake `createSdkAgent(...)`;
- Cursor session calls fake `resumeSdkAgent("agent-123", options)` and not
  create;
- resumed run sends the new prompt and returns `session.provider === "cursor"`;
- provider mismatch with `{ provider: "codex", id: "thread-123" }` fails before
  create/resume;
- timeout/abort paths still dispose/cancel as existing tests expect.

Use existing fake SDK agent/run helpers in the test file.

**Verify**: `pnpm test -- providers/cursor/cursor-sdk-agent.test.ts` -> all
pass.

### Step 6: Update downstream type/tests

Search:

```bash
rg -n "sessionId" lib providers workflows test bin
```

Expected final result: no matches, except historical text in plans/todos if
outside implementation source/test paths.

Update any `AgentRunResult` consumers to use `result.session`.

Do not add CLI flags or station behavior while doing this.

**Verify**:

```bash
pnpm test -- providers/codex/codex-agent.test.ts providers/cursor/cursor-sdk-agent.test.ts test/agent-provider.test.ts
pnpm typecheck
```

Expected: all pass.

### Step 7: Final verification

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test -- providers/codex/codex-agent.test.ts providers/cursor/cursor-sdk-agent.test.ts test/agent-provider.test.ts
pnpm test
pnpm check
```

Expected:

- all commands exit 0;
- no live provider credentials are required;
- `rg -n "sessionId" lib providers workflows test bin` returns no matches.

## Test plan

- Codex provider tests cover start, resume, provider mismatch, and existing
  stream/error paths.
- Cursor provider tests cover create, resume, provider mismatch, and existing
  abort/timeout paths.
- Typecheck catches every callsite that still expects `sessionId`.
- Full test suite confirms review/factory workflows still work with the new
  result shape.

## Done criteria

- [ ] `AgentRunInput.session?: AgentSessionRef` exists.
- [ ] Successful provider results return `session?: AgentSessionRef`.
- [ ] `sessionId` is removed from implementation source and tests.
- [ ] Codex uses `resumeThread(...)` when passed a Codex session.
- [ ] Cursor uses `Agent.resume(...)` when passed a Cursor session.
- [ ] Provider mismatch fails clearly before provider execution.
- [ ] Existing no-session provider behavior remains unchanged.
- [ ] `pnpm check` exits 0.

## STOP conditions

Stop and report if:

- Installed SDK types do not expose `resumeThread` or `Agent.resume`.
- Resume requires a broader persistent store design beyond the SDK defaults.
- Preserving session continuity requires replaying prior prompts in this slice.
- Workspace guard logic must be weakened to resume sessions.
- You need factory planning station code to complete this slice.
- A verification command fails twice after a focused fix attempt.

## Maintenance notes

Reviewers should focus on one invariant: callers should never need to know a
provider-specific session field. They pass an `AgentSessionRef`, and the adapter
either resumes the matching provider or fails clearly. Keep CLI and tracker
integration out of this abstraction.
