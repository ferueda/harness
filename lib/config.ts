import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_AGENT_MODELS,
  DEFAULT_CODEX_REASONING_EFFORT,
  type AgentApprovalPolicy,
  type AgentProviderName,
  type AgentReasoningEffort,
  type AgentSandboxMode,
} from "./agents.ts";
import {
  HarnessConfigSchema,
  formatZodError,
  type HarnessConfig,
  type LinearAutomationConfig,
} from "./schemas.ts";
import type { LinearReadinessMapping } from "./linear-readiness.ts";

const CONFIG_FILE = "harness.json";
export const HARNESS_GITIGNORE_ENTRY = ".harness/";
export const HARNESS_SHIM_RELATIVE_PATH = ".harness/bin/harness";
export const HARNESS_RECOMMENDED_COMMAND = `${HARNESS_SHIM_RELATIVE_PATH} run change-review`;

export type HarnessOptions = {
  workspace?: string;
  baseRef?: string;
  headRef?: string;
  agentProvider?: AgentProviderName;
  model?: string;
  codexPathOverride?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
  [key: string]: unknown;
};

export type ResolvedHarnessOptions<T extends HarnessOptions = HarnessOptions> = T & {
  workspace: string;
  baseRef: string;
  headRef: string;
  agentProvider: AgentProviderName;
  model?: string;
  codexPathOverride?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
};

export type InitHarnessOptions = {
  workspace?: string;
  baseRef?: string;
  harnessEntrypoint: string;
  nodePath?: string;
};

export type InitHarnessResult = {
  workspace: string;
  configPath: string;
  gitignorePath: string;
  shimPath: string;
  recommendedCommand: string;
  baseSkipped: boolean;
  configCreated: boolean;
  gitignoreUpdated: boolean;
  shimUpdated: boolean;
};

export type HarnessConfigSnapshot = Readonly<{
  workspace: string;
  config: HarnessConfig;
}>;

export type LinearAutomationSettings = Readonly<{
  workspace: string;
  readiness: LinearReadinessMapping;
  triage: Readonly<{
    agent: AgentProviderName;
    model: string;
    modelReasoningEffort: AgentReasoningEffort;
    maxRuntimeMs: number;
    codexPathOverride?: string;
  }>;
}>;

export function loadHarnessConfigSnapshot(
  workspaceInput?: string,
  cwd = process.cwd(),
): HarnessConfigSnapshot {
  const workspace = resolveHarnessWorkspace(workspaceInput, cwd);
  return Object.freeze({ workspace, config: readHarnessConfig(workspace) });
}

export function resolveLinearAutomationSettings(
  options: { workspace?: string },
  cwd = process.cwd(),
): LinearAutomationSettings {
  return resolveLinearAutomationSettingsFromSnapshot(
    loadHarnessConfigSnapshot(options.workspace, cwd),
  );
}

export function resolveLinearAutomationSettingsFromSnapshot(
  snapshot: HarnessConfigSnapshot,
): LinearAutomationSettings {
  const { workspace, config } = snapshot;
  const automation = config.linearAutomation;
  if (!automation) {
    throw new Error(
      "linearAutomation is required in harness.json for the Linear worker. Configure readiness IDs and triage.",
    );
  }

  const agentConfig = config.agents?.codex ?? {};
  const model = automation.triage.model ?? agentConfig.model ?? DEFAULT_AGENT_MODELS.codex;
  const modelReasoningEffort =
    automation.triage.modelReasoningEffort ??
    config.agents?.codex?.modelReasoningEffort ??
    DEFAULT_CODEX_REASONING_EFFORT;

  return freezeLinearAutomationSettings({
    workspace,
    automation,
    model,
    modelReasoningEffort,
    codexPathOverride: config.agents?.codex?.executable,
  });
}

