import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type FactoryLinearSettings } from "./config.ts";
import { type LinearFactoryAdapter, createLinearFactoryAdapter } from "./factory-linear-adapter.ts";
import { type FactoryWorkItem } from "./factory-schemas.ts";
import { readFactoryWorkItemFile } from "./factory-run-context.ts";

export type FactoryTriageInputSource = "item-file" | "linear";

export type FactoryTriageWorkItemInput = {
  source: FactoryTriageInputSource;
  workItem: FactoryWorkItem;
  linearApplied?: false;
};

export type ResolveFactoryTriageWorkItemInput = {
  workspace: string;
  itemFile?: string;
  linearIssue?: string;
  linearSettings?: FactoryLinearSettings;
  env?: NodeJS.ProcessEnv;
  linearAdapterFactory?: (input: {
    apiKey: string;
    settings: FactoryLinearSettings;
  }) => LinearFactoryAdapter;
};

export async function resolveFactoryTriageWorkItem(
  input: ResolveFactoryTriageWorkItemInput,
): Promise<FactoryTriageWorkItemInput> {
  if (input.itemFile) {
    const itemPath = assertFactoryItemFileExists(input.workspace, input.itemFile);
    return {
      source: "item-file",
      workItem: readFactoryWorkItemFile(itemPath),
    };
  }

  if (!input.linearIssue) {
    throw new Error("one of --item-file or --linear-issue is required");
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
  return {
    source: "linear",
    workItem: await adapter.fetchWorkItem(input.linearIssue),
    linearApplied: false,
  };
}

export function assertFactoryItemFileExists(workspace: string, itemFile: string): string {
  const resolvedItemPath = isAbsolute(itemFile) ? itemFile : join(workspace, itemFile);
  if (!existsSync(resolvedItemPath)) {
    throw new Error(`Factory item file does not exist: ${itemFile}`);
  }
  return resolvedItemPath;
}
