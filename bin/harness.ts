#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { run as runDualReview } from "../workflows/dual-review.workflow.ts";
import { initHarnessConfig, resolveHarnessOptions } from "../lib/config.ts";
import { createWorkflowContext } from "../lib/workflow-context.ts";

type InitOptions = {
  workspace?: string;
  base?: string;
};

type DualReviewOptions = {
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

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
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
  run
    .command("dual-review")
    .description("Run implementation and code-quality reviewers")
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
      "per-reviewer timeout (default: 1800000)",
      positiveInteger,
      30 * 60 * 1000,
    )
    .option("--dry-run", "prepare context and prompts only", false)
    .action(async (options: DualReviewOptions) => {
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
      const meta = await runDualReview(ctx);
      console.log(JSON.stringify(meta, null, 2));
      process.exitCode = meta.verdict === "pass" || meta.status === "dry_run" ? 0 : 1;
    });

  return program;
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
