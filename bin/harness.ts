#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { resolve } from "node:path";
import { run as runReviewFull } from "../workflows/review-full.workflow.ts";
import { run as runReview } from "../workflows/review.workflow.ts";
import { initHarnessConfig, resolveHarnessOptions } from "../lib/config.ts";
import { parseRetentionDuration, pruneRuns } from "../lib/runs.ts";
import { createWorkflowContext } from "../lib/workflow-context.ts";

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
  runsDir?: string;
  cursorAgent?: string;
  model?: string;
  maxRuntimeMs: number;
  dryRun: boolean;
};

type RunsPruneOptions = {
  workspace?: string;
  runsDir?: string;
  olderThan: number;
  dryRun: boolean;
};

const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive number");
  }
  return parsed;
}

function buildProgram(): Command {
  const program = new Command();
  program.name("harness").description("Agent workflow harness").showHelpAfterError().exitOverride();
  program.action(() => {
    program.outputHelp();
    process.exitCode = 1;
  });

  program
    .command("init")
    .description("Create harness.json and ignore harness artifacts")
    .option("--workspace <path>", "target repo (default: nearest harness.json or Git root)")
    .option("--base <ref>", "base ref for new harness.json (default: main)")
    .action((options: InitOptions) => {
      const result = initHarnessConfig({
        workspace: options.workspace,
        baseRef: options.base,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  const run = program.command("run").description("Run a harness workflow");
  addReviewCommand(run, {
    name: "review",
    description: "Run implementation and code-quality reviewers",
    workflow: runReview,
  });
  addReviewCommand(run, {
    name: "review-full",
    description: "Run implementation, code-quality, and simplify reviewers",
    workflow: runReviewFull,
  });

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

  return program;
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
    workflow: typeof runReview;
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
    .option("--runs-dir <path>", "output root (default: <workspace>/.harness/runs/reviews)")
    .option("--cursor-agent <path>", "cursor-agent entrypoint (auto-detected)")
    .option("--model <id>", "Cursor model override")
    .option(
      "--max-runtime-ms <ms>",
      `per-reviewer timeout (default: ${DEFAULT_MAX_RUNTIME_MS})`,
      positiveNumber,
      DEFAULT_MAX_RUNTIME_MS,
    )
    .option("--dry-run", "prepare context and prompts only", false)
    .action(async (options: ReviewOptions) => {
      const ctx = createWorkflowContext(
        resolveHarnessOptions({
          workspace: options.workspace,
          baseRef: options.base,
          headRef: options.head,
          planPath: options.plan,
          handoffPath: options.handoff,
          runsDir: options.runsDir,
          cursorAgentPath: options.cursorAgent,
          model: options.model,
          maxRuntimeMs: options.maxRuntimeMs,
          dryRun: options.dryRun,
        }),
      );
      const meta = await workflow(ctx);
      console.log(JSON.stringify(meta, null, 2));
      process.exitCode = meta.verdict === "pass" || meta.status === "dry_run" ? 0 : 1;
    });
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exit(error.exitCode === 0 ? 0 : 2);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

await main();
