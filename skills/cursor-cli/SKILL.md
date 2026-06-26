---
name: cursor-cli
description: >-
  Run Cursor Agent headlessly and delegate work to another Cursor agent over the
  CLI. Use when the user asks to call, ask, invoke, run, or delegate to Cursor
  (e.g. "call cursor", "ask cursor", "invoke cursor agent"); when automating
  Cursor from scripts or agent-to-agent flows; or when the user mentions
  `agent -p`, headless Cursor CLI, or `harness-cursor`.
---

# Cursor CLI (Headless)

Delegate work to a Cursor agent from the shell without the IDE chat. Use when the user wants another agent to **call, ask, invoke, or run Cursor** on a task.

**Launcher:** `harness-cursor`

**Harness provider:** `providers/cursor/cursor-agent.ts`

Requires `agent` on PATH. Local dev: `agent login` once. CI/servers: `CURSOR_API_KEY`.

## When to use

| Situation | Use this |
|-----------|----------|
| User says "call cursor", "ask cursor", "invoke cursor", etc. | `harness-cursor "…"` |
| Already inside Cursor IDE chat | Task tool — not CLI |
| Long-lived typed service | `@cursor/sdk` |

## Quick start

```bash
# Check auth + CLI version
harness-cursor

# Invoke (read-only by default — no file edits)
harness-cursor "explain the backend routing"

# Allow edits
harness-cursor --force "add a regression test for auth"

# Typed JSON response
harness-cursor \
  --schema-json '{"type":"object","required":["verdict"],"properties":{"verdict":{"type":"string"}}}' \
  "Review auth.ts"

# Continue a session
harness-cursor --resume <session-id> "follow up"
```

**Caller flow:** parse stdout → check `status` → read `structuredOutput` or `result` → save `sessionId` for `--resume`.

## Output

Default format is **TOON** on stdout (token-efficient). Use `--format json` when debugging.

Success example:

```
status: completed
sessionId: uuid
durationMs: 8783
usageSummary: 45271 in, 76 out
result: truncated answer preview…
help[1]: Run `harness-cursor --resume <id> "follow up"` to continue
```

With `--schema` / `--schema-json`:

```
status: completed
sessionId: uuid
structuredOutput:
  verdict: pass
  summary: …
```

Errors also go to stdout (not stderr):

```
status: failed
error: prompt is required
help[1]: Run `harness-cursor "your task"` or --prompt-file / --stdin
```

Exit codes: `0` success, `1` error, `2` usage.

### Envelope fields

| Field | When |
|-------|------|
| `status` | `completed`, `failed`, `timed_out` |
| `sessionId` | Resume with `--resume` |
| `result` | Answer text (~800 char preview; use `--full` for all) |
| `structuredOutput` | With `--schema` — validated JSON |
| `error` | Failure message |
| `help` | Suggested next commands |
| `usageSummary` | Token counts when available |

## Flags

| Flag | Purpose |
|------|---------|
| `--force` | Allow file/shell changes (off by default) |
| `--model <id>` | e.g. `composer-2.5` |
| `--mode plan\|ask` | Read-only modes |
| `--workspace <path>` | Repo root (default: cwd) |
| `--resume <id>` | Continue a session |
| `--schema <path>` | JSON Schema file |
| `--schema-json '<json>'` | Inline schema (mutually exclusive with `--schema`) |
| `--format toon\|json` | Output format (default: toon) |
| `--full` | Untruncated `result` |
| `--verbose` | Include raw `usage` object |
| `--max-runtime-ms <n>` | Overall wall-clock limit (default: 30 minutes) |
| `--idle-timeout-ms <n>` | Optional no-output timeout; disabled by default because Cursor may be silent while tools run |
| `--quiet` | Suppress stdout |
| `--prompt-file`, `--stdin` | Prompt input |
| `--sandbox enabled\|disabled` | Sandbox override |

The wrapper always passes `--trust --approve-mcps` to Cursor CLI. Use `--force` only when the delegated agent should edit files or run mutating commands.

## Structured output

Cursor CLI has no native JSON-schema mode. The wrapper injects schema instructions into the prompt, parses JSON from the answer, and validates a basic subset (`type`, `required`, `properties`, `items`, `enum`).

- `--schema` — reusable schema file in the repo
- `--schema-json` — one-off inline schema

On success with a schema, prefer `structuredOutput` over `result`.

## Auth

| Context | What you need |
|---------|----------------|
| Your machine (after `agent login`) | Nothing extra |
| CI / headless server | `CURSOR_API_KEY` |

Verify: `agent status`

## Install Launcher

From the harness repo:

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/providers/cursor/cursor-agent.ts" ~/.local/bin/harness-cursor
chmod +x providers/cursor/cursor-agent.ts
```

Ensure `~/.local/bin` is on `PATH`.

## Raw CLI escape hatch

```bash
agent -p --trust --approve-mcps --workspace . "prompt"
agent -p --force "apply changes"
```

Docs: https://cursor.com/docs/cli
