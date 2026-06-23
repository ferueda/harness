#!/usr/bin/env node

import { run as runDualReview } from "../workflows/dual-review.workflow.js";
import { initHarnessConfig, resolveHarnessOptions } from "../lib/config.js";
import { createWorkflowContext } from "../lib/workflow-context.js";

function printHelp() {
  console.log(`Usage:
  harness init [options]
  harness run dual-review [options]

Options:
  --workspace <path>       Target repo (default: nearest harness.json root or Git root)
  --base <ref>             Base ref (default: harness.json base or main)
  --head <ref>             Head ref (default: HEAD)
  --plan <path>            Optional plan file (relative to workspace or absolute)
  --handoff <path>         Optional handoff file
  --runs-dir <path>        Output root (default: <workspace>/.harness/runs/reviews)
  --cursor-agent <path>    cursor-agent.mjs path (auto-detected)
  --model <id>             Cursor model override
  --max-runtime-ms <n>     Per-reviewer timeout (default: 1800000)
  --dry-run                Prepare context + prompts only; do not invoke agents
  -h, --help
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    maxRuntimeMs: 30 * 60 * 1000,
    dryRun: false,
  };

  if (command === "-h" || command === "--help" || !command) {
    options.help = true;
    return options;
  }

  options.command = command;

  if (command === "init") {
    parseInitArgs(options, rest);
    return options;
  }

  if (command !== "run" || rest[0] !== "dual-review") {
    throw new Error("Expected command: harness init or harness run dual-review");
  }

  options.workflow = rest[0];
  parseRunArgs(options, rest.slice(1));
  return options;
}

function parseRunArgs(options, rest) {
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

function parseInitArgs(options, rest) {
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

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
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
      const result = initHarnessConfig(options);
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
