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

type ParsedRolloutTurn = {
  turn: Turn;
  messageSource?: "event_msg" | "response_item";
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
  const parsedTurns: ParsedRolloutTurn[] = [];
  let firstUserQuery: string | undefined;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const event = parseLine(line, index + 1);
    const parsedTurn = turnForEvent(event);
    if (!parsedTurn) continue;

    const previousIndex = parsedTurns.length - 1;
    const previous = parsedTurns[previousIndex];
    if (previous && isDuplicateMessage(previous, parsedTurn)) {
      if (parsedTurn.messageSource === "event_msg") {
        parsedTurns[previousIndex] = parsedTurn;
      }
      continue;
    }

    if (parsedTurn.turn.role === "user" && parsedTurn.turn.text) {
      firstUserQuery ??= parsedTurn.turn.text;
    }
    parsedTurns.push(parsedTurn);
  }

  return { turns: parsedTurns.map(({ turn }) => turn), firstUserQuery };
}

function turnForEvent(event: RolloutEvent): ParsedRolloutTurn | undefined {
  const payload = objectPayload(event.payload);
  if (!payload) return undefined;

  if (event.type === "event_msg") {
    if (payload.type === "user_message") return eventMessageTurn("user", payload.message);
    if (payload.type === "agent_message") return eventMessageTurn("assistant", payload.message);
    if (payload.type === "task_started")
      return { turn: { role: "system", text: "Task started", rawText: "Task started" } };
    if (payload.type === "task_complete")
      return { turn: { role: "system", text: "Task complete", rawText: "Task complete" } };
    return undefined;
  }

  if (event.type !== "response_item") return undefined;
  if (payload.type === "function_call") {
    const name = typeof payload.name === "string" ? payload.name : "unknown_tool";
    const args = typeof payload.arguments === "string" ? payload.arguments : "";
    const text = args ? `${name} ${args}` : name;
    return { turn: { role: "tool", text, rawText: text } };
  }
  if (payload.type === "function_call_output") {
    const output = typeof payload.output === "string" ? payload.output : "";
    if (!output) return undefined;
    return { turn: { role: "tool", text: output, rawText: output } };
  }
  if (payload.type === "message") {
    const role = normalizeRole(payload.role);
    const text = extractContentText(payload.content);
    if (!text || role === "system") return undefined;
    return {
      turn: { role, text, rawText: text },
      ...(role === "user" || role === "assistant" ? { messageSource: "response_item" } : {}),
    };
  }
  return undefined;
}

function eventMessageTurn(
  role: "user" | "assistant",
  value: unknown,
): ParsedRolloutTurn | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return { turn: { role, text, rawText: text }, messageSource: "event_msg" };
}

function isDuplicateMessage(previous: ParsedRolloutTurn, current: ParsedRolloutTurn): boolean {
  return (
    previous.messageSource !== undefined &&
    current.messageSource !== undefined &&
    previous.messageSource !== current.messageSource &&
    previous.turn.role === current.turn.role &&
    previous.turn.text === current.turn.text
  );
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
