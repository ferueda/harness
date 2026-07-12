import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  resolveFactoryStoreSettings,
  resolveFactoryStoreSettingsFromSnapshot,
  type FactoryConfigSnapshot,
} from "./config.ts";
import { FactoryStoreProjectIdSchema, formatZodError } from "./schemas.ts";

export type FactoryRepoIdentitySource =
  | "config"
  | "cli"
  | "env"
  | "origin"
  | "no-origin-fallback"
  | "workspace-fallback";

export type FactoryRepoIdentity = {
  name: string;
  id: string;
  idSource: FactoryRepoIdentitySource;
  normalizedOriginUrl?: string;
  originHash?: string;
  workspaceHash?: string;
};

export type FactoryStoreOverrides = {
  storeRoot?: "cli" | "env" | "config";
  projectId?: "cli" | "env" | "config";
  runsDir?: string;
  factoryStateRoot?: string;
};

export type FactoryStoreResolution = {
  workspace: string;
  storeRoot: string;
  projectId: string;
  projectRoot: string;
  factoryStateRoot: string;
  factoryRunsDir: string;
  reviewRunsDir: string;
  repo: FactoryRepoIdentity;
  overrides: FactoryStoreOverrides;
  warnings: string[];
};

/** Serializable store provenance written into factory run metadata. */
export type FactoryStoreMeta = Omit<FactoryStoreResolution, "workspace">;

export type FactoryExecutionProvenance = {
  workspace: string;
  runDir: string;
  branch?: string;
  head?: string;
};

export type FactoryLifecycleExecutionProvenance = FactoryExecutionProvenance & {
  storeRoot?: string;
  projectId?: string;
  factoryStateRoot?: string;
  repo?: Omit<FactoryRepoIdentity, "normalizedOriginUrl">;
};

export type ResolveFactoryStoreInput = {
  workspace?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configSnapshot?: FactoryConfigSnapshot;
};

export type LegacyFactoryState = {
  path: string;
  eventCount: number;
  stateCount: number;
  ignored: true;
  warnings: string[];
};

export class FactoryStoreError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryStoreError";
  }
}

/**
 * The only production defaulting entry point for the durable factory store.
 * It deliberately computes paths only; write paths create directories.
 */
export function resolveFactoryStore(input: ResolveFactoryStoreInput = {}): FactoryStoreResolution {
  const settings = input.configSnapshot
    ? resolveFactoryStoreSettingsFromSnapshot(input.configSnapshot)
    : resolveFactoryStoreSettings({ workspace: input.workspace }, input.cwd ?? process.cwd());
  const env = input.env ?? process.env;
  const root = resolveStoreRoot(input, env, settings.root);
  const identity = deriveFactoryRepoIdentity(settings.workspace);
  const { warnings, ...repoIdentity } = identity;
  const projectId = resolveProjectId(input, env, settings.projectId, repoIdentity);
  const projectsRoot = resolve(root.storeRoot, "projects");
  const projectRoot = resolve(projectsRoot, projectId.value);
  const projectRelative = relative(projectsRoot, projectRoot);
  if (
    !projectRelative ||
    projectRelative === ".." ||
    projectRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(projectRelative)
  ) {
    throw new FactoryStoreError("Factory store project path escapes storeRoot/projects");
  }

  return {
    workspace: settings.workspace,
    storeRoot: root.storeRoot,
    projectId: projectId.value,
    projectRoot,
    factoryStateRoot: join(projectRoot, "factory"),
    factoryRunsDir: join(projectRoot, "runs", "factory"),
    reviewRunsDir: join(projectRoot, "runs", "reviews"),
    repo: {
      ...repoIdentity,
      id: projectId.value,
      idSource: projectId.source ?? repoIdentity.idSource,
    },
    overrides: {
      ...(root.source ? { storeRoot: root.source } : {}),
      ...(projectId.source ? { projectId: projectId.source } : {}),
    },
    warnings,
  };
}

