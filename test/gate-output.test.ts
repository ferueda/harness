import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { formatDuration } from "../scripts/run-gate-step.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT_PATH = join(REPO_ROOT, "scripts/run-gate-step.ts");
const tmpPaths: string[] = [];

function makeTempDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "harness-gate-test-"));
  tmpPaths.push(tmp);
  return tmp;
}

afterEach(() => {
  for (const tmpPath of tmpPaths.splice(0)) {
    rmSync(tmpPath, { recursive: true, force: true });
  }
});

function nodeCommand(script: string): string {
  return `"${process.execPath}" -e ${JSON.stringify(script)}`;
}

function runGate(options: { env?: NodeJS.ProcessEnv; unsetEnv?: string[] } = {}) {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    GATE_STEP_NAME: "test step",
    GATE_STEP_RERUN: "VERBOSE=1 make test-step",
    GATE_STEP_COMMAND: "printf 'ok\\n'",
    ...options.env,
  };

  for (const key of options.unsetEnv ?? []) {
    delete env[key];
  }

  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
}

function logPathFrom(stdout: string): string {
  const match = /^Log: (.+)$/m.exec(stdout);
  expect(match, `missing log path in output:\n${stdout}`).not.toBeNull();
  return match?.[1] ?? "";
}

test("hides command output on quiet success and prints PASS", () => {
  const result = runGate({
    env: {
      GATE_STEP_NAME: "quiet success",
      GATE_STEP_COMMAND: "printf 'hidden stdout\\n'; printf 'hidden stderr\\n' >&2",
    },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^==> quiet success$/m);
  expect(result.stdout).toMatch(/^PASS quiet success \(\d+\.\ds\)$/m);
  expect(result.stdout).not.toMatch(/hidden stdout|hidden stderr/);
  expect(result.stderr).toBe("");
});

test("keeps failed logs, preserves exit code, prints a bounded tail and rerun hint", () => {
  const logDir = makeTempDir();
  const result = runGate({
    env: {
      GATE_LOG_DIR: logDir,
      GATE_STEP_NAME: "tail failure",
      GATE_TAIL_LINES: "2",
      GATE_STEP_COMMAND: "for i in 1 2 3 4 5; do echo line-$i; done; exit 7",
    },
  });

  expect(result.status).toBe(7);
  expect(result.stdout).toMatch(/^FAIL tail failure \(\d+\.\ds\)$/m);
  expect(result.stdout).toMatch(/^Log: .+tail-failure\.log$/m);
  expect(result.stdout).toMatch(/--- last 2 lines ---\nline-4\nline-5/);
  expect(result.stdout).not.toMatch(/line-1|line-2|line-3/);
  expect(result.stdout).toMatch(/Rerun with full logs:\nVERBOSE=1 make test-step/);
  expect(readFileSync(join(logDir, "tail-failure.log"), "utf8")).toBe(
    "line-1\nline-2\nline-3\nline-4\nline-5\n",
  );
});

test("uses command text as the rerun fallback when no rerun hint is supplied", () => {
  const result = runGate({
    unsetEnv: ["GATE_STEP_RERUN"],
    env: {
      GATE_STEP_NAME: "fallback rerun",
      GATE_STEP_COMMAND: "printf 'failed\\n'; exit 8",
    },
  });

  expect(result.status).toBe(8);
  expect(result.stdout).toContain("Rerun with full logs:\nVERBOSE=1 printf 'failed\\n'; exit 8");
});

test("prints log-empty when a failing command writes nothing", () => {
  const result = runGate({
    env: {
      GATE_STEP_NAME: "empty failure",
      GATE_STEP_COMMAND: "exit 5",
    },
  });

  expect(result.status).toBe(5);
  expect(result.stdout).toMatch(/--- last 120 lines ---\n\(log empty\)/);
});

test("bounds newline-free failure tails by bytes", () => {
  const result = runGate({
    env: {
      GATE_STEP_NAME: "long line failure",
      GATE_STEP_COMMAND: nodeCommand(
        "process.stdout.write('start-marker' + 'x'.repeat(100000) + 'tail-marker'); process.exit(7);",
      ),
    },
  });

  expect(result.status).toBe(7);
  expect(result.stdout).toContain("tail-marker");
  expect(result.stdout).not.toContain("start-marker");
  expect(result.stdout.length).toBeLessThan(70_000);
});

test("sanitizes step names for custom log directories", () => {
  const logDir = makeTempDir();
  const result = runGate({
    env: {
      GATE_LOG_DIR: logDir,
      GATE_STEP_NAME: "odd step! name",
      GATE_STEP_COMMAND: "printf 'failed\\n'; exit 4",
    },
  });

  expect(result.status).toBe(4);
  expect(result.stdout).toMatch(/^Log: .+odd-step-name\.log$/m);
  expect(readFileSync(join(logDir, "odd-step-name.log"), "utf8")).toBe("failed\n");
});

test("does not leak runner-only env vars to child commands", () => {
  const result = runGate({
    env: {
      VERBOSE: "0",
      KEEP_GATE_LOGS: "1",
      GATE_STEP_NAME: "env scrub",
      GATE_STEP_COMMAND:
        'if [ -n "$VERBOSE$KEEP_GATE_LOGS$GATE_STEP_NAME$GATE_STEP_COMMAND$GATE_STEP_RERUN" ]; then exit 9; fi',
    },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/PASS env scrub/);
});

test("streams command output in verbose mode without wrapper formatting", () => {
  const result = runGate({
    env: {
      VERBOSE: "1",
      GATE_STEP_COMMAND: "printf 'verbose stdout\\n'; printf 'verbose stderr\\n' >&2",
    },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("verbose stdout");
  expect(result.stderr).toContain("verbose stderr");
  expect(result.stdout).not.toMatch(/==>|PASS|FAIL/);
  expect(result.stderr).not.toMatch(/==>|PASS|FAIL/);
});

test("preserves failing exit codes in verbose mode without wrapper formatting", () => {
  const result = runGate({
    env: {
      VERBOSE: "1",
      GATE_STEP_COMMAND: "printf 'verbose failure\\n'; exit 7",
    },
  });

  expect(result.status).toBe(7);
  expect(result.stdout).toBe("verbose failure\n");
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toMatch(/==>|PASS|FAIL/);
});

test("keeps a success log when KEEP_GATE_LOGS is set", () => {
  const logDir = makeTempDir();
  const result = runGate({
    env: {
      GATE_LOG_DIR: logDir,
      GATE_STEP_NAME: "kept success",
      KEEP_GATE_LOGS: "1",
      GATE_STEP_COMMAND: "printf 'kept\\n'",
    },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^Log: .+kept-success\.log$/m);
  expect(readFileSync(join(logDir, "kept-success.log"), "utf8")).toBe("kept\n");
});

test("prints and keeps default temporary logs when KEEP_GATE_LOGS is set", () => {
  const tmpRoot = makeTempDir();
  const result = runGate({
    env: {
      TMPDIR: tmpRoot,
      GATE_STEP_NAME: "kept default success",
      KEEP_GATE_LOGS: "1",
      GATE_STEP_COMMAND: "printf 'kept\\n'",
    },
  });

  const logPath = logPathFrom(result.stdout);
  expect(result.status).toBe(0);
  expect(logPath.startsWith(join(tmpRoot, "harness-gate-"))).toBe(true);
  expect(readFileSync(logPath, "utf8")).toBe("kept\n");
});

test("deletes successful logs by default", () => {
  const logDir = makeTempDir();
  const result = runGate({
    env: {
      GATE_LOG_DIR: logDir,
      GATE_STEP_NAME: "deleted success",
      GATE_STEP_COMMAND: "printf 'deleted\\n'",
    },
  });

  expect(result.status).toBe(0);
  expect(existsSync(join(logDir, "deleted-success.log"))).toBe(false);
});

test("deletes default temporary log directories on quiet success", () => {
  const tmpRoot = makeTempDir();
  const result = runGate({
    env: {
      TMPDIR: tmpRoot,
      GATE_STEP_NAME: "default temp cleanup",
      GATE_STEP_COMMAND: "printf 'deleted\\n'",
    },
  });

  expect(result.status).toBe(0);
  expect(readdirSync(tmpRoot).filter((entry) => entry.startsWith("harness-gate-"))).toEqual([]);
});

test("fails before running when GATE_STEP_COMMAND is missing", () => {
  const result = runGate({ unsetEnv: ["GATE_STEP_COMMAND"] });

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/GATE_STEP_COMMAND is required/);
});

test("prints spawn errors when the shell cannot start", () => {
  const logDir = makeTempDir();
  const result = runGate({
    env: {
      GATE_LOG_DIR: logDir,
      PATH: "/nonexistent",
      GATE_STEP_NAME: "spawn failure",
      GATE_STEP_COMMAND: "printf 'never runs\\n'",
    },
  });

  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/^FAIL spawn failure \(\d+\.\ds\)$/m);
  expect(result.stdout).toContain("Spawn error:");
  expect(result.stdout).toContain("Runner failed to start command:");
  expect(readFileSync(logPathFrom(result.stdout), "utf8")).toContain(
    "Runner failed to start command:",
  );
});

test("maps signal-terminated children to shell-style exit codes", () => {
  const result = runGate({
    env: {
      GATE_STEP_NAME: "signal failure",
      GATE_STEP_COMMAND: nodeCommand("setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10);"),
    },
  });

  expect(result.status).toBe(143);
  const signalLine = /^Signal: (.+)$/m.exec(result.stdout);
  if (signalLine && signalLine[1] !== "SIGTERM") {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
});

test("formats sub-minute and over-minute durations", () => {
  expect(formatDuration(1234)).toBe("1.2s");
  expect(formatDuration(65_000)).toBe("1m 05s");
});
