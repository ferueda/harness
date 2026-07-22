#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCodexOnlyAgentOptions } from "./cli-validation.ts";
import { addLinearWorkerCommand } from "./linear-worker-command.ts";
import {
  AGENT_APPROVAL_POLICIES,
  AGENT_MODEL_CATALOG,
  AGENT_PROVIDERS,
  AGENT_REASONING_EFFORTS,
  AGENT_SANDBOX_MODES,
  type AgentApprovalPolicy,
  type AgentProviderName,
  type AgentReasoningEffort,
  type AgentSandboxMode,
} from "../lib/agent/contract.ts";
import {
  CHANGE_REVIEW_STEPS,
  isChangeReviewStep,
  run as runChangeReview,
  type ChangeReviewStepId,
} from "../workflows/change-review.workflow.ts";
import { run as runPlanReview } from "../workflows/plan-review.workflow.ts";
import { initHarnessConfig, resolveHarnessOptions } from "../lib/config/harness.ts";
import {
  assertNonEmptyHandoffStdin,
  assertPipedHandoffStdin,
  HANDOFF_STDIN_CONFLICT_ERROR,
} from "../lib/review/handoff.ts";
import { parseRetentionDuration, pruneRuns } from "../lib/review/runs.ts";
import { installPackagedSkill } from "../lib/skills/install.ts";
import type { WorkflowEvent } from "../lib/review/events.ts";
import { cleanupOrphanedRunDir, createWorkflowContext } from "../lib/review/runtime.ts";
import { createAgentProvider } from "../providers/registry.ts";

type InitOptions = {
  workspace?: string;
  base?: string;
};

type ReviewOptions = {
  workspace?: string;
  base?: string;
  head?: string;
  plan?: string;
  handoff?: string;
  handoffStdin?: boolean;
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
  steps?: ChangeReviewStepId[];
};

type PlanReviewOptions = Omit<ReviewOptions, "base" | "head" | "steps" | "plan"> & {
  plan: string;
};

type HandoffCliOptions = {
  handoff?: string;
  handoffStdin?: boolean;
};

type RunsPruneOptions = {
  workspace?: string;
  runsDir?: string;
  olderThan: number;
  dryRun: boolean;
};

type SkillsInstallOptions = {
  workspace?: string;
  force: boolean;
  dryRun: boolean;
};

const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;
const HARNESS_ENTRYPOINT = fileURLToPath(import.meta.url);

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive number");
  }
  return parsed;
}

const parseAgentProvider = makeEnumParser<AgentProviderName>(AGENT_PROVIDERS);
const parseSandboxMode = makeEnumParser<AgentSandboxMode>(AGENT_SANDBOX_MODES);
const parseApprovalPolicy = makeEnumParser<AgentApprovalPolicy>(AGENT_APPROVAL_POLICIES);
const parseReasoningEffort = makeEnumParser<AgentReasoningEffort>(AGENT_REASONING_EFFORTS);

function makeEnumParser<T extends string>(values: readonly T[]): (value: string) => T {
  return (value: string) => {
    if (isOneOf(value, values)) return value;
    throw new InvalidArgumentError(`must be one of: ${values.join(", ")}`);
  };
}

function isOneOf<const T extends readonly string[]>(value: string, values: T): value is T[number] {
  return values.includes(value);
}

function parseStepList(value: string): ChangeReviewStepId[] {
  const steps = value
    .split(",")
    .map((step) => step.trim())
    .filter(Boolean);
  if (steps.length === 0) {
    throw new InvalidArgumentError("must include at least one step");
  }
  const selectedSteps: ChangeReviewStepId[] = [];
  for (const step of steps) {
    if (!isChangeReviewStep(step)) {
      throw new InvalidArgumentError(
        `unknown step: ${step}. Valid steps: ${CHANGE_REVIEW_STEPS.join(", ")}`,
      );
    }
    selectedSteps.push(step);
  }
  return selectedSteps;
}

function resolveHandoffText(options: HandoffCliOptions): string | undefined {
  if (options.handoff && options.handoffStdin) {
    throw new Error(HANDOFF_STDIN_CONFLICT_ERROR);
  }
  if (!options.handoffStdin) return undefined;
  assertPipedHandoffStdin(process.stdin.isTTY);

  const text = readFileSync(0, "utf8");
  assertNonEmptyHandoffStdin(text);
  return text;
}

