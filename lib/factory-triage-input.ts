import { type FactoryLinearSettings } from "./config.ts";
import { type LinearFactoryAdapter, createLinearFactoryAdapter } from "./factory-linear-adapter.ts";
import type { FactoryLockRuntimeOptions } from "./factory-locks.ts";
import {
  deriveFactoryWorkItemKey,
  inspectFactoryLifecycleState,
  loadFactoryLifecycleState,
  mergeFactoryStateIntoWorkItem,
  resolveFactoryStateRoot,
  type FactoryLifecycleWarning,
} from "./factory-lifecycle.ts";
import { type FactoryWorkItem } from "./factory-schemas.ts";
import { assertFactoryItemFileExists, readFactoryWorkItemFile } from "./factory-run-context.ts";

// Shared station input resolver. Kept in the original triage-named module for now
// to avoid import churn while planning adopts the same input contract.
export type FactoryWorkItemInputSource = "item-file" | "linear";

export type FactoryResolvedWorkItemInput = {
  source: FactoryWorkItemInputSource;
  workItem: FactoryWorkItem;
  linearApplied?: false;
  warnings?: FactoryLifecycleWarning[];
};

export type FactoryLifecycleReadMode = "inspect" | "load" | "none";

export type ResolveFactoryWorkItemInput = {
  workspace: string;
  itemFile?: string;
  linearIssue?: string;
  linearSettings?: FactoryLinearSettings;
  env?: NodeJS.ProcessEnv;
  factoryStateRoot?: string;
  /** Low-level/test-only workspace-local lifecycle escape hatch. */
  allowWorkspaceLocalStateRoot?: boolean;
  lifecycleReadMode: FactoryLifecycleReadMode;
  /** Test-only seam for bounded lock contention coverage. */
  lifecycleLockOptions?: FactoryLockRuntimeOptions;
  linearAdapterFactory?: (input: {
    apiKey: string;
    settings: FactoryLinearSettings;
  }) => LinearFactoryAdapter;
};

type ValidFactoryWorkItemInputSources =
  | { itemFile: string; linearIssue?: undefined }
  | { itemFile?: undefined; linearIssue: string };

export async function resolveFactoryWorkItemInput(
  input: ResolveFactoryWorkItemInput,
): Promise<FactoryResolvedWorkItemInput> {
  validateFactoryWorkItemInput(input);

  if (input.itemFile !== undefined) {
    const itemPath = assertFactoryItemFileExists(input.workspace, input.itemFile);
    const merged = mergeLifecycleState({
      workspace: input.workspace,
      factoryStateRoot: input.factoryStateRoot,
      allowWorkspaceLocalStateRoot: input.allowWorkspaceLocalStateRoot,
      lifecycleReadMode: input.lifecycleReadMode,
      lifecycleLockOptions: input.lifecycleLockOptions,
      workItem: readFactoryWorkItemFile(itemPath),
    });
    return {
      source: "item-file",
      workItem: merged.workItem,
      ...(merged.warnings.length > 0 ? { warnings: merged.warnings } : {}),
    };
  }

  if (!input.linearSettings) {
    throw new Error(
      "factory.linear is required in harness.json for Linear commands. Configure teamKey and statuses.",
    );
  }

  const apiKey = input.env?.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is required for Linear commands.");
  }

  const adapterFactory = input.linearAdapterFactory ?? createLinearFactoryAdapter;
  const adapter = adapterFactory({
    apiKey,
    settings: input.linearSettings,
  });
  const merged = mergeLifecycleState({
    workspace: input.workspace,
    factoryStateRoot: input.factoryStateRoot,
    allowWorkspaceLocalStateRoot: input.allowWorkspaceLocalStateRoot,
    lifecycleReadMode: input.lifecycleReadMode,
    lifecycleLockOptions: input.lifecycleLockOptions,
    workItem: await adapter.fetchWorkItem(input.linearIssue),
  });
  return {
    source: "linear",
    workItem: merged.workItem,
    ...(merged.warnings.length > 0 ? { warnings: merged.warnings } : {}),
    linearApplied: false,
  };
}

export function mergeLifecycleState(input: {
  workspace: string;
  workItem: FactoryWorkItem;
  factoryStateRoot?: string;
  allowWorkspaceLocalStateRoot?: boolean;
  lifecycleReadMode: FactoryLifecycleReadMode;
  lifecycleLockOptions?: FactoryLockRuntimeOptions;
}): { workItem: FactoryWorkItem; warnings: FactoryLifecycleWarning[] } {
  if (input.lifecycleReadMode === "none") return { workItem: input.workItem, warnings: [] };
  if (!input.factoryStateRoot && !input.allowWorkspaceLocalStateRoot) {
    throw new Error(
      "factoryStateRoot is required for factory station lifecycle reads; pass allowWorkspaceLocalStateRoot only for low-level workspace-local tests.",
    );
  }
  const factoryStateRoot = resolveFactoryStateRoot(input);
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  if (input.lifecycleReadMode === "inspect") {
    const inspected = inspectFactoryLifecycleState({ factoryStateRoot, workItemKey });
    return {
      workItem: mergeFactoryStateIntoWorkItem(input.workItem, inspected.state),
      warnings: inspected.warnings,
    };
  }
  return {
    workItem: mergeFactoryStateIntoWorkItem(
      input.workItem,
      loadFactoryLifecycleState({
        factoryStateRoot,
        workItemKey,
        workspace: input.workspace,
        lockOptions: input.lifecycleLockOptions,
      }),
    ),
    warnings: [],
  };
}

export function validateFactoryTriageWorkItemInput(input: {
  itemFile?: string;
  linearIssue?: string;
}): asserts input is ValidFactoryWorkItemInputSources {
  validateFactoryWorkItemInput(input);
}

export function validateFactoryWorkItemInput(input: {
  itemFile?: string;
  linearIssue?: string;
}): asserts input is ValidFactoryWorkItemInputSources {
  if (input.itemFile && input.linearIssue) {
    throw new Error("--item-file and --linear-issue are mutually exclusive");
  }
  if (!input.itemFile && !input.linearIssue) {
    throw new Error("one of --item-file or --linear-issue is required");
  }
}

export type FactoryTriageInputSource = FactoryWorkItemInputSource;
export type FactoryTriageWorkItemInput = FactoryResolvedWorkItemInput;
export type ResolveFactoryTriageWorkItemInput = ResolveFactoryWorkItemInput;

export async function resolveFactoryTriageWorkItem(
  input: ResolveFactoryTriageWorkItemInput,
): Promise<FactoryTriageWorkItemInput> {
  return resolveFactoryWorkItemInput(input);
}
