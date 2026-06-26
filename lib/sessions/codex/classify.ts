import { hasAutomationMarker } from "../core/classify.ts";

export type CodexThreadClassificationInput = {
  threadId: string;
  title: string;
  source: string;
  threadSource?: string;
  firstUserQuery?: string;
  isSpawnChild: boolean;
  parentThreadId?: string;
  agentRole?: string;
  agentNickname?: string;
};

export function isCodexSubagent(input: CodexThreadClassificationInput): boolean {
  return (
    input.isSpawnChild || sourceHasSubagentSpawn(input.source) || input.threadSource === "subagent"
  );
}

export function isCodexAutomation(input: CodexThreadClassificationInput): boolean {
  return (
    input.title.startsWith("Automation:") ||
    input.source === "automation" ||
    input.threadSource === "automation" ||
    hasAutomationMarker(input.firstUserQuery)
  );
}

export function sourceHasSubagentSpawn(source: string): boolean {
  const parsed = parseSourceJson(source);
  if (!parsed || typeof parsed !== "object" || !("subagent" in parsed)) return false;
  const subagent = parsed.subagent;
  return Boolean(subagent && typeof subagent === "object" && "thread_spawn" in subagent);
}

function parseSourceJson(source: string): unknown {
  if (!source.trim().startsWith("{")) return undefined;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
}