export function resolveHarnessOptions<T extends HarnessOptions>(
  options: T,
  cwd = process.cwd(),
): ResolvedHarnessOptions<T> {
  const workspace = resolveHarnessWorkspace(options.workspace, cwd);
  const config = readHarnessConfig(workspace);
  const agentProvider = options.agentProvider ?? config.defaultAgent ?? "cursor";
  const agentConfig = config.agents?.[agentProvider] ?? {};
  const codexConfig = agentProvider === "codex" ? config.agents?.codex : undefined;

  return {
    ...options,
    workspace,
    baseRef: options.baseRef ?? config.base ?? "main",
    headRef: options.headRef ?? "HEAD",
    agentProvider,
    model: options.model ?? agentConfig.model ?? DEFAULT_AGENT_MODELS[agentProvider],
    codexPathOverride: options.codexPathOverride ?? codexConfig?.executable,
    sandboxMode: options.sandboxMode ?? codexConfig?.sandboxMode,
    approvalPolicy: options.approvalPolicy ?? codexConfig?.approvalPolicy,
    modelReasoningEffort:
      options.modelReasoningEffort ??
      (agentProvider === "codex"
        ? (codexConfig?.modelReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT)
        : undefined),
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
  options: InitHarnessOptions,
  cwd = process.cwd(),
): InitHarnessResult {
  const workspace = resolveHarnessWorkspace(options.workspace, cwd);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }

  const configPath = join(workspace, CONFIG_FILE);
  const gitignorePath = join(workspace, ".gitignore");
  const harnessEntrypoint = resolveRequiredPath("harnessEntrypoint", options.harnessEntrypoint);
  const shim = writeHarnessShim(workspace, {
    harnessEntrypoint,
    nodePath: resolve(options.nodePath ?? process.execPath),
  });
  const result = {
    workspace,
    configPath,
    gitignorePath,
    shimPath: shim.path,
    recommendedCommand: HARNESS_RECOMMENDED_COMMAND,
    baseSkipped: false,
    configCreated: false,
    gitignoreUpdated: false,
    shimUpdated: shim.updated,
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

export function resolveHarnessWorkspace(
  explicitWorkspace: string | undefined,
  cwd: string,
): string {
  if (explicitWorkspace) {
    return isAbsolute(explicitWorkspace) ? explicitWorkspace : resolve(cwd, explicitWorkspace);
  }

  const configPath = findHarnessConfig(cwd);
  if (configPath) {
    return dirname(configPath);
  }

  return resolveGitRoot(cwd);
}

function readHarnessConfig(workspace: string): HarnessConfig {
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

function freezeLinearAutomationSettings(input: {
  workspace: string;
  automation: LinearAutomationConfig;
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  codexPathOverride?: string;
}): LinearAutomationSettings {
  const readiness = Object.freeze({
    ...input.automation.readiness,
    stateIds: Object.freeze({ ...input.automation.readiness.stateIds }),
    nextActionLabelIds: Object.freeze({
      ...input.automation.readiness.nextActionLabelIds,
    }),
  });
  const triage = Object.freeze({
    ...input.automation.triage,
    model: input.model,
    modelReasoningEffort: input.modelReasoningEffort,
    ...(input.codexPathOverride ? { codexPathOverride: input.codexPathOverride } : {}),
  });
  return Object.freeze({
    workspace: input.workspace,
    readiness,
    triage,
  });
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

function writeHarnessShim(
  workspace: string,
  input: { harnessEntrypoint: string; nodePath: string },
): { path: string; updated: boolean } {
  const shimPath = join(workspace, HARNESS_SHIM_RELATIVE_PATH);
  return writeExecutableShim(
    shimPath,
    renderExecShim({ nodePath: input.nodePath, entrypoint: input.harnessEntrypoint }),
  );
}

function writeExecutableShim(
  shimPath: string,
  content: string,
): { path: string; updated: boolean } {
  const shimDir = dirname(shimPath);
  mkdirSync(shimDir, { recursive: true });

  const existing = existsSync(shimPath) ? readFileSync(shimPath, "utf8") : null;
  const hadContent = existing === content;
  const isExecutable = existing !== null && (statSync(shimPath).mode & 0o111) !== 0;
  const updated = !hadContent || !isExecutable;

  if (!hadContent) {
    writeFileSync(shimPath, content, "utf8");
  }
  if (!isExecutable) {
    chmodSync(shimPath, 0o755);
  }

  return {
    path: shimPath,
    updated,
  };
}

function renderExecShim(input: { nodePath: string; entrypoint: string }): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `exec ${shellQuote(input.nodePath)} ${shellQuote(input.entrypoint)} "$@"`,
    "",
  ].join("\n");
}

function resolveRequiredPath(name: string, path: string | undefined): string {
  if (!path) {
    throw new Error(`${name} is required to create the local harness shim`);
  }

  return resolve(path);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
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
