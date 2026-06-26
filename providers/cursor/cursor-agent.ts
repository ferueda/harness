#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LAUNCHER_COMMAND } from "./lib/command.ts";
import { buildEnvelope, buildErrorEnvelope, type EnvelopeStatus } from "./lib/envelope.ts";
import { buildHomeEnvelope } from "./lib/home.ts";
import { emitEnvelope, failUsage, finish, EXIT } from "./lib/output.ts";
import { buildCommand, runAgent } from "./lib/runner.ts";
import { loadSchema, parseStructuredOutput, wrapPrompt } from "./lib/schema.ts";

type CursorAgentOptions = {
  promptParts: string[];
  workspace: string;
  outputFormat: "json" | "stream-json" | "text";
  format: "toon" | "json";
  full: boolean;
  verbose: boolean;
  quiet: boolean;
  maxRuntimeMs: number;
  idleTimeoutMs: number;
  dryRun: boolean;
  help: boolean;
  promptFile?: string;
  readStdin?: boolean;
  model?: string;
  mode?: "plan" | "ask";
  force?: boolean;
  sandbox?: "enabled" | "disabled";
  resume?: string;
  continueSession?: boolean;
  schemaPath?: string;
  schemaJson?: string;
};

type ParsedCommand =
  | { command: "home"; options: CursorAgentOptions }
  | { command: "help"; options: CursorAgentOptions }
  | { command: "run"; options: CursorAgentOptions };

function printHelp() {
  console.log(`Usage: ${LAUNCHER_COMMAND} [options] [prompt...]
       ${LAUNCHER_COMMAND}

Headless Cursor Agent wrapper. Default stdout: TOON envelope.

Commands:
  (no args)                  Auth status + next steps

Options:
  --prompt-file <path>
  --stdin
  --workspace <path>         Default: cwd
  --model <id>
  --mode <plan|ask>
  --force
  --sandbox <enabled|disabled>
  --resume <session-id>
  --continue
  --format <toon|json>       Default: toon
  --schema <path>
  --schema-json <json>
  --full                     Untruncated result text
  --verbose                  Include usage object and workspace
  --quiet                    Suppress stdout
  --max-runtime-ms <n>       Default: 1800000
  --idle-timeout-ms <n>      Kill after n ms without output. Default: 0 (disabled)
  --dry-run
  -h, --help

Environment:
  CURSOR_CLI_EXECUTABLE
  CURSOR_API_KEY             Optional if agent login done
`);
}

function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    return { command: "home", options: baseOptions() };
  }

  const options = parseFlags(argv);
  if (options.help) {
    return { command: "help", options };
  }

  return { command: "run", options };
}

function baseOptions(): CursorAgentOptions {
  return {
    promptParts: [],
    workspace: process.cwd(),
    outputFormat: "json",
    format: "toon",
    full: false,
    verbose: false,
    quiet: false,
    maxRuntimeMs: 30 * 60 * 1000,
    idleTimeoutMs: 0,
    dryRun: false,
    help: false,
  };
}

