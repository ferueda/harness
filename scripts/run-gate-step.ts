#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns, StdioOptions } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_TAIL_LINES = 120;
const MAX_TAIL_BYTES = 64 * 1024;

type LogPath = {
  logDir: string;
  logPath: string;
  ownsLogDir: boolean;
};

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }

  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function sanitizeStepName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-") || "gate-step";
}

function parseTailLines(value: string | undefined): number {
  if (!value) return DEFAULT_TAIL_LINES;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TAIL_LINES;
}

function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (key === "VERBOSE" || key === "KEEP_GATE_LOGS" || key.startsWith("GATE_")) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

function createLogPath(env: NodeJS.ProcessEnv, stepName: string): LogPath {
  let createdLogDir = false;
  const logDir = env.GATE_LOG_DIR
    ? resolve(env.GATE_LOG_DIR)
    : mkdtempSync(join(tmpdir(), "harness-gate-"));
  if (env.GATE_LOG_DIR) {
    createdLogDir = Boolean(mkdirSync(logDir, { recursive: true, mode: 0o700 }));
  } else {
    createdLogDir = true;
  }

  if (createdLogDir) {
    // Tighten only directories created by this runner; caller-owned dirs keep caller permissions.
    try {
      chmodSync(logDir, 0o700);
    } catch {
      // Best effort for filesystems without POSIX chmod semantics.
    }
  }

  return {
    logDir,
    logPath: join(logDir, `${sanitizeStepName(stepName)}.log`),
    ownsLogDir: !env.GATE_LOG_DIR,
  };
}

function exitStatus(result: SpawnSyncReturns<Buffer>): number {
  if (typeof result.status === "number") return result.status;
  if (result.signal) {
    const signalNumber = constants.signals[result.signal];
    if (Number.isInteger(signalNumber)) return 128 + signalNumber;
  }
  return 1;
}

function runShellCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  stdio: StdioOptions,
): SpawnSyncReturns<Buffer> {
  return spawnSync("sh", ["-c", command], {
    cwd: REPO_ROOT,
    env: childEnvironment(env),
    stdio,
  });
}

function tailLog(logPath: string, lineCount: number): string {
  const fd = openSync(logPath, "r");
  const chunks: Buffer[] = [];
  let position = fstatSync(fd).size;
  let newlineCount = 0;
  let bytesCollected = 0;

  try {
    // Read one chunk past the requested line count so slice(-lineCount) has context.
    while (position > 0 && newlineCount <= lineCount && bytesCollected < MAX_TAIL_BYTES) {
      const remainingBytes = MAX_TAIL_BYTES - bytesCollected;
      const readSize = Math.min(position, remainingBytes);
      position -= readSize;

      const buffer = Buffer.allocUnsafe(readSize);
      const bytesRead = readSync(fd, buffer, 0, readSize, position);
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      bytesCollected += bytesRead;

      newlineCount += chunk.filter((byte) => byte === 0x0a).length;
    }
  } finally {
    closeSync(fd);
  }

  const contents = Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n");
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return "(log empty)";
  return lines.slice(-lineCount).join("\n");
}

function printFailure(input: {
  elapsed: string;
  logPath: string;
  rerun: string;
  result: SpawnSyncReturns<Buffer>;
  stepName: string;
  tailLines: number;
}): void {
  console.log(`FAIL ${input.stepName} (${input.elapsed})`);
  if (input.result.signal) {
    console.log(`Signal: ${input.result.signal}`);
  }
  if (input.result.error) {
    console.log(`Spawn error: ${input.result.error.message}`);
  }
  console.log(`Log: ${input.logPath}`);
  console.log("");
  console.log(`--- last ${input.tailLines} lines ---`);
  console.log(tailLog(input.logPath, input.tailLines));
  console.log("");
  console.log("Rerun with full logs:");
  console.log(input.rerun);
}

function runGateStep(env: NodeJS.ProcessEnv = process.env): number {
  const command = env.GATE_STEP_COMMAND;
  if (!command) {
    console.error("GATE_STEP_COMMAND is required.");
    return 2;
  }

  if (env.VERBOSE === "1") {
    return exitStatus(runShellCommand(command, env, "inherit"));
  }

  const stepName = env.GATE_STEP_NAME || "gate-step";
  const rerun = env.GATE_STEP_RERUN || `VERBOSE=1 ${command}`;
  const tailLines = parseTailLines(env.GATE_TAIL_LINES);
  const { logDir, logPath, ownsLogDir } = createLogPath(env, stepName);
  const startedAt = Date.now();

  console.log(`==> ${stepName}`);

  const logFd = openSync(logPath, "w", 0o600);
  let result: SpawnSyncReturns<Buffer>;
  try {
    result = runShellCommand(command, env, ["ignore", logFd, logFd]);
  } finally {
    closeSync(logFd);
  }

  if (result.error) {
    appendFileSync(logPath, `Runner failed to start command: ${result.error.message}\n`);
  }

  const elapsed = formatDuration(Date.now() - startedAt);
  const status = exitStatus(result);
  if (status === 0) {
    console.log(`PASS ${stepName} (${elapsed})`);
    if (env.KEEP_GATE_LOGS === "1") {
      console.log(`Log: ${logPath}`);
    } else {
      if (ownsLogDir) {
        rmSync(logDir, { recursive: true, force: true });
      } else {
        rmSync(logPath, { force: true });
      }
    }
    return 0;
  }

  printFailure({ elapsed, logPath, rerun, result, stepName, tailLines });
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exit(runGateStep());
}
