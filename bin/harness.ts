#!/usr/bin/env node

import { run as runDualReview } from "../workflows/dual-review.workflow.ts";
import { initHarnessConfig, resolveHarnessOptions } from "../lib/config.ts";
import { createWorkflowContext } from "../lib/workflow-context.ts";

type HarnessCliOptions = {
  command?: "init" | "run";
  workflow?: "dual-review";
  workspace?: string;
  baseRef?: string;
  headRef?: string;
  planPath?: string;
  handoffPath?: string;
  runsDir?: string;
  cursorAgentPath?: string;
  model?: string;
  maxRuntimeMs: number;
  dryRun: boolean;
  help?: boolean;
};

function printHelp() {
  console.log(`Usage:
  harness init [options]
  harness run dual-review [options]

Init options:
  --workspace <path>       Target repo (default: nearest harness.json root or Git root)
  --base <ref>             Base ref for new harness.json (default: main)

Run options:
  --workspace <path>       Target repo (default: nearest harness.json root or Git root)
  --base <ref>             Base ref (default: harness.json base or main)
  --head <ref>             Head ref (default: HEAD)
  --plan <path>            Optional plan file (relative to workspace or absolute)
  --handoff <path>         Optional handoff file
  --runs-dir <path>        Output root (default: <workspace>/.harness/runs/reviews)
  --cursor-agent <path>    cursor-agent.ts path (auto-detected)
  --model <id>             Cursor model override
  --max-runtime-ms <n>     Per-reviewer timeout (default: 1800000)
  --dry-run                Prepare context + prompts only; do not invoke agents

Global:
  -h, --help
`);
}

function parseArgs(argv: string[]): HarnessCliOptions {
  const [command, ...rest] = argv;
  const options: HarnessCliOptions = {
    maxRuntimeMs: 30 * 60 * 1000,
    dryRun: false,
  };

  if (command === "-h" || command === "--help" || !command) {
    options.help = true;
    return options;
  }

  if (command === "init") {
    options.command = command;
    parseInitArgs(options, rest);
    return options;
  }

  if (command !== "run" || rest[0] !== "dual-review") {
    throw new Error("Expected command: harness init or harness run dual-review");
  }

  options.command = command;
  options.workflow = rest[0];
  parseRunArgs(options, rest.slice(1));
  return options;
}

function parseRunArgs(options: HarnessCliOptions, rest: string[]): void {
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--workspace":
        options.workspace = readValue(rest, index, arg);
        index += 1;
        break;
      case "--base":
        options.baseRef = readValue(rest, index, arg);
        index += 1;
        break;
      case "--head":
        options.headRef = readValue(rest, index, arg);
        index += 1;
        break;
      case "--plan":
        options.planPath = readValue(rest, index, arg);
        index += 1;
        break;
      case "--handoff":
        options.handoffPath = readValue(rest, index, arg);
        index += 1;
        break;
      case "--runs-dir":
        options.runsDir = readValue(rest, index, arg);
        index += 1;
        break;
      case "--cursor-agent":
        options.cursorAgentPath = readValue(rest, index, arg);
        index += 1;
        break;
      case "--model":
        options.model = readValue(rest, index, arg);
        index += 1;
        break;
      case "--max-runtime-ms":
        options.maxRuntimeMs = Number(readValue(rest, index, arg));
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(options.maxRuntimeMs) || options.maxRuntimeMs <= 0) {
    throw new Error("Invalid --max-runtime-ms");
  }
}

function parseInitArgs(options: HarnessCliOptions, rest: string[]): void {
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--workspace":
        options.workspace = readValue(rest, index, arg);
        index += 1;
        break;
      case "--base":
        options.baseRef = readValue(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-") || value.trim() === "") {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelp();
    process.exit(2);
  }

  if (options.help) {
    printHelp();
    return;
  }

  try {
    if (options.command === "init") {
      const result = initHarnessConfig({
        workspace: options.workspace,
        baseRef: options.baseRef,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const ctx = createWorkflowContext(resolveHarnessOptions(options));
    const meta = await runDualReview(ctx);
    console.log(JSON.stringify(meta, null, 2));
    process.exit(meta.verdict === "pass" || meta.status === "dry_run" ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

await main();
