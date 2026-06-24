import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { HarnessConfigSchema, formatZodError } from "./schemas.ts";

const CONFIG_FILE = "harness.json";
export const HARNESS_GITIGNORE_ENTRY = ".harness/";

export type HarnessOptions = {
  workspace?: string;
  baseRef?: string;
  headRef?: string;
  [key: string]: unknown;
};

export type ResolvedHarnessOptions<T extends HarnessOptions = HarnessOptions> = T & {
  workspace: string;
  baseRef: string;
  headRef: string;
};

export type InitHarnessOptions = {
  workspace?: string;
  baseRef?: string;
};

export function resolveHarnessOptions<T extends HarnessOptions>(
  options: T,
  cwd = process.cwd(),
): ResolvedHarnessOptions<T> {
  const workspace = resolveWorkspace(options.workspace, cwd);
  const config = readHarnessConfig(workspace);

  return {
    ...options,
    workspace,
    baseRef: options.baseRef ?? config.base ?? "main",
    headRef: options.headRef ?? "HEAD",
  };
}

export function findHarnessConfig(startDir: string): string | null {
  let current = resolve(startDir);

  while (true) {
    const candidate = join(current, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function initHarnessConfig(
  options: InitHarnessOptions = {},
  cwd = process.cwd(),
): {
  workspace: string;
  configPath: string;
  gitignorePath: string;
  baseSkipped: boolean;
  configCreated: boolean;
  gitignoreUpdated: boolean;
} {
  const workspace = resolveWorkspace(options.workspace, cwd);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }

  const configPath = join(workspace, CONFIG_FILE);
  const gitignorePath = join(workspace, ".gitignore");
  const result = {
    workspace,
    configPath,
    gitignorePath,
    baseSkipped: false,
    configCreated: false,
    gitignoreUpdated: false,
  };

  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      `${JSON.stringify({ base: options.baseRef ?? "main" }, null, 2)}\n`,
      "utf8",
    );
    result.configCreated = true;
  } else if (options.baseRef) {
    result.baseSkipped = true;
  }

  result.gitignoreUpdated = ensureGitignoreEntry(gitignorePath, HARNESS_GITIGNORE_ENTRY);
  return result;
}

function resolveWorkspace(explicitWorkspace: string | undefined, cwd: string): string {
  if (explicitWorkspace) {
    return isAbsolute(explicitWorkspace) ? explicitWorkspace : resolve(cwd, explicitWorkspace);
  }

  const configPath = findHarnessConfig(cwd);
  if (configPath) {
    return dirname(configPath);
  }

  return resolveGitRoot(cwd);
}

function readHarnessConfig(workspace: string) {
  const configPath = join(workspace, CONFIG_FILE);
  if (!existsSync(configPath)) return {};

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${CONFIG_FILE}: ${message}`);
  }

  const result = HarnessConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid ${CONFIG_FILE}: ${formatZodError(result.error)}`);
  }

  return result.data;
}

function resolveGitRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      `Workspace not found. Add ${CONFIG_FILE}, run inside a Git repo, or pass --workspace.`,
    );
  }
}

function ensureGitignoreEntry(path: string, entry: string): boolean {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  if (lines.some((line) => isHarnessIgnoreEntry(line))) {
    return false;
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${existing}${prefix}${entry}\n`, "utf8");
  return true;
}

function isHarnessIgnoreEntry(line: string): boolean {
  // Treat common .gitignore spellings as already covering the .harness artifact tree.
  const trimmed = line.trim();
  return [
    ".harness",
    ".harness/",
    ".harness/*",
    ".harness/**",
    "**/.harness",
    "**/.harness/",
  ].includes(trimmed);
}
