import { join } from "node:path";
import { factoryInboxStatus, type FactoryInboxStatus } from "./factory-inbox.ts";
import { inspectFactoryLocks, type FactoryLockInspection } from "./factory-locks.ts";
import { isFactoryImplementationExecutionLeaseFilename } from "./factory-implementation-policy.ts";
import {
  countFactoryStateFiles,
  detectLegacyFactoryState,
  type FactoryStoreResolution,
} from "./factory-store.ts";

export type FactoryStatus = FactoryInboxStatus & {
  store: Omit<FactoryStoreResolution, "workspace" | "overrides">;
  locks: FactoryLockInspection[];
  legacyFactoryState: ReturnType<typeof detectLegacyFactoryState>;
  warnings: string[];
};

/** Composes read-only inbox, store, legacy, and lock inspection for status. */
export function factoryStatus(input: {
  workspace: string;
  inboxDir?: string;
  store: FactoryStoreResolution;
}): FactoryStatus {
  const inbox = factoryInboxStatus({ workspace: input.workspace, inboxDir: input.inboxDir });
  const legacyFactoryState = detectLegacyFactoryState(input.workspace);
  const hasDurableState =
    countFactoryStateFiles(join(input.store.factoryStateRoot, "events")) > 0 ||
    countFactoryStateFiles(join(input.store.factoryStateRoot, "state")) > 0;
  const warnings = [
    ...input.store.warnings,
    ...legacyFactoryState.warnings,
    ...(legacyFactoryState.eventCount + legacyFactoryState.stateCount > 0 && !hasDurableState
      ? [
          "Durable factory store is empty for this project; legacy workspace-local lifecycle is ignored in v1.",
        ]
      : []),
  ];
  return {
    ...inbox,
    store: {
      storeRoot: input.store.storeRoot,
      projectId: input.store.projectId,
      projectRoot: input.store.projectRoot,
      factoryStateRoot: input.store.factoryStateRoot,
      factoryRunsDir: input.store.factoryRunsDir,
      reviewRunsDir: input.store.reviewRunsDir,
      repo: input.store.repo,
      warnings: input.store.warnings,
    },
    locks: inspectFactoryLocks(input.store.factoryStateRoot, {
      staleAfterMsForFilename: (filename) =>
        isFactoryImplementationExecutionLeaseFilename(filename) ? Infinity : undefined,
    }),
    legacyFactoryState,
    warnings,
  };
}
