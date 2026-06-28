import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const EXECUTABLE_CANDIDATES = ["agent"];

type AgentOutputFormat = "json" | "stream-json" | "text";

type AgentEvent = {
  type?: string;
  result?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  usage?: unknown;
};

export type AgentCommand = {
  executable: string;
  args: string[];
};

export type AgentRunOptions = {
  workspace: string;
  outputFormat: AgentOutputFormat;
  maxRuntimeMs: number;
  idleTimeoutMs: number;
};

export function executableOnPath(name: string): boolean {
  const pathEntries = (process.env.PATH ?? "").split(":");
  return pathEntries.some((entry) => existsSync(resolve(entry, name)));
}

export function resolveExecutable(): string {
  const override = process.env.CURSOR_CLI_EXECUTABLE?.trim();
  if (override) return override;

  for (const candidate of EXECUTABLE_CANDIDATES) {
    if (executableOnPath(candidate)) return candidate;
  }

  const localAgent = process.env.HOME ? join(process.env.HOME, ".local/bin/agent") : undefined;
  if (localAgent && existsSync(localAgent)) return localAgent;

  return "agent";
}

export function agentJson(
  args: string[],
  workspace = process.cwd(),
): {
  data?: Record<string, unknown>;
  error?: string;
  exitCode?: number;
} {
  const executable = resolveExecutable();
  const result = spawnSync(executable, args, {
    cwd: workspace,
    env: process.env,
    encoding: "utf8",
    timeout: 15_000,
  });

  if (result.error) {
    return { error: result.error.message };
  }

  const stdout = result.stdout?.trim() ?? "";
  if (!stdout) {
    return {
      error: result.stderr?.trim() || `agent ${args.join(" ")} returned no output`,
      exitCode: result.status ?? 1,
    };
  }

  try {
    return { data: JSON.parse(stdout), exitCode: result.status ?? 0 };
  } catch {
    return { data: { text: stdout }, exitCode: result.status ?? 0 };
  }
}

function parseAgentOutput(
  stdout: string,
  outputFormat: AgentOutputFormat,
): {
  resultText?: string;
  sessionId?: string;
  isError: boolean;
  usage?: unknown;
} {
  if (outputFormat === "text") {
    return {
      resultText: stdout.trim(),
      sessionId: undefined,
      isError: false,
      usage: undefined,
    };
  }

  if (outputFormat === "json") {
    const trimmed = stdout.trim();
    try {
      return terminalFromEvent(JSON.parse(trimmed));
    } catch {
      return {
        resultText: trimmed || undefined,
        sessionId: undefined,
        isError: true,
        usage: undefined,
      };
    }
  }

  let sessionId;
  let resultText;
  let isError = false;
  let usage;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: AgentEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (event.type === "result") {
      const terminal = terminalFromEvent(event);
      resultText = terminal.resultText;
      isError = terminal.isError;
      usage = terminal.usage;
      if (terminal.sessionId) sessionId = terminal.sessionId;
    }
  }

  return { resultText, sessionId, isError, usage };
}

function terminalFromEvent(event: AgentEvent): {
  resultText?: string;
  sessionId?: string;
  isError: boolean;
  usage?: unknown;
} {
  return {
    resultText: typeof event.result === "string" ? event.result : undefined,
    sessionId: typeof event.session_id === "string" ? event.session_id : undefined,
    isError: event.is_error === true,
    usage: event.usage,
  };
}

export function buildCommand(
  options: {
    outputFormat: AgentOutputFormat;
    workspace: string;
    force?: boolean;
    model?: string;
    mode?: "plan" | "ask";
    sandbox?: "enabled" | "disabled";
    resume?: string;
    continueSession?: boolean;
  },
  prompt: string,
): AgentCommand {
  const executable = resolveExecutable();
  const args = [
    "-p",
    "--output-format",
    options.outputFormat,
    "--workspace",
    options.workspace,
    "--trust",
    "--approve-mcps",
  ];

  if (options.force) args.push("--force");
  if (options.model) args.push("--model", options.model);
  if (options.mode) args.push("--mode", options.mode);
  if (options.sandbox) args.push("--sandbox", options.sandbox);
  if (options.resume) args.push("--resume", options.resume);
  if (options.continueSession) args.push("--continue");
  args.push(prompt);

  return { executable, args };
}

export async function runAgent(
  command: AgentCommand,
  options: AgentRunOptions,
): Promise<{
  exitCode: number;
  stderr: string;
  timedOut: boolean;
  timeoutKind?: "max_runtime" | "idle";
  resultText?: string;
  sessionId?: string;
  isError: boolean;
  usage?: unknown;
}> {
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let timedOut = false;
  let timeoutKind: "max_runtime" | "idle" | undefined;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const subprocess = spawn(command.executable, command.args, {
    cwd: options.workspace,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const recordActivity = () => {
    lastActivityAt = Date.now();
  };

  subprocess.stdout?.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
    recordActivity();
  });
  subprocess.stderr?.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
    recordActivity();
  });

  const hasIdleTimeout = options.idleTimeoutMs > 0;
  const checkIntervalMs = Math.max(
    1,
    Math.min(
      1_000,
      hasIdleTimeout ? options.idleTimeoutMs : options.maxRuntimeMs,
      options.maxRuntimeMs,
    ),
  );

  const timer = setInterval(() => {
    if (timedOut) return;
    const now = Date.now();
    const exceededMaxRuntime = now - startedAt >= options.maxRuntimeMs;
    const exceededIdleTimeout = hasIdleTimeout && now - lastActivityAt >= options.idleTimeoutMs;
    if (!exceededMaxRuntime && !exceededIdleTimeout) return;
    timedOut = true;
    timeoutKind = exceededMaxRuntime ? "max_runtime" : "idle";
    subprocess.kill("SIGTERM");
    setTimeout(() => subprocess.kill("SIGKILL"), 5_000);
  }, checkIntervalMs);

  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    subprocess.once("error", rejectExit);
    subprocess.once("close", (code) => resolveExit(code ?? 1));
  }).finally(() => {
    clearInterval(timer);
  });

  const terminal = parseAgentOutput(stdoutChunks.join(""), options.outputFormat);

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    timedOut,
    timeoutKind,
    ...terminal,
  };
}
