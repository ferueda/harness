import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAgent } from "./codex-agent.ts";
import { createCursorAgent } from "./cursor-agent.ts";
import type { Agent, AgentProviderName } from "./agents.ts";

export type AgentProviderOptions = {
  provider: AgentProviderName;
  cursorAgentPath?: string;
  codexPathOverride?: string;
};

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_BUILT_OUTPUT = basename(MODULE_ROOT) === "dist";
const HARNESS_ROOT = IS_BUILT_OUTPUT ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;
const RUNTIME_ROOT = IS_BUILT_OUTPUT ? MODULE_ROOT : HARNESS_ROOT;
const DEFAULT_CURSOR_AGENT = join(
  RUNTIME_ROOT,
  IS_BUILT_OUTPUT ? "providers/cursor/cursor-agent.js" : "providers/cursor/cursor-agent.ts",
);

export function createAgentProvider(options: AgentProviderOptions): Agent {
  if (options.provider === "codex") {
    return createCodexAgent({ codexPathOverride: options.codexPathOverride });
  }

  return createCursorAgent({
    cursorAgentPath: resolveCursorAgentPath(options.cursorAgentPath),
  });
}

function resolveCursorAgentPath(explicitPath?: string): string {
  const candidates = [explicitPath ? resolve(explicitPath) : null, DEFAULT_CURSOR_AGENT].filter(
    (candidate): candidate is string => Boolean(candidate),
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("cursor-agent entrypoint not found. Pass --cursor-agent.");
}
