import type { Command } from "commander";
import { assertCodexOnlyAgentOptions } from "./cli-validation.ts";
import {
  type AgentApprovalPolicy,
  type AgentProviderName,
  type AgentReasoningEffort,
  type AgentSandboxMode,
} from "../lib/agents.ts";
import { resolveHarnessOptions } from "../lib/config.ts";
import {
  dispatchFactoryInbox,
  factoryInboxStatus,
  type FactoryDispatchResult,
} from "../lib/factory-dispatch.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";
import { createAgentProvider } from "../providers/registry.ts";
import { run as runFactoryTriage } from "../workflows/factory-triage.workflow.ts";

type FactoryStatusOptions = {
  workspace?: string;
  inboxDir?: string;
};

type FactoryDispatchCliOptions = {
  workspace?: string;
  inboxDir?: string;
  runsDir?: string;
  agent?: AgentProviderName;
  codexExecutable?: string;
  model?: string;
  sandbox?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  reasoningEffort?: AgentReasoningEffort;
  maxRuntimeMs: number;
  dryRun: boolean;
  verbose: boolean;
};

type FactoryCommandParsers = {
  parseAgentProvider: (value: string) => AgentProviderName;
  parseSandboxMode: (value: string) => AgentSandboxMode;
  parseApprovalPolicy: (value: string) => AgentApprovalPolicy;
  parseReasoningEffort: (value: string) => AgentReasoningEffort;
  positiveNumber: (value: string) => number;
};

type FactoryCommandOptions = FactoryCommandParsers & {
  defaultMaxRuntimeMs: number;
  writeVerboseWorkflowEvent: (event: WorkflowEvent) => void;
};

export function addFactoryCommands(parent: Command, options: FactoryCommandOptions): void {
  const factory = parent.command("factory").description("Manage local factory intake");
  addFactoryStatusCommand(factory);
  addFactoryDispatchCommand(factory, options);
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

function addFactoryDispatchCommand(parent: Command, config: FactoryCommandOptions): void {
  parent
    .command("dispatch")
    .description("Dispatch local factory inbox items through factory triage")
    .option("--workspace <path>", "target repo")
    .option(
      "--inbox-dir <path>",
      "factory inbox root (default: <workspace>/.harness/inbox/factory)",
    )
    .option("--runs-dir <path>", "output root (default: <workspace>/.harness/runs/factory)")
    .option(
      "--agent <provider>",
      "triage agent provider: cursor or codex",
      config.parseAgentProvider,
    )
    .option("--codex-executable <path>", "Codex CLI executable override")
    .option("--model <id>", "agent model override")
    .option(
      "--sandbox <mode>",
      "Codex-only sandbox mode (default for factory triage: read-only)",
      config.parseSandboxMode,
    )
    .option(
      "--approval-policy <policy>",
      "Codex-only approval policy (default for factory triage: never)",
      config.parseApprovalPolicy,
    )
    .option(
      "--reasoning-effort <effort>",
      "Codex-only reasoning effort: minimal,low,medium,high,xhigh",
      config.parseReasoningEffort,
    )
    .option(
      "--max-runtime-ms <ms>",
      `triage timeout per inbox item (default: ${config.defaultMaxRuntimeMs})`,
      config.positiveNumber,
      config.defaultMaxRuntimeMs,
    )
    .option("--dry-run", "process items without moving inbox files", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: FactoryDispatchCliOptions) => {
      const resolvedOptions = resolveHarnessOptions({
        workspace: options.workspace,
        runsDir: options.runsDir,
        agentProvider: options.agent,
        codexPathOverride: options.codexExecutable,
        model: options.model,
        sandboxMode: options.sandbox,
        approvalPolicy: options.approvalPolicy,
        modelReasoningEffort: options.reasoningEffort,
        maxRuntimeMs: options.maxRuntimeMs,
        dryRun: options.dryRun,
        includeGitScope: false,
      });
      assertCodexOnlyAgentOptions(resolvedOptions.agentProvider, {
        codexExecutable: options.codexExecutable,
        sandbox: options.sandbox,
        approvalPolicy: options.approvalPolicy,
        reasoningEffort: options.reasoningEffort,
      });

      const runAbort = new AbortController();
      const onRunAbort = () => runAbort.abort();
      process.once("SIGINT", onRunAbort);
      process.once("SIGTERM", onRunAbort);
      let result: FactoryDispatchResult;
      try {
        result = await dispatchFactoryInbox({
          workspace: resolvedOptions.workspace,
          runsDir: resolvedOptions.runsDir,
          agentProvider: resolvedOptions.agentProvider,
          codexPathOverride: resolvedOptions.codexPathOverride,
          model: resolvedOptions.model,
          sandboxMode: resolvedOptions.sandboxMode,
          approvalPolicy: resolvedOptions.approvalPolicy,
          modelReasoningEffort: resolvedOptions.modelReasoningEffort,
          maxRuntimeMs: resolvedOptions.maxRuntimeMs,
          dryRun: resolvedOptions.dryRun,
          inboxDir: options.inboxDir,
          runFactoryTriage,
          agentProviderFactory: createAgentProvider,
          signal: runAbort.signal,
          eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined,
        });
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.failedCount > 0 ? 1 : 0;
    });
}
