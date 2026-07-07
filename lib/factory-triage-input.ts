import { type FactoryLinearSettings } from "./config.ts";
import { type LinearFactoryAdapter, createLinearFactoryAdapter } from "./factory-linear-adapter.ts";
import { type FactoryWorkItem } from "./factory-schemas.ts";
import { assertFactoryItemFileExists, readFactoryWorkItemFile } from "./factory-run-context.ts";

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

type ValidFactoryTriageInputSources =
  | { itemFile: string; linearIssue?: undefined }
  | { itemFile?: undefined; linearIssue: string };

export async function resolveFactoryTriageWorkItem(
  input: ResolveFactoryTriageWorkItemInput,
): Promise<FactoryTriageWorkItemInput> {
  validateFactoryTriageWorkItemInput(input);

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
}): asserts input is ValidFactoryTriageInputSources {
  if (input.itemFile && input.linearIssue) {
    throw new Error("--item-file and --linear-issue are mutually exclusive");
  }
  if (!input.itemFile && !input.linearIssue) {
    throw new Error("one of --item-file or --linear-issue is required");
  }
}
