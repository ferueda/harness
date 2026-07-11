import {
  acquireFactoryWorkItemLock,
  releaseFactoryWorkItemLock,
  type FactoryLockRuntimeOptions,
} from "./factory-locks.ts";
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
      staleAfterMs: Infinity,
    },
  });
  try {
    return await input.action();
  } finally {
    releaseFactoryWorkItemLock({
      factoryStateRoot: input.factoryStateRoot,
      workItemFilename,
      owner,
    });
  }
}
