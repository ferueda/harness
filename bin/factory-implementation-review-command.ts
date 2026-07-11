import type { Command } from "commander";
import { resolveFactoryLinearSettings, resolveHarnessOptions } from "../lib/config.ts";
import {
  runFactoryImplementationReview,
  type FactoryImplementationReviewDependencies,
  type FactoryImplementationReviewResult,
} from "../lib/factory-implementation-review.ts";
import { createLinearFactoryAdapter } from "../lib/factory-linear-adapter.ts";
import { resolveFactoryStore } from "../lib/factory-store.ts";
import {
  resolveFactoryWorkItemInput,
  validateFactoryWorkItemInput,
} from "../lib/factory-triage-input.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";

type FactoryImplementationReviewOptions = {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
  maxRuntimeMs: number;
  verbose: boolean;
};

export type FactoryImplementationReviewCommandConfig = {
  positiveNumber: (value: string) => number;
  defaultMaxRuntimeMs: number;
  writeVerboseWorkflowEvent: (event: WorkflowEvent) => void;
  linearAdapterFactory?: typeof createLinearFactoryAdapter;
  dependencies?: FactoryImplementationReviewDependencies;
};

export function addFactoryImplementationReviewCommand(
  parent: Command,
  config: FactoryImplementationReviewCommandConfig,
): void {
  parent
    .command("review")
    .description("Review one completed factory implementation")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier, e.g. TEAM-123")
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option(
      "--max-runtime-ms <ms>",
      `per-reviewer timeout (default: ${config.defaultMaxRuntimeMs})`,
      config.positiveNumber,
      config.defaultMaxRuntimeMs,
    )
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: FactoryImplementationReviewOptions) => {
      validateFactoryWorkItemInput(options);
      const harness = resolveHarnessOptions({ workspace: options.workspace });
      const linearSettings = options.linearIssue
        ? resolveFactoryLinearSettings({ workspace: harness.workspace })
        : undefined;
      const store = resolveFactoryStore({
        workspace: harness.workspace,
        factoryStoreRoot: options.factoryStoreRoot,
        factoryStoreProjectId: options.factoryStoreProjectId,
        env: process.env,
      });
      const resolvedInput = await resolveFactoryWorkItemInput({
        workspace: harness.workspace,
        itemFile: options.itemFile,
        linearIssue: options.linearIssue,
        linearSettings,
        env: process.env,
        lifecycleReadMode: "load",
        factoryStateRoot: store.factoryStateRoot,
        ...(options.linearIssue
          ? {
              linearAdapterFactory: config.linearAdapterFactory ?? createLinearFactoryAdapter,
            }
          : {}),
      });
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      process.once("SIGINT", onAbort);
      process.once("SIGTERM", onAbort);
      try {
        const result = await runFactoryImplementationReview(
          {
            workspace: harness.workspace,
            workItem: resolvedInput.workItem,
            store,
            agentProvider: harness.agentProvider,
            model: harness.model,
            codexPathOverride: harness.codexPathOverride,
            sandboxMode: harness.sandboxMode,
            approvalPolicy: harness.approvalPolicy,
            modelReasoningEffort: harness.modelReasoningEffort,
            maxRuntimeMs: options.maxRuntimeMs,
            signal: abort.signal,
            eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined,
          },
          config.dependencies,
        );
        emitFactoryImplementationReviewResult(result);
      } finally {
        process.off("SIGINT", onAbort);
        process.off("SIGTERM", onAbort);
      }
    });
}

export function emitFactoryImplementationReviewResult(
  result: FactoryImplementationReviewResult,
): void {
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.outcome === "review-complete" ? undefined : 1;
}
