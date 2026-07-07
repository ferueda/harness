import { type FactoryLinearSettings } from "./config.ts";
import { type LinearFactoryAdapter, createLinearFactoryAdapter } from "./factory-linear-adapter.ts";
import { type FactoryWorkItem } from "./factory-schemas.ts";
import { assertFactoryItemFileExists, readFactoryWorkItemFile } from "./factory-run-context.ts";

// Shared station input resolver. Kept in the original triage-named module for now
// to avoid import churn while planning adopts the same input contract.
export type FactoryWorkItemInputSource = "item-file" | "linear";

export type FactoryResolvedWorkItemInput = {
  source: FactoryWorkItemInputSource;
  workItem: FactoryWorkItem;
  linearApplied?: false;
};

export type ResolveFactoryWorkItemInput = {
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

type ValidFactoryWorkItemInputSources =
  | { itemFile: string; linearIssue?: undefined }
  | { itemFile?: undefined; linearIssue: string };

export async function resolveFactoryWorkItemInput(
  input: ResolveFactoryWorkItemInput,
): Promise<FactoryResolvedWorkItemInput> {
  validateFactoryWorkItemInput(input);

  if (input.itemFile !== undefined) {
    const itemPath = assertFactoryItemFileExists(input.workspace, input.itemFile);
    return {
      source: "item-file",
      workItem: readFactoryWorkItemFile(itemPath),
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
  return {
    source: "linear",
    workItem: await adapter.fetchWorkItem(input.linearIssue),
    linearApplied: false,
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
