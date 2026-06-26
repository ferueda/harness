import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionEnvironment } from "../core/env.ts";
import type { WorkspacePathConfidence } from "../core/types.ts";

export type WorkspacePathResult = {
  path: string;
  confidence: WorkspacePathConfidence;
};

export type TranscriptFile = {
  workspaceKey: string;
  workspacePath: string;
  workspacePathConfidence: WorkspacePathConfidence;
  chatId: string;
  jsonlPath: string;
};

export function cursorProjectsRoot(env: SessionEnvironment): string {
  return join(env.cursorHome, "projects");
}

export function decodeWorkspacePathFromKey(projectDirName: string): WorkspacePathResult {
  // Cursor does not escape hyphens in path segments, so folder-name decoding is lossy.
  return {
    path: `/${projectDirName.replaceAll("-", "/")}`,
    confidence: "decoded",
  };
}

export function extractWorkspacePathFromUserInfo(text: string): WorkspacePathResult | null {
  const match = /^Workspace Path:\s*(.+)$/im.exec(text);
  if (!match?.[1]) return null;
  return {
    path: match[1].trim(),
    confidence: "explicit",
  };
}

export function globTranscriptFiles(env: SessionEnvironment): TranscriptFile[] {
  const projectsRoot = cursorProjectsRoot(env);
  if (!existsSync(projectsRoot)) return [];

  const files: TranscriptFile[] = [];
  for (const projectDir of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const workspaceKey = projectDir.name;
    const decoded = decodeWorkspacePathFromKey(workspaceKey);
    const transcriptsRoot = join(projectsRoot, workspaceKey, "agent-transcripts");
    if (!existsSync(transcriptsRoot)) continue;
    for (const jsonlPath of walkJsonlFiles(transcriptsRoot)) {
      const chatId = basename(jsonlPath, ".jsonl");
      files.push({
        workspaceKey,
        workspacePath: decoded.path,
        workspacePathConfidence: decoded.confidence,
        chatId,
        jsonlPath,
      });
    }
  }
  return files.toSorted((left, right) => left.jsonlPath.localeCompare(right.jsonlPath));
}

function walkJsonlFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkJsonlFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(path);
    }
  }
  return found;
}