export function defaultFactoryStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim();
  return resolve(
    dataHome && dataHome.length > 0
      ? join(dataHome, "harness", "store")
      : join(homedir(), ".local", "share", "harness", "store"),
  );
}

export function deriveFactoryRepoIdentity(
  workspace: string,
): FactoryRepoIdentity & { warnings: string[] } {
  const resolvedWorkspace = resolve(workspace);
  const gitRoot = gitOutput(resolvedWorkspace, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) {
    const name = safeRepoName(basename(resolvedWorkspace));
    const workspaceHash = shortHash(resolvedWorkspace);
    return {
      name,
      id: `${name}-workspace-${workspaceHash}`,
      idSource: "workspace-fallback",
      workspaceHash,
      warnings: [
        "Factory store uses a workspace-path fallback id; set factory.store.projectId for durable non-Git workspaces.",
      ],
    };
  }

  const origin = gitOutput(resolvedWorkspace, ["config", "--get", "remote.origin.url"]);
  const root = resolve(gitRoot);
  if (origin) {
    const normalizedOriginUrl = normalizeGitOriginUrl(origin);
    const name = safeRepoName(lastPathSegment(normalizedOriginUrl) || basename(root));
    const originHash = shortHash(normalizedOriginUrl);
    return {
      name,
      id: `${name}-${originHash}`,
      idSource: "origin",
      normalizedOriginUrl,
      originHash,
      warnings: [],
    };
  }

  const commonDir = gitOutput(resolvedWorkspace, ["rev-parse", "--git-common-dir"]);
  const stablePath = commonDir ? resolve(root, commonDir) : root;
  const name = safeRepoName(basename(root));
  const workspaceHash = shortHash(stablePath);
  return {
    name,
    id: `${name}-no-origin-${workspaceHash}`,
    idSource: "no-origin-fallback",
    workspaceHash,
    warnings: [
      "Factory store could not find Git origin; set factory.store.projectId for a durable repository identity.",
    ],
  };
}

/** Normalize Git remotes without retaining credentials. */
export function normalizeGitOriginUrl(origin: string): string {
  const trimmed = origin.trim();
  if (!trimmed) throw new FactoryStoreError("Git origin URL is empty");

  try {
    const url = new URL(trimmed);
    return normalizeOriginParts(url.host, url.pathname);
  } catch {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
    if (scp) return normalizeOriginParts(scp[1], scp[2]);
    const withoutCredentials = trimmed.replace(/^[^@/]+@/, "");
    const slash = withoutCredentials.indexOf("/");
    if (slash > 0)
      return normalizeOriginParts(
        withoutCredentials.slice(0, slash),
        withoutCredentials.slice(slash),
      );
    return normalizeOriginParts("local", withoutCredentials);
  }
}

export function detectLegacyFactoryState(workspace: string): LegacyFactoryState {
  const path = join(resolve(workspace), ".harness", "factory");
  const eventCount = countFactoryStateFiles(join(path, "events"));
  const stateCount = countFactoryStateFiles(join(path, "state"));
  const hasLegacyState = eventCount > 0 || stateCount > 0;
  return {
    path,
    eventCount,
    stateCount,
    ignored: true,
    warnings: hasLegacyState
      ? ["Legacy workspace-local factory lifecycle state is ignored in v1; the durable store wins."]
      : [],
  };
}

export function factoryStoreMetadata(resolution: FactoryStoreResolution): FactoryStoreMeta {
  const { workspace: _workspace, ...metadata } = resolution;
  return metadata;
}

/** Soft Git probe: factory execution still works for explicit non-Git workspaces. */
export function factoryExecutionProvenance(
  workspace: string,
  runDir: string,
): FactoryExecutionProvenance {
  const resolvedWorkspace = resolve(workspace);
  const branch = gitOutput(resolvedWorkspace, ["branch", "--show-current"]);
  const head = gitOutput(resolvedWorkspace, ["rev-parse", "HEAD"]);
  return {
    workspace: resolvedWorkspace,
    runDir: resolve(runDir),
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
  };
}

