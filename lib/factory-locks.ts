import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { defaultFactoryStoreRoot } from "./factory-store.ts";

export const FACTORY_LOCK_STALE_MS = 30 * 60 * 1000;
export const FACTORY_LOCK_WRITE_TIMEOUT_MS = 5_000;
export const FACTORY_LOCK_READ_TIMEOUT_MS = 2_000;

export type FactoryLockOwner = {
  pid: number;
  hostname: string;
  token: string;
  workspace: string;
  runDir?: string;
  workItemKey: string;
  startedAt: string;
  processTitle?: string;
};

export type FactoryLockIncompleteOwner = "owner-missing" | "owner-invalid";

export type FactoryLockInspection = {
  workItemKey: string;
  filename: string;
  lockPath: string;
  owner?: FactoryLockOwner;
  ageMs: number;
  stale: boolean;
  classification?: FactoryLockIncompleteOwner | "remote-owner";
  warning?: string;
};

export type FactoryLockTimeoutDiagnostic = FactoryLockInspection & {
  operation: "read" | "write";
};

export class FactoryLifecycleLockTimeoutError extends Error {
  readonly diagnostic: FactoryLockTimeoutDiagnostic;

  constructor(diagnostic: FactoryLockTimeoutDiagnostic) {
    super(
      `Timed out waiting for ${diagnostic.operation} lifecycle lock for ${diagnostic.workItemKey}: ${diagnostic.lockPath}`,
    );
    this.name = "FactoryLifecycleLockTimeoutError";
    this.diagnostic = diagnostic;
  }
}

export type FactoryLockRuntimeOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  hostname?: string;
  pid?: number;
  token?: string;
  wait?: (milliseconds: number) => void;
  publishOwner?: (path: string, owner: FactoryLockOwner) => void;
  beforeStaleRemoval?: () => void;
};

export type FactoryLockInspectionOptions = Pick<
  FactoryLockRuntimeOptions,
  "now" | "hostname" | "staleAfterMs"
> & {
  staleAfterMsForFilename?: (filename: string) => number | undefined;
};

export type WithFactoryWorkItemLockInput = {
  factoryStateRoot: string;
  workItemKey: string;
  workItemFilename: string;
  workspace: string;
  runDir?: string;
  operation: "read" | "write";
  options?: FactoryLockRuntimeOptions;
};

export function factoryWorkItemLockPath(factoryStateRoot: string, filename: string): string {
  return join(resolve(factoryStateRoot), "locks", `${filename}.lock`);
}

export function inspectFactoryWorkItemLock(input: {
  factoryStateRoot: string;
  workItemKey: string;
  workItemFilename: string;
  options?: FactoryLockInspectionOptions;
}): FactoryLockInspection | undefined {
  const lockPath = factoryWorkItemLockPath(input.factoryStateRoot, input.workItemFilename);
  if (!existsSync(lockPath)) return undefined;

  const now = input.options?.now?.() ?? Date.now();
  const staleAfterMs =
    input.options?.staleAfterMsForFilename?.(input.workItemFilename) ??
    input.options?.staleAfterMs ??
    FACTORY_LOCK_STALE_MS;
  const directoryAgeMs = Math.max(0, now - statSync(lockPath).mtimeMs);
  const ownerPath = join(lockPath, "owner.json");
  if (!existsSync(ownerPath)) {
    return {
      workItemKey: input.workItemKey,
      filename: input.workItemFilename,
      lockPath,
      ageMs: directoryAgeMs,
      stale: directoryAgeMs > staleAfterMs,
      classification: "owner-missing",
      warning: "Lifecycle lock owner.json is missing; operator cleanup may be required.",
    };
  }

  const owner = readLockOwner(ownerPath);
  if (!owner) {
    return {
      workItemKey: input.workItemKey,
      filename: input.workItemFilename,
      lockPath,
      ageMs: directoryAgeMs,
      stale: false,
      classification: "owner-invalid",
      warning: "Lifecycle lock owner.json is invalid; it is never removed automatically.",
    };
  }

  const currentHostname = input.options?.hostname ?? hostname();
  const sameHost = owner.hostname === currentHostname;
  const liveness = sameHost ? pidLiveness(owner.pid) : "unknown";
  const ageMs = Math.max(0, now - Date.parse(owner.startedAt));
  const stale = ageMs > staleAfterMs || (sameHost && liveness === "dead");
  return {
    workItemKey: input.workItemKey,
    filename: input.workItemFilename,
    lockPath,
    owner,
    ageMs,
    stale,
    ...(sameHost ? {} : { classification: "remote-owner" as const }),
    ...(sameHost
      ? {}
      : { warning: "Lifecycle lock belongs to another hostname; ownership is unknown." }),
  };
}

