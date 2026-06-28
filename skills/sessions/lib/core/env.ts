import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SessionEnvironment = {
  cursorHome: string;
  codexHome: string;
  codexStateDbPath?: string;
  cacheRoot: string;
  homeDir: string;
  skillRoot: string;
  now: () => Date;
};

const CORE_DIR = dirname(fileURLToPath(import.meta.url));

export function defaultSessionEnvironment(
  overrides: Partial<SessionEnvironment> = {},
): SessionEnvironment {
  const homeDir = overrides.homeDir ?? homedir();
  const skillRoot = overrides.skillRoot ?? resolveSkillRoot();
  return {
    cursorHome: overrides.cursorHome ?? join(homeDir, ".cursor"),
    codexHome: overrides.codexHome ?? join(homeDir, ".codex"),
    codexStateDbPath: overrides.codexStateDbPath,
    cacheRoot: overrides.cacheRoot ?? resolveDefaultCacheRoot(homeDir),
    homeDir,
    skillRoot,
    now: overrides.now ?? (() => new Date()),
  };
}

function resolveDefaultCacheRoot(homeDir: string): string {
  const fromEnv = process.env.SESSIONS_CACHE_DIR?.trim();
  if (fromEnv) return fromEnv;
  const cacheRoot = join(homeDir, ".sessions", "index");
  migrateLegacyCacheRoot(homeDir, cacheRoot);
  return cacheRoot;
}

function migrateLegacyCacheRoot(homeDir: string, cacheRoot: string): void {
  const legacyRoot = join(homeDir, ".harness", "session-index");
  if (existsSync(cacheRoot) || !existsSync(legacyRoot)) return;
  mkdirSync(dirname(cacheRoot), { recursive: true });
  renameSync(legacyRoot, cacheRoot);
  console.error(`migrated sessions cache from ${legacyRoot} to ${cacheRoot}`);
}

function resolveSkillRoot(): string {
  let current = CORE_DIR;
  while (true) {
    if (existsSync(join(current, "SKILL.md"))) return current;
    const parent = dirname(current);
    if (parent === current) return join(CORE_DIR, "../..");
    current = parent;
  }
}
