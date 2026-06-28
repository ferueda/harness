---
name: cursor-cli
description: >-
  Run Cursor Agent headlessly and delegate work to another Cursor agent over the
  CLI. Use when the user asks to call, ask, invoke, run, or delegate to Cursor
  (e.g. "call cursor", "ask cursor", "invoke cursor agent"); when automating
  Cursor from scripts or agent-to-agent flows; or when the user mentions
  `agent -p`, headless Cursor CLI, or `cursor-cli`.
---

# Cursor CLI (Headless)

Delegate work to a Cursor agent from the shell without the IDE chat. Use when the user wants another agent to **call, ask, invoke, or run Cursor** on a task.

**Launcher:** skill-owned; **not** part of `harness`, `harness init`, or `harness install`.

**Agents:** do not assume `cursor-cli` is on `PATH`. Run the skill script directly:

1. `node <skill-root>/scripts/cursor-cli.ts …` — resolve `<skill-root>` from the loaded `cursor-cli` skill directory (packaged `skills/cursor-cli/`, target `.agents/skills/cursor-cli/`, or `~/.agents/skills/cursor-cli/`)
2. `~/.local/bin/cursor-cli` only after `skills/cursor-cli/scripts/install.sh` **and** `command -v cursor-cli` succeeds

Requires `agent` on PATH. Set **`CURSOR_API_KEY`** for subprocesses — `agent login` / Keychain auth often fails when another agent shells out to `cursor-cli`.

**Not for harness reviews:** use `harness run change-review --agent cursor` (Cursor SDK) for workflow reviews.

## When to use

| Situation | Use this |
|-----------|----------|
| User says "call cursor", "ask cursor", "invoke cursor", etc. | `cursor-cli "…"` |
| Already inside Cursor IDE chat | Task tool — not CLI |
| Harness `change-review` workflow | `harness run change-review` (SDK) — not this launcher |
| Long-lived typed service | `@cursor/sdk` |

## Quick start

```bash
# Portable (agents): run the skill script — do not rely on bare `cursor-cli` on PATH
node skills/cursor-cli/scripts/cursor-cli.ts --help

# Optional: global symlink via skill install.sh (requires ~/.local/bin on PATH)
skills/cursor-cli/scripts/install.sh

# Check auth + CLI version (after install or via node path above)
cursor-cli

# Invoke (read-only by default — no file edits)
cursor-cli "explain the backend routing"

# Allow edits
cursor-cli --force "add a regression test for auth"

# Typed JSON response
cursor-cli \
  --schema-json '{"type":"object","required":["verdict"],"properties":{"verdict":{"type":"string"}}}' \
  "Review auth.ts"

# Continue a session
cursor-cli --resume <session-id> "follow up"
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
help[1]: Run `cursor-cli --resume <id> "follow up"` to continue
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
help[1]: Run `cursor-cli "your task"` or --prompt-file / --stdin
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
| Interactive shell with `CURSOR_API_KEY` | Export key in env |
| Agent subprocess / nested `cursor-cli` | **`CURSOR_API_KEY` required** — Keychain `agent login` is unreliable |
| CI / headless server | `CURSOR_API_KEY` only |

Verify: `agent status`

## Install launcher

From the harness repo (skill path):

```bash
skills/cursor-cli/scripts/install.sh
```

Or manually:

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/skills/cursor-cli/scripts/cursor-cli.ts" ~/.local/bin/cursor-cli
chmod +x skills/cursor-cli/scripts/cursor-cli.ts
```

Direct run without install:

```bash
node skills/cursor-cli/scripts/cursor-cli.ts --help
```

Ensure `~/.local/bin` is on `PATH` when using `install.sh`.

## Raw CLI escape hatch

```bash
agent -p --trust --approve-mcps --workspace . "prompt"
agent -p --force "apply changes"
```

Docs: https://cursor.com/docs/cli