/** Inspect existing lock directories only. This never creates or mutates paths. */
export function inspectFactoryLocks(
  factoryStateRoot: string,
  options?: FactoryLockInspectionOptions,
): FactoryLockInspection[] {
  const locksRoot = join(resolve(factoryStateRoot), "locks");
  if (!existsSync(locksRoot)) return [];
  return readdirSync(locksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".lock"))
    .map((entry) => {
      const filename = entry.name.slice(0, -".lock".length);
      return inspectFactoryWorkItemLock({
        factoryStateRoot,
        workItemKey: filename,
        workItemFilename: filename,
        options,
      });
    })
    .filter((inspection): inspection is FactoryLockInspection => inspection !== undefined)
    .map((inspection) => ({
      ...inspection,
      ...(inspection.owner ? { workItemKey: inspection.owner.workItemKey } : {}),
    }));
}

/**
 * Synchronizes only lifecycle projection critical sections. Callers must never
 * hold this around station or provider execution.
 */
export function withFactoryWorkItemLock<T>(
  input: WithFactoryWorkItemLockInput,
  action: () => T,
): T {
  const owner = acquireFactoryWorkItemLock(input);
  try {
    return action();
  } finally {
    releaseFactoryWorkItemLock({
      factoryStateRoot: input.factoryStateRoot,
      workItemFilename: input.workItemFilename,
      owner,
    });
  }
}

export function acquireFactoryWorkItemLock(input: WithFactoryWorkItemLockInput): FactoryLockOwner {
  const options = input.options;
  const now = options?.now ?? Date.now;
  const lockPath = factoryWorkItemLockPath(input.factoryStateRoot, input.workItemFilename);
  const locksRoot = join(resolve(input.factoryStateRoot), "locks");
  const timeoutMs = options?.timeoutMs ?? defaultTimeout(input.operation);
  const deadline = now() + timeoutMs;
  let staleBreakAttempted = false;

  mkdirSync(locksRoot, { recursive: true });
  while (true) {
    const owner = newLockOwner(input, options, now);
    try {
      mkdirSync(lockPath);
      try {
        (options?.publishOwner ?? publishLockOwner)(join(lockPath, "owner.json"), owner);
      } catch (error) {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // Best effort only: a failed owner publication must not mask its cause.
        }
        throw error;
      }
      return owner;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }

    const inspection = inspectFactoryWorkItemLock({
      factoryStateRoot: input.factoryStateRoot,
      workItemKey: input.workItemKey,
      workItemFilename: input.workItemFilename,
      options,
    });
    if (!inspection) continue;
    if (inspection.stale && !staleBreakAttempted) {
      staleBreakAttempted = true;
      if (breakStaleFactoryWorkItemLock(input, inspection)) continue;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new FactoryLifecycleLockTimeoutError({ ...inspection, operation: input.operation });
    }
    const baseInterval = boundedPollInterval(options?.pollIntervalMs);
    const jitteredInterval = Math.max(
      25,
      Math.min(100, baseInterval + Math.round((Math.random() - 0.5) * 10)),
    );
    waitSync(Math.min(remaining, jitteredInterval), options?.wait);
  }
}

export function releaseFactoryWorkItemLock(input: {
  factoryStateRoot: string;
  workItemFilename: string;
  owner: FactoryLockOwner;
}): void {
  const lockPath = factoryWorkItemLockPath(input.factoryStateRoot, input.workItemFilename);
  const ownerPath = join(lockPath, "owner.json");
  if (!existsSync(ownerPath)) return;
  const current = readLockOwner(ownerPath);
  if (!current || !sameOwner(current, input.owner)) return;
  try {
    unlinkSync(ownerPath);
    rmdirSync(lockPath);
  } catch {
    // Another process or operator may have changed the directory after re-check.
  }
}

