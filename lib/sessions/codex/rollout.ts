import { readFileSync } from "node:fs";
import type { Turn } from "../core/types.ts";

type RolloutEvent = {
  type?: unknown;
  payload?: unknown;
};

type RolloutPayload = {
  type?: unknown;
  message?: unknown;
  phase?: unknown;
  role?: unknown;
  name?: unknown;
  arguments?: unknown;
  output?: unknown;
  content?: unknown;
};

export type ParsedCodexRollout = {
  turns: Turn[];
  firstUserQuery?: string;
};

export class CodexRolloutParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexRolloutParseError";
  }
}

export function parseCodexRolloutFile(path: string): ParsedCodexRollout {
  return parseCodexRolloutText(readFileSync(path, "utf8"));
}

export function parseCodexRolloutText(text: string): ParsedCodexRollout {
  const turns: Turn[] = [];
  let firstUserQuery: string | undefined;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const event = parseLine(line, index + 1);
    const turn = turnForEvent(event);
    if (!turn) continue;
    if (turn.role === "user" && turn.text) firstUserQuery ??= turn.text;
    turns.push(turn);
  }

  return { turns, firstUserQuery };
}

function turnForEvent(event: RolloutEvent): Turn | undefined {
  const payload = objectPayload(event.payload);
  if (!payload) return undefined;

  if (event.type === "event_msg") {
    if (payload.type === "user_message") return messageTurn("user", payload.message);
    if (payload.type === "agent_message") return messageTurn("assistant", payload.message);
    if (payload.type === "task_started")
      return { role: "system", text: "Task started", rawText: "Task started" };
    if (payload.type === "task_complete")
      return { role: "system", text: "Task complete", rawText: "Task complete" };
    return undefined;
  }

  if (event.type !== "response_item") return undefined;
  if (payload.type === "function_call") {
    const name = typeof payload.name === "string" ? payload.name : "unknown_tool";
    const args = typeof payload.arguments === "string" ? payload.arguments : "";
    const text = args ? `${name} ${args}` : name;
    return { role: "tool", text, rawText: text };
  }
  if (payload.type === "function_call_output") {
    const output = typeof payload.output === "string" ? payload.output : "";
    if (!output) return undefined;
    return { role: "tool", text: output, rawText: output };
  }
  if (payload.type === "message") {
    const role = normalizeRole(payload.role);
    const text = extractContentText(payload.content);
    if (!text || role === "system") return undefined;
    return { role, text, rawText: text };
  }
  return undefined;
}

function messageTurn(role: Turn["role"], value: unknown): Turn | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return { role, text, rawText: text };
}

function parseLine(line: string, lineNumber: number): RolloutEvent {
  try {
    return JSON.parse(line) as RolloutEvent;
  } catch (error) {
    throw new CodexRolloutParseError(
      `Invalid Codex rollout JSONL at line ${lineNumber}: ${String(error)}`,
    );
  }
}

function objectPayload(value: unknown): RolloutPayload | undefined {
  return value && typeof value === "object" ? (value as RolloutPayload) : undefined;
}

function normalizeRole(role: unknown): Turn["role"] {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return role;
  if (role === "developer") return "system";
  return "unknown";
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object" || !("text" in item)) return "";
      return typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}