function parseFlags(argv: string[]): CursorAgentOptions {
  const options = baseOptions();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--prompt-file":
        options.promptFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--stdin":
        options.readStdin = true;
        break;
      case "--workspace":
        options.workspace = resolve(readFlagValue(argv, index, arg));
        index += 1;
        break;
      case "--model":
        options.model = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--mode":
        {
          const mode = readFlagValue(argv, index, arg);
          if (mode !== "plan" && mode !== "ask") {
            throw new Error("Invalid --mode. Use plan or ask.");
          }
          options.mode = mode;
        }
        index += 1;
        break;
      case "--force":
      case "--yolo":
        options.force = true;
        break;
      case "--sandbox":
        {
          const sandbox = readFlagValue(argv, index, arg);
          if (sandbox !== "enabled" && sandbox !== "disabled") {
            throw new Error("Invalid --sandbox. Use enabled or disabled.");
          }
          options.sandbox = sandbox;
        }
        index += 1;
        break;
      case "--resume":
        options.resume = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--continue":
        options.continueSession = true;
        break;
      case "--output-format":
        {
          const outputFormat = readFlagValue(argv, index, arg);
          if (
            outputFormat !== "json" &&
            outputFormat !== "stream-json" &&
            outputFormat !== "text"
          ) {
            throw new Error("Invalid --output-format. Use json, stream-json, or text.");
          }
          options.outputFormat = outputFormat;
        }
        index += 1;
        break;
      case "--format":
        {
          const format = readFlagValue(argv, index, arg);
          if (format !== "toon" && format !== "json") {
            throw new Error("Invalid --format. Use toon or json.");
          }
          options.format = format;
        }
        index += 1;
        break;
      case "--schema":
        options.schemaPath = resolve(readFlagValue(argv, index, arg));
        index += 1;
        break;
      case "--schema-json":
        options.schemaJson = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--full":
        options.full = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--max-runtime-ms":
        options.maxRuntimeMs = Number(readFlagValue(argv, index, arg));
        index += 1;
        break;
      case "--idle-timeout-ms":
        options.idleTimeoutMs = Number(readFlagValue(argv, index, arg));
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        options.promptParts.push(arg);
    }
  }

  if (!Number.isFinite(options.maxRuntimeMs) || options.maxRuntimeMs <= 0) {
    throw new Error("Invalid --max-runtime-ms. Use a positive number.");
  }

  if (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs < 0) {
    throw new Error("Invalid --idle-timeout-ms. Use a non-negative number; 0 disables it.");
  }

  if (!existsSync(options.workspace)) {
    throw new Error(`Workspace does not exist: ${options.workspace}`);
  }

  if (options.schemaPath && options.schemaJson) {
    throw new Error("Use only one of --schema or --schema-json.");
  }

  return options;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function readPrompt(options: CursorAgentOptions): Promise<string> {
  const chunks: string[] = [];
  if (options.promptFile) chunks.push(readFileSync(options.promptFile, "utf8"));
  if (options.promptParts?.length) chunks.push(options.promptParts.join(" "));
  if (options.readStdin) {
    const stdin = await new Promise<string>((resolveStdin, rejectStdin) => {
      const parts: string[] = [];
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (part) => parts.push(String(part)));
      process.stdin.on("end", () => resolveStdin(parts.join("")));
      process.stdin.on("error", rejectStdin);
    });
    chunks.push(stdin);
  }
  const prompt = chunks.join("\n\n").trim();
  if (!prompt) {
    throw new Error("prompt is required");
  }
  return prompt;
}

async function runInvoke(options: CursorAgentOptions): Promise<void> {
  let schema;
  try {
    schema = loadSchema(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finish(buildErrorEnvelope(`Invalid schema: ${message}`), options.format, options.quiet);
    return;
  }

  let prompt;
  try {
    prompt = wrapPrompt(await readPrompt(options), schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failUsage(
      message,
      [`Run \`${LAUNCHER_COMMAND} "your task"\` or --prompt-file / --stdin`],
      options.format,
    );
    return;
  }

  const command = buildCommand(options, prompt);

  if (options.dryRun) {
    emitEnvelope(
      {
        status: "completed",
        dryRun: {
          executable: command.executable,
          args: command.args.slice(0, -1),
          workspace: options.workspace,
        },
      },
      options.format,
      options.quiet,
    );
    process.exit(EXIT.OK);
  }

  const started = Date.now();
  let result;
  try {
    result = await runAgent(command, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finish(
      buildErrorEnvelope(`Failed to start Cursor CLI: ${message}`, [
        "Verify `agent` is on PATH",
        "Run `agent login` or set CURSOR_API_KEY",
      ]),
      options.format,
      options.quiet,
    );
    return;
  }

  const structured = schema ? parseStructuredOutput(result.resultText, schema) : undefined;

  let status: EnvelopeStatus = "completed";
  if (result.timedOut) status = "timed_out";
  else if (result.exitCode !== 0 || result.isError || structured?.error) status = "failed";

  const envelope = buildEnvelope({
    status,
    sessionId: result.sessionId,
    resultText: result.resultText,
    structuredOutput: structured?.value,
    structuredError: structured?.error,
    usage: result.usage,
    durationMs: Date.now() - started,
    workspace: options.workspace,
    full: options.full,
    verbose: options.verbose,
    schema,
    timeoutKind: result.timeoutKind,
  });

  if (status === "failed" && !envelope.error) {
    envelope.error =
      structured?.error ??
      (result.stderr.trim() || `Cursor agent exited with code ${result.exitCode ?? 1}`);
    envelope.help = envelope.help ?? [];
    if (result.stderr.trim()) {
      envelope.help.unshift("See Cursor CLI stderr in your terminal logs");
    }
  }

  finish(envelope, options.format, options.quiet);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failUsage(message, [`Run \`${LAUNCHER_COMMAND} --help\` for usage`]);
    return;
  }

  const { command, options } = parsed;

  if (command === "help") {
    printHelp();
    return;
  }

  if (command === "home") {
    const home = await buildHomeEnvelope(options.workspace);
    emitEnvelope(home, options.format, false);
    return;
  }

  await runInvoke(options);
}

main().catch((error) => {
  const envelope = buildErrorEnvelope(error instanceof Error ? error.message : String(error));
  emitEnvelope(envelope, "toon", false);
  process.exit(EXIT.ERROR);
});
