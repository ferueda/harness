import {
  FACTORY_LOCK_STALE_MS,
  acquireFactoryWorkItemLock,
  factoryWorkItemLockPath,
  releaseFactoryWorkItemLock,
  type FactoryLockRuntimeOptions,
} from "./factory-locks.ts";
import { utimesSync } from "node:fs";
import { deriveFactoryWorkItemKey, workItemKeyToFilename } from "./factory-lifecycle.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";

const IMPLEMENTATION_EXECUTION_SUFFIX = ".implementation-execution";

export function factoryImplementationExecutionLeaseFilename(workItemKey: string): string {
  return `${workItemKeyToFilename(workItemKey)}${IMPLEMENTATION_EXECUTION_SUFFIX}`;
}

export function isFactoryImplementationExecutionLeaseFilename(filename: string): boolean {
  return filename.endsWith(IMPLEMENTATION_EXECUTION_SUFFIX);
}

export async function withFactoryImplementationExecutionLease<T>(input: {
  factoryStateRoot: string;
  workspace: string;
  runDir?: string;
  workItem: FactoryWorkItem;
  options?: FactoryLockRuntimeOptions;
  action: () => Promise<T>;
}): Promise<T> {
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  const workItemFilename = factoryImplementationExecutionLeaseFilename(workItemKey);
  const owner = acquireFactoryWorkItemLock({
    factoryStateRoot: input.factoryStateRoot,
    workItemKey,
    workItemFilename,
    workspace: input.workspace,
    runDir: input.runDir,
    operation: "write",
    options: {
      ...input.options,
      timeoutMs: 0,
      // Same-host dead owners are reclaimed by PID liveness; remote owners
      // never expire by wall-clock age.
      staleAfterMs: Infinity,
    },
  });
  const lockPath = factoryWorkItemLockPath(input.factoryStateRoot, workItemFilename);
  const heartbeat = setInterval(
    () => {
      try {
        const now = new Date();
        utimesSync(lockPath, now, now);
      } catch {
        // The lifecycle lock remains the source of truth; release will fail closed.
      }
    },
    Math.max(1_000, Math.floor(FACTORY_LOCK_STALE_MS / 3)),
  );
  heartbeat.unref?.();
  try {
    return await input.action();
  } finally {
    clearInterval(heartbeat);
    releaseFactoryWorkItemLock({
      factoryStateRoot: input.factoryStateRoot,
      workItemFilename,
      owner,
    });
  }
}