function breakStaleFactoryWorkItemLock(
  input: WithFactoryWorkItemLockInput,
  inspection: FactoryLockInspection,
): boolean {
  const ownerPath = join(inspection.lockPath, "owner.json");
  input.options?.beforeStaleRemoval?.();
  if (inspection.classification === "owner-invalid") return false;
  if (inspection.classification === "owner-missing") {
    if (existsSync(ownerPath)) return false;
    try {
      rmdirSync(inspection.lockPath);
      return true;
    } catch {
      return false;
    }
  }
  if (!inspection.owner) return false;
  const current = readLockOwner(ownerPath);
  if (!current || !sameOwner(current, inspection.owner)) return false;
  try {
    rmSync(inspection.lockPath, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function newLockOwner(
  input: WithFactoryWorkItemLockInput,
  options: FactoryLockRuntimeOptions | undefined,
  now: () => number,
): FactoryLockOwner {
  return {
    pid: options?.pid ?? process.pid,
    hostname: options?.hostname ?? hostname(),
    token: options?.token ?? randomBytes(16).toString("hex"),
    workspace: input.workspace,
    ...(input.runDir ? { runDir: input.runDir } : {}),
    workItemKey: input.workItemKey,
    startedAt: new Date(now()).toISOString(),
    processTitle: process.title,
  };
}

function publishLockOwner(path: string, owner: FactoryLockOwner): void {
  writeFileSync(path, `${JSON.stringify(owner)}\n`, "utf8");
}

function readLockOwner(path: string): FactoryLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isLockOwner(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function isLockOwner(value: unknown): value is FactoryLockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.hostname === "string" &&
    candidate.hostname.length > 0 &&
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.workspace === "string" &&
    candidate.workspace.length > 0 &&
    typeof candidate.workItemKey === "string" &&
    candidate.workItemKey.length > 0 &&
    typeof candidate.startedAt === "string" &&
    Number.isFinite(Date.parse(candidate.startedAt)) &&
    (candidate.runDir === undefined || typeof candidate.runDir === "string") &&
    (candidate.processTitle === undefined || typeof candidate.processTitle === "string")
  );
}

function sameOwner(left: FactoryLockOwner, right: FactoryLockOwner): boolean {
  return left.pid === right.pid && left.hostname === right.hostname && left.token === right.token;
}

function pidLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return "dead";
    if (isNodeError(error) && error.code === "EPERM") return "alive";
    return "unknown";
  }
}

function defaultTimeout(operation: "read" | "write"): number {
  return operation === "read" ? FACTORY_LOCK_READ_TIMEOUT_MS : FACTORY_LOCK_WRITE_TIMEOUT_MS;
}

function boundedPollInterval(value: number | undefined): number {
  return Math.max(25, Math.min(100, value ?? 50));
}

function waitSync(milliseconds: number, wait: ((milliseconds: number) => void) | undefined): void {
  if (wait) {
    wait(milliseconds);
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export type FactoryWorkspaceCanonicalization = {
  physicalGitRoot: string;
  workspaceKey: string;
};

export type FactoryWorkspaceWriterLeaseOwner = {
  pid: number;
  hostname: string;
  token: string;
  physicalGitRoot: string;
  workspaceKey: string;
  factoryProjectId: string;
  storeRoot: string;
  workItemKey: string;
  runId: string;
  attemptId?: string;
  operation: "implementation" | "remediation";
  startedAt: string;
  processTitle?: string;
};

export type FactoryWorkspaceWriterLeaseHandle = {
  path: string;
  owner: FactoryWorkspaceWriterLeaseOwner;
  canonical: FactoryWorkspaceCanonicalization;
};

export type FactoryWorkspaceWriterLeaseInspection = {
  path: string;
  physicalGitRoot: string;
  workspaceKey: string;
  owner?: FactoryWorkspaceWriterLeaseOwner;
  ageMs?: number;
  stale: boolean;
  classification?: "owner-missing" | "owner-invalid" | "remote-owner" | "unknown-liveness";
  warning?: string;
};

export class FactoryWorkspaceCanonicalizationError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryWorkspaceCanonicalizationError";
  }
}

export class FactoryWorkspaceWriterLeaseContentionError extends Error {
  readonly diagnostic: FactoryWorkspaceWriterLeaseInspection;

