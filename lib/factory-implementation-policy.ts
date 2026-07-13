import {
  acquireFactoryWorkItemLock,
  releaseFactoryWorkItemLock,
  type FactoryLockRuntimeOptions,
} from "./factory-locks.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { workItemKeyToFilename } from "./factory-lifecycle.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";

const IMPLEMENTATION_EXECUTION_SUFFIX = ".implementation-execution";

export function canonicalFactoryImplementationWorkspace(workspace: string): string {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return realpathSync(root);
}

export function factoryImplementationExecutionLeaseFilename(canonicalWorkspace: string): string {
  const digest = createHash("sha256").update(canonicalWorkspace).digest("hex");
  return `${workItemKeyToFilename(`workspace:${digest}`)}${IMPLEMENTATION_EXECUTION_SUFFIX}`;
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
  const canonicalWorkspace = canonicalFactoryImplementationWorkspace(input.workspace);
  const workItemKey = `workspace:${canonicalWorkspace}`;
  const workItemFilename = factoryImplementationExecutionLeaseFilename(canonicalWorkspace);
  const owner = acquireFactoryWorkItemLock({
    factoryStateRoot: input.factoryStateRoot,
    workItemKey,
    workItemFilename,
    workspace: canonicalWorkspace,
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