/** Lifecycle events keep store identity but intentionally omit raw origin URLs. */
export function factoryLifecycleExecutionProvenance(
  execution: FactoryExecutionProvenance,
  factoryStore: FactoryStoreMeta | undefined,
): FactoryLifecycleExecutionProvenance {
  if (!factoryStore) return execution;
  return {
    ...execution,
    storeRoot: factoryStore.storeRoot,
    projectId: factoryStore.projectId,
    factoryStateRoot: factoryStore.factoryStateRoot,
    repo: {
      name: factoryStore.repo.name,
      id: factoryStore.repo.id,
      idSource: factoryStore.repo.idSource,
      ...(factoryStore.repo.originHash ? { originHash: factoryStore.repo.originHash } : {}),
      ...(factoryStore.repo.workspaceHash
        ? { workspaceHash: factoryStore.repo.workspaceHash }
        : {}),
    },
  };
}

function resolveStoreRoot(
  input: ResolveFactoryStoreInput,
  env: NodeJS.ProcessEnv,
  configRoot: string | undefined,
): { storeRoot: string; source?: "cli" | "env" | "config" } {
  if (input.factoryStoreRoot !== undefined)
    return { storeRoot: parseFactoryStoreRoot(input.factoryStoreRoot, "CLI"), source: "cli" };
  if (env.HARNESS_FACTORY_STORE_ROOT !== undefined)
    return {
      storeRoot: parseFactoryStoreRoot(env.HARNESS_FACTORY_STORE_ROOT, "environment"),
      source: "env",
    };
  if (configRoot !== undefined)
    return { storeRoot: parseFactoryStoreRoot(configRoot, "harness.json"), source: "config" };
  return { storeRoot: defaultFactoryStoreRoot(env) };
}

function parseFactoryStoreRoot(value: string, source: string): string {
  if (value.trim().length === 0) {
    throw new FactoryStoreError(`Invalid ${source} factory store root: must not be blank`);
  }
  return resolve(value);
}

function resolveProjectId(
  input: ResolveFactoryStoreInput,
  env: NodeJS.ProcessEnv,
  configProjectId: string | undefined,
  identity: FactoryRepoIdentity,
): { value: string; source?: "cli" | "env" | "config" } {
  if (input.factoryStoreProjectId !== undefined) {
    return { value: parseFactoryStoreProjectId(input.factoryStoreProjectId, "CLI"), source: "cli" };
  }
  if (env.HARNESS_FACTORY_STORE_PROJECT_ID !== undefined) {
    return {
      value: parseFactoryStoreProjectId(env.HARNESS_FACTORY_STORE_PROJECT_ID, "environment"),
      source: "env",
    };
  }
  if (configProjectId !== undefined) {
    return { value: parseFactoryStoreProjectId(configProjectId, "harness.json"), source: "config" };
  }
  return { value: parseFactoryStoreProjectId(identity.id, "derived repository identity") };
}

function parseFactoryStoreProjectId(value: string, source: string): string {
  const parsed = FactoryStoreProjectIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new FactoryStoreError(
    `Invalid ${source} factory store project id: ${formatZodError(parsed.error)}`,
  );
}

function normalizeOriginParts(host: string, pathname: string): string {
  const normalizedHost = host.trim().replace(/^.*@/, "").toLowerCase();
  const normalizedPath = pathname
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (!normalizedHost || !normalizedPath) {
    throw new FactoryStoreError("Git origin URL must include a host and repository path");
  }
  return `${normalizedHost}/${normalizedPath}`;
}

function gitOutput(workspace: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function safeRepoName(value: string): string {
  const sanitized = value
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 96);
  return sanitized || "repository";
}

function lastPathSegment(value: string): string {
  return value.split("/").at(-1) ?? "";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function countFactoryStateFiles(path: string): number {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
}
