import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionEnvironment } from "../core/env.ts";

export function codexStateDbPath(env: SessionEnvironment): string {
  if (env.codexStateDbPath) return env.codexStateDbPath;
  const rootDb = join(env.codexHome, "state_5.sqlite");
  if (existsSync(rootDb)) return rootDb;
  return join(env.codexHome, "sqlite", "state_5.sqlite");
}

export function resolveCodexRolloutPath(env: SessionEnvironment, rolloutPath: string): string {
  if (isAbsolute(rolloutPath)) return rolloutPath;
  const relative = rolloutPath.replace(/^\.?\//, "");
  if (relative.startsWith("sessions/") || relative.startsWith("archived_sessions/")) {
    return join(env.codexHome, relative);
  }
  const direct = join(env.codexHome, relative);
  if (existsSync(direct)) return direct;
  return join(env.codexHome, "sessions", relative);
}

export function workspaceKeyForCodexPath(path: string): string {
  const normalized = resolve(path || "/")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "home";
}