function assertPlanFileExists(workspace: string, planPath: string): void {
  const resolvedPlanPath = isAbsolute(planPath) ? planPath : join(workspace, planPath);
  if (!existsSync(resolvedPlanPath)) {
    throw new Error(`Plan file does not exist: ${planPath}`);
  }
}

function buildProgram(): Command {
  const program = new Command();
  program.name("harness").description("Agent workflow harness").showHelpAfterError().exitOverride();

  program
    .command("init")
    .description("Create harness.json, ignore artifacts, and write a local shim")
    .option("--workspace <path>", "target repo (default: nearest harness.json or Git root)")
    .option("--base <ref>", "base ref for new harness.json (default: main)")
    .action((options: InitOptions) => {
      const result = initHarnessConfig({
        workspace: options.workspace,
        baseRef: options.base,
        harnessEntrypoint: HARNESS_ENTRYPOINT,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  const run = program.command("run").description("Run a harness workflow");
  addReviewCommand(run, {
    name: "change-review",
    description: "Run implementation and code-quality reviewers",
    workflow: runChangeReview,
  });
  addPlanReviewCommand(run);

  const runs = program.command("runs").description("Manage harness run artifacts");
  runs
    .command("prune")
    .description("Delete old harness run artifacts")
    .option(
      "--workspace <path>",
      "target repo (default: nearest harness.json or Git root; cwd when only --runs-dir is set)",
    )
    .option("--runs-dir <path>", "runs root (default: <workspace>/.harness/runs/reviews)")
    .requiredOption(
      "--older-than <duration>",
      "delete runs older than a duration, e.g. 7d or 24h",
      parseRetentionDuration,
    )
    .option("--dry-run", "show what would be deleted without deleting", false)
    .action((options: RunsPruneOptions) => {
      const shouldResolveWorkspace = options.workspace || !options.runsDir;
      const workspace = shouldResolveWorkspace
        ? resolveHarnessOptions({ workspace: options.workspace }).workspace
        : resolve(process.cwd());
      const result = pruneRuns({
        workspace,
        runsDir: options.runsDir,
        olderThanMs: options.olderThan,
        dryRun: options.dryRun,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  addLinearWorkerCommand(program);

  program
    .command("models")
    .description("List known agent models and defaults")
    .action(() => {
      console.log(JSON.stringify(AGENT_MODEL_CATALOG, null, 2));
    });

  const skills = program.command("skills").description("Manage local harness skills");
  skills
    .command("install")
    .description("Install a packaged harness skill into the target repo")
    .argument("<skill>", "packaged skill name")
    .option("--workspace <path>", "target repo (default: nearest harness.json or Git root)")
    .option("--force", "replace an existing local skill", false)
    .option("--dry-run", "show what would be installed without writing", false)
    .action((skill: string, options: SkillsInstallOptions) => {
      const result = installPackagedSkill(skill, {
        workspace: options.workspace,
        force: options.force,
        dryRun: options.dryRun,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  return program;
}

function addPlanReviewCommand(parent: Command): void {
  parent
    .command("plan-review")
    .description("Run a spec reviewer against an implementation plan")
    .option("--workspace <path>", "target repo")
    .requiredOption("--plan <path>", "plan file to review")
    .option("--handoff <path>", "optional handoff file")
    .option("--handoff-stdin", "read optional handoff text from stdin", false)
    .option("--runs-dir <path>", "output root (default: <workspace>/.harness/runs/reviews)")
    .option("--agent <provider>", "review agent provider: cursor or codex", parseAgentProvider)
    .option("--codex-executable <path>", "Codex CLI executable override")
    .option("--model <id>", "agent model override")
    .option(
      "--sandbox <mode>",
      "Codex-only sandbox mode (default for reviews: read-only)",
      parseSandboxMode,
    )
    .option(
      "--approval-policy <policy>",
      "Codex-only approval policy (default for reviews: never)",
      parseApprovalPolicy,
    )
    .option(
      "--reasoning-effort <effort>",
      "Codex-only reasoning effort: minimal,low,medium,high,xhigh",
      parseReasoningEffort,
    )
    .option(
      "--max-runtime-ms <ms>",
      `per-reviewer timeout (default: ${DEFAULT_MAX_RUNTIME_MS})`,
      positiveNumber,
      DEFAULT_MAX_RUNTIME_MS,
    )
    .option("--dry-run", "prepare context and prompts only", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: PlanReviewOptions) => {
      const handoffText = resolveHandoffText(options);
      const resolvedOptions = resolveHarnessOptions({
        workspace: options.workspace,
        planPath: options.plan,
        handoffPath: options.handoff,
        handoffText,
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
      assertPlanFileExists(resolvedOptions.workspace, options.plan);
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
      let meta;
      try {
        const ctx = createWorkflowContext({
          ...resolvedOptions,
          agentProviderFactory: createAgentProvider,
          signal: runAbort.signal,
          eventSink: options.verbose ? writeVerboseWorkflowEvent : undefined,
        });
        try {
          meta = await runPlanReview(ctx);
        } catch (error) {
          cleanupOrphanedRunDir(ctx.runDir);
          throw error;
        }
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
      console.log(JSON.stringify(meta, null, 2));
      process.exitCode = meta.verdict === "pass" || meta.status === "dry_run" ? 0 : 1;
    });
}

function addReviewCommand(
  parent: Command,
  {
    name,
    description,
    workflow,
  }: {
    name: string;
    description: string;
    workflow: typeof runChangeReview;
  },
): void {
  parent
    .command(name)
    .description(description)
    .option("--workspace <path>", "target repo")
    .option("--base <ref>", "base ref (default: harness.json base or main)")
    .option("--head <ref>", "head ref (default: HEAD)")
    .option("--plan <path>", "optional plan file")
    .option("--handoff <path>", "optional handoff file")
    .option("--handoff-stdin", "read optional handoff text from stdin", false)
    .option("--runs-dir <path>", "output root (default: <workspace>/.harness/runs/reviews)")
    .option("--agent <provider>", "review agent provider: cursor or codex", parseAgentProvider)
    .option("--codex-executable <path>", "Codex CLI executable override")
    .option("--model <id>", "agent model override")
    .option(
      "--sandbox <mode>",
      "Codex-only sandbox mode (default for reviews: read-only)",
      parseSandboxMode,
    )
    .option(
      "--approval-policy <policy>",
      "Codex-only approval policy (default for reviews: never)",
      parseApprovalPolicy,
    )
    .option(
      "--reasoning-effort <effort>",
      "Codex-only reasoning effort: minimal,low,medium,high,xhigh",
      parseReasoningEffort,
    )
    .option(
      "--steps <ids>",
      "comma-separated change-review steps: implementation,quality",
      parseStepList,
    )
    .option(
      "--max-runtime-ms <ms>",
      `per-reviewer timeout (default: ${DEFAULT_MAX_RUNTIME_MS})`,
      positiveNumber,
      DEFAULT_MAX_RUNTIME_MS,
    )
    .option("--dry-run", "prepare context and prompts only", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: ReviewOptions) => {
      const handoffText = resolveHandoffText(options);
      const resolvedOptions = resolveHarnessOptions({
        workspace: options.workspace,
        baseRef: options.base,
        headRef: options.head,
        planPath: options.plan,
        handoffPath: options.handoff,
        handoffText,
        runsDir: options.runsDir,
        agentProvider: options.agent,
        codexPathOverride: options.codexExecutable,
        model: options.model,
        sandboxMode: options.sandbox,
        approvalPolicy: options.approvalPolicy,
        modelReasoningEffort: options.reasoningEffort,
        maxRuntimeMs: options.maxRuntimeMs,
        dryRun: options.dryRun,
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
      let meta;
      try {
        const ctx = createWorkflowContext({
          ...resolvedOptions,
          agentProviderFactory: createAgentProvider,
          signal: runAbort.signal,
          eventSink: options.verbose ? writeVerboseWorkflowEvent : undefined,
        });
        try {
          meta = await workflow(ctx, { steps: options.steps });
        } catch (error) {
          cleanupOrphanedRunDir(ctx.runDir);
          throw error;
        }
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
      console.log(JSON.stringify(meta, null, 2));
      process.exitCode = meta.verdict === "pass" || meta.status === "dry_run" ? 0 : 1;
    });
}

function writeVerboseWorkflowEvent(event: WorkflowEvent): void {
  console.error(JSON.stringify(event));
}

async function main(): Promise<void> {
  try {
    const program = buildProgram();
    if (process.argv.length === 2) {
      program.outputHelp();
      process.exitCode = 1;
      return;
    }
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exit(error.exitCode === 0 ? 0 : 2);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
