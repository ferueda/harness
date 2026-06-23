import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const CONFIG_FILE = "harness.json";
export const HARNESS_GITIGNORE_ENTRY = ".harness/";

export function resolveHarnessOptions(options, cwd = process.cwd()) {
  const workspace = resolveWorkspace(options.workspace, cwd);
  const config = readHarnessConfig(workspace);

  return {
    ...options,
    workspace,
    baseRef: options.baseRef ?? config.base ?? "main",
    headRef: options.headRef ?? "HEAD",
  };
}

export function findHarnessConfig(startDir) {
  let current = resolve(startDir);

  while (true) {
    const candidate = join(current, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function initHarnessConfig(options = {}, cwd = process.cwd()) {
  const workspace = resolveWorkspace(options.workspace, cwd);
  const configPath = join(workspace, CONFIG_FILE);
  const gitignorePath = join(workspace, ".gitignore");
  const result = {
    workspace,
    configPath,
    gitignorePath,
    configCreated: false,
    gitignoreUpdated: false,
  };

  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify({ base: options.baseRef ?? "main" }, null, 2)}\n`, "utf8");
    result.configCreated = true;
  }

  result.gitignoreUpdated = ensureGitignoreEntry(gitignorePath, HARNESS_GITIGNORE_ENTRY);
  return result;
}

function resolveWorkspace(explicitWorkspace, cwd) {
  if (explicitWorkspace) {
    return isAbsolute(explicitWorkspace) ? explicitWorkspace : resolve(cwd, explicitWorkspace);
  }

  const configPath = findHarnessConfig(cwd);
  if (configPath) {
    return dirname(configPath);
  }

  return resolveGitRoot(cwd);
}

function readHarnessConfig(workspace) {
  const configPath = join(workspace, CONFIG_FILE);
  if (!existsSync(configPath)) return {};

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${CONFIG_FILE}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${CONFIG_FILE}: expected an object`);
  }
  if (parsed.base !== undefined && typeof parsed.base !== "string") {
    throw new Error(`Invalid ${CONFIG_FILE}: base must be a string`);
  }

  return parsed;
}

function resolveGitRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(`Workspace not found. Add ${CONFIG_FILE}, run inside a Git repo, or pass --workspace.`);
  }
}

function ensureGitignoreEntry(path, entry) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  if (lines.includes(entry)) {
    return false;
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${existing}${prefix}${entry}\n`, "utf8");
  return true;
}
