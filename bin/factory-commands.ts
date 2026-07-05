import type { Command } from "commander";
import { assertItemFileExists, factoryTriageCliOutput } from "./factory-triage-cli.ts";
import { resolveFactoryRoleAgent, resolveHarnessOptions } from "../lib/config.ts";
import { factoryInboxStatus } from "../lib/factory-inbox.ts";
import {
  createFactoryRunContext,
  readFactoryWorkItemFile,
  type FactoryRunMeta,
} from "../lib/factory-run-context.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";
import { createAgentProvider } from "../providers/registry.ts";
import { run as runFactoryTriage } from "../workflows/factory-triage.workflow.ts";

type FactoryStatusOptions = {
  workspace?: string;
  inboxDir?: string;
};

type FactoryTriageStationOptions = {
  workspace?: string;
  itemFile: string;
  runsDir?: string;
  maxRuntimeMs: number;
  dryRun: boolean;
  verbose: boolean;
};

type FactoryCommandOptions = {
  positiveNumber: (value: string) => number;
  defaultMaxRuntimeMs: number;
  writeVerboseWorkflowEvent: (event: WorkflowEvent) => void;
};

export function addFactoryCommands(parent: Command, options: FactoryCommandOptions): void {
  const factory = parent.command("factory").description("Manage local factory intake");
  addFactoryStatusCommand(factory);
  addFactoryTriageStationCommand(factory, options);
}

function addFactoryStatusCommand(parent: Command): void {
  parent
    .command("status")
    .description("Inspect local factory inbox state")
    .option("--workspace <path>", "target repo")
    .option(
      "--inbox-dir <path>",
      "factory inbox root (default: <workspace>/.harness/inbox/factory)",
    )
    .action((options: FactoryStatusOptions) => {
      const resolvedOptions = resolveHarnessOptions({
        workspace: options.workspace,
      });
      const result = factoryInboxStatus({
        workspace: resolvedOptions.workspace,
        inboxDir: options.inboxDir,
      });
      console.log(JSON.stringify(result, null, 2));
    });
}

function addFactoryTriageStationCommand(parent: Command, config: FactoryCommandOptions): void {
  parent
    .command("triage")
    .description("Run one factory work item through the triage station")
    .option("--workspace <path>", "target repo")
    .requiredOption("--item-file <path>", "factory work item JSON file")
    .option("--runs-dir <path>", "output root (default: <workspace>/.harness/runs/factory)")
    .option(
      "--max-runtime-ms <ms>",
      `triage timeout (default: ${config.defaultMaxRuntimeMs})`,
      config.positiveNumber,
      config.defaultMaxRuntimeMs,
    )
    .option("--dry-run", "prepare context and placeholder routing only", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: FactoryTriageStationOptions) => {
      const role = resolveFactoryRoleAgent({
        workspace: options.workspace,
        station: "triage",
        role: "triager",
      });
      const itemPath = assertItemFileExists(role.workspace, options.itemFile);
      const workItem = readFactoryWorkItemFile(itemPath);

      const runAbort = new AbortController();
      const onRunAbort = () => runAbort.abort();
      process.once("SIGINT", onRunAbort);
      process.once("SIGTERM", onRunAbort);
      let meta: FactoryRunMeta;
      try {
        const ctx = createFactoryRunContext({
          workspace: role.workspace,
          runsDir: options.runsDir,
          workItem,
          agentProvider: role.agent,
          codexPathOverride: role.codexPathOverride,
          model: role.model,
          sandboxMode: role.sandboxMode,
          approvalPolicy: role.approvalPolicy,
          modelReasoningEffort: role.modelReasoningEffort,
          maxRuntimeMs: options.maxRuntimeMs,
          dryRun: options.dryRun,
          signal: runAbort.signal,
          eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined,
          agentProviderFactory: createAgentProvider,
        });
        meta = await runFactoryTriage(ctx);
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
      console.log(JSON.stringify(factoryTriageCliOutput(meta), null, 2));
      process.exitCode = meta.status === "failed" ? 1 : 0;
    });
}
