import { readFileSync } from "node:fs";
import type { Turn } from "../core/types.ts";
import { extractWorkspacePathFromUserInfo, type WorkspacePathResult } from "./paths.ts";

type CursorJsonLine = {
  role?: unknown;
  message?: {
    content?: unknown;
  };
};

export type ParsedTranscript = {
  turns: Turn[];
  firstUserQuery?: string;
  workspacePath?: WorkspacePathResult;
};

export class CursorTranscriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorTranscriptParseError";
  }
}

export function parseTranscriptFile(path: string): ParsedTranscript {
  return parseTranscriptText(readFileSync(path, "utf8"));
}

export function parseTranscriptText(text: string): ParsedTranscript {
  const turns: Turn[] = [];
  let firstUserQuery: string | undefined;
  let workspacePath: WorkspacePathResult | undefined;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const parsed = parseLine(line, index + 1);
    const rawText = extractContentText(parsed.message?.content);
    const role = normalizeRole(parsed.role);
    if (role === "unknown" && !rawText) continue;
    const userQuery = role === "user" ? extractUserQuery(rawText) : undefined;
    if (role === "user") {
      firstUserQuery ??= userQuery ?? rawText;
      workspacePath ??= extractWorkspacePathFromUserInfo(rawText) ?? undefined;
    }
    turns.push({
      role,
      rawText,
      text: role === "user" ? stripInjectedBlocks(userQuery ?? rawText) : rawText,
    });
  }

  return { turns, firstUserQuery, workspacePath };
}

export function extractUserQuery(text: string): string | undefined {
  const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text);
  return match?.[1]?.trim();
}

export function stripInjectedBlocks(text: string): string {
  return text
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, "")
    .replace(/<instructions>[\s\S]*?<\/instructions>/gi, "")
    .replace(/#\s*AGENTS\.md instructions[\s\S]*/gi, "")
    .trim();
}

function parseLine(line: string, lineNumber: number): CursorJsonLine {
  try {
    return JSON.parse(line) as CursorJsonLine;
  } catch (error) {
    throw new CursorTranscriptParseError(
      `Invalid Cursor transcript JSONL at line ${lineNumber}: ${String(error)}`,
    );
  }
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
    .join("\n");
}

function normalizeRole(role: unknown): Turn["role"] {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return role;
  return "unknown";
}
