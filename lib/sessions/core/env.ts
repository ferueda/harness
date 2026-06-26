import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SessionEnvironment = {
  cursorHome: string;
  codexHome: string;
  codexStateDbPath?: string;
  cacheRoot: string;
  homeDir: string;
  harnessRoot: string;
  now: () => Date;
};

const CORE_DIR = dirname(fileURLToPath(import.meta.url));

export function defaultSessionEnvironment(
  overrides: Partial<SessionEnvironment> = {},
): SessionEnvironment {
  const homeDir = overrides.homeDir ?? homedir();
  const harnessRoot = overrides.harnessRoot ?? resolveHarnessRoot();
  return {
    cursorHome: overrides.cursorHome ?? join(homeDir, ".cursor"),
    codexHome: overrides.codexHome ?? join(homeDir, ".codex"),
    codexStateDbPath: overrides.codexStateDbPath,
    cacheRoot: overrides.cacheRoot ?? join(homeDir, ".harness", "session-index"),
    homeDir,
    harnessRoot,
    now: overrides.now ?? (() => new Date()),
  };
}

function resolveHarnessRoot(): string {
  const fromSource = resolve(CORE_DIR, "../../..");
  if (existsSync(join(fromSource, "package.json")) && basename(fromSource) !== "dist") {
    return fromSource;
  }
  const fromDist = resolve(CORE_DIR, "../../../..");
  if (existsSync(join(fromDist, "package.json"))) return fromDist;
  return basename(fromSource) === "dist" ? resolve(fromSource, "..") : fromSource;
}