  constructor(diagnostic: FactoryWorkspaceWriterLeaseInspection) {
    super(
      `Factory workspace writer lease is held for ${diagnostic.physicalGitRoot}: ${formatWorkspaceLeaseOwner(diagnostic.owner)}`,
    );
    this.name = "FactoryWorkspaceWriterLeaseContentionError";
    this.diagnostic = diagnostic;
  }
}

export function canonicalizeFactoryWorkspace(workspace: string): FactoryWorkspaceCanonicalization {
  let gitRoot: string;
  try {
    gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new FactoryWorkspaceCanonicalizationError(
      `Cannot resolve Git top-level for workspace: ${workspace}`,
      { cause: error },
    );
  }
  if (!gitRoot) {
    throw new FactoryWorkspaceCanonicalizationError(
      `Git top-level is empty for workspace: ${workspace}`,
    );
  }
  try {
    const physicalGitRoot = realpathSync(resolve(gitRoot));
    const workspaceKey = createHash("sha256").update(physicalGitRoot).digest("hex");
    return { physicalGitRoot, workspaceKey };
  } catch (error) {
    throw new FactoryWorkspaceCanonicalizationError(
      `Cannot resolve physical Git top-level: ${gitRoot}`,
      { cause: error },
    );
  }
}

export function resolveFactoryWorkspaceLeaseRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultFactoryStoreRoot(env), "workspace-leases");
}

export function factoryWorkspaceLeasePath(input: { workspace: string; env?: NodeJS.ProcessEnv }): {
  canonical: FactoryWorkspaceCanonicalization;
  path: string;
} {
  const canonical = canonicalizeFactoryWorkspace(input.workspace);
  return {
    canonical,
    path: join(resolveFactoryWorkspaceLeaseRoot(input.env), `${canonical.workspaceKey}.lock`),
  };
}

export type AcquireFactoryWorkspaceWriterLeaseInput = {
  workspace: string;
  factoryProjectId: string;
  storeRoot: string;
  workItemKey: string;
  runId: string;
  attemptId?: string;
  operation: "implementation" | "remediation";
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  pid?: number;
  token?: string;
  now?: () => number;
};

export function acquireFactoryWorkspaceWriterLease(
  input: AcquireFactoryWorkspaceWriterLeaseInput,
): FactoryWorkspaceWriterLeaseHandle {
  const { canonical, path } = factoryWorkspaceLeasePath({
    workspace: input.workspace,
    env: input.env,
  });
  const root = dirname(path);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  } catch (error) {
    throw new FactoryWorkspaceCanonicalizationError(
      `Cannot create or inspect factory workspace lease namespace: ${root}`,
      { cause: error },
    );
  }
  const now = input.now ?? Date.now;
  const owner: FactoryWorkspaceWriterLeaseOwner = {
    pid: input.pid ?? process.pid,
    hostname: input.hostname ?? hostname(),
    token: input.token ?? randomBytes(16).toString("hex"),
    physicalGitRoot: canonical.physicalGitRoot,
    workspaceKey: canonical.workspaceKey,
    factoryProjectId: input.factoryProjectId,
    storeRoot: resolve(input.storeRoot),
    workItemKey: input.workItemKey,
    runId: input.runId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    operation: input.operation,
    startedAt: new Date(now()).toISOString(),
    processTitle: process.title,
  };
  try {
    mkdirSync(path);
    writeFileSync(join(path, "owner.json"), `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { path, owner, canonical };
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw new FactoryWorkspaceCanonicalizationError(
        `Cannot acquire factory workspace writer lease: ${path}`,
        { cause: error },
      );
    }
  }

  const inspection = inspectFactoryWorkspaceWriterLease({
    workspace: input.workspace,
    env: input.env,
    now,
    hostname: input.hostname,
  });
  if (
    inspection?.stale &&
    inspection.owner &&
    inspection.owner.hostname === (input.hostname ?? hostname())
  ) {
    const liveness = pidLiveness(inspection.owner.pid);
    if (liveness === "dead" && removeMatchingWorkspaceLease(path, inspection.owner)) {
      try {
        mkdirSync(path);
        writeFileSync(join(path, "owner.json"), `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        return { path, owner, canonical };
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw new FactoryWorkspaceCanonicalizationError(
            `Cannot acquire reclaimed factory workspace writer lease: ${path}`,
            { cause: error },
          );
        }
      }
    }
  }
  throw new FactoryWorkspaceWriterLeaseContentionError(
    inspection ?? {
      path,
      physicalGitRoot: canonical.physicalGitRoot,
      workspaceKey: canonical.workspaceKey,
      stale: false,
      warning: "Lease exists but owner diagnostics could not be inspected.",
    },
  );
}

export function releaseFactoryWorkspaceWriterLease(input: {
  handle: FactoryWorkspaceWriterLeaseHandle;
}): void {
  const ownerPath = join(input.handle.path, "owner.json");
  if (!existsSync(ownerPath)) return;
  const current = readWorkspaceLeaseOwner(ownerPath);
  if (!current || current.token !== input.handle.owner.token) return;
  removeMatchingWorkspaceLease(input.handle.path, input.handle.owner);
}

export function inspectFactoryWorkspaceWriterLease(input: {
  workspace: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  hostname?: string;
}): FactoryWorkspaceWriterLeaseInspection | undefined {
  const { canonical, path } = factoryWorkspaceLeasePath(input);
  if (!existsSync(path)) return undefined;
  const ownerPath = join(path, "owner.json");
  const now = input.now ?? Date.now;
  if (!existsSync(ownerPath)) {
    return {
      path,
      physicalGitRoot: canonical.physicalGitRoot,
      workspaceKey: canonical.workspaceKey,
      stale: false,
      classification: "owner-missing",
      warning: "Workspace writer lease owner.json is missing; operator cleanup required.",
    };
  }
  const owner = readWorkspaceLeaseOwner(ownerPath);
  if (!owner) {
    return {
      path,
      physicalGitRoot: canonical.physicalGitRoot,
      workspaceKey: canonical.workspaceKey,
      stale: false,
      classification: "owner-invalid",
      warning:
        "Workspace writer lease owner.json is malformed; it is never reclaimed automatically.",
    };
  }
  const sameHost = owner.hostname === (input.hostname ?? hostname());
  const liveness = sameHost ? pidLiveness(owner.pid) : "unknown";
  return {
    path,
    physicalGitRoot: canonical.physicalGitRoot,
    workspaceKey: canonical.workspaceKey,
    owner,
    ageMs: Math.max(0, now() - Date.parse(owner.startedAt)),
    stale: sameHost && liveness === "dead",
    ...(sameHost
      ? liveness === "unknown"
        ? { classification: "unknown-liveness" as const }
        : {}
      : { classification: "remote-owner" as const }),
    ...(sameHost && liveness === "unknown"
      ? { warning: "Workspace writer lease owner liveness is unknown; operator cleanup required." }
      : {}),
  };
}

function readWorkspaceLeaseOwner(path: string): FactoryWorkspaceWriterLeaseOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isWorkspaceLeaseOwner(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function isWorkspaceLeaseOwner(value: unknown): value is FactoryWorkspaceWriterLeaseOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.hostname === "string" &&
    candidate.hostname.length > 0 &&
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.physicalGitRoot === "string" &&
    candidate.physicalGitRoot.length > 0 &&
    typeof candidate.workspaceKey === "string" &&
    candidate.workspaceKey.length > 0 &&
    typeof candidate.factoryProjectId === "string" &&
    candidate.factoryProjectId.length > 0 &&
    typeof candidate.storeRoot === "string" &&
    candidate.storeRoot.length > 0 &&
    typeof candidate.workItemKey === "string" &&
    candidate.workItemKey.length > 0 &&
    typeof candidate.runId === "string" &&
    candidate.runId.length > 0 &&
    (candidate.attemptId === undefined || typeof candidate.attemptId === "string") &&
    (candidate.operation === "implementation" || candidate.operation === "remediation") &&
    typeof candidate.startedAt === "string" &&
    Number.isFinite(Date.parse(candidate.startedAt))
  );
}

function removeMatchingWorkspaceLease(
  path: string,
  owner: FactoryWorkspaceWriterLeaseOwner,
): boolean {
  const ownerPath = join(path, "owner.json");
  const current = readWorkspaceLeaseOwner(ownerPath);
  if (!current || current.token !== owner.token) return false;
  try {
    rmSync(path, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function formatWorkspaceLeaseOwner(owner: FactoryWorkspaceWriterLeaseOwner | undefined): string {
  if (!owner) return "owner diagnostics unavailable";
  return `${owner.hostname}:${owner.pid} run=${owner.runId} work-item=${owner.workItemKey}`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : ".";
}
