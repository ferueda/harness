import { spawn } from "node:child_process";
import type { Agent, AgentRunInput, AgentRunResult } from "./agents.ts";

type CursorAgentEnvelope = {
  status?: unknown;
  structuredOutput?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  usage?: unknown;
  error?: unknown;
  structuredError?: unknown;
  [key: string]: unknown;
};

export function createCursorAgent(options: { cursorAgentPath: string }): Agent {
  return {
    name: "cursor",
    run(input) {
      return invokeCursorAgent(options.cursorAgentPath, input);
    },
  };
}

function invokeCursorAgent(
  cursorAgentPath: string,
  { workspace, prompt, schemaPath, model, maxRuntimeMs }: AgentRunInput,
): Promise<AgentRunResult> {
  const args = [
    cursorAgentPath,
    "--format",
    "json",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--workspace",
    workspace,
    "--stdin",
    "--max-runtime-ms",
    String(maxRuntimeMs),
  ];
  if (schemaPath) args.push("--schema", schemaPath);
  if (model) args.push("--model", model);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const settle = (result: AgentRunResult, killChild = false): void => {
      if (settled) return;
      settled = true;
      if (killChild && child.exitCode === null && !child.killed) {
        child.kill();
      }
      resolve(result);
    };
    const settleSpawnFailure = (message: string): void => {
      settle(
        {
          ok: false,
          error: message,
          exitCode: 1,
          stderr: stderr.join(""),
        },
        true,
      );
    };

    child.stdin.on("error", (error) => {
      settleSpawnFailure(error.message);
    });
    child.stdin.setDefaultEncoding("utf8");
    child.stdin.end(prompt);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", (error) => {
      settleSpawnFailure(error.message);
    });
    child.on("close", (code) => {
      settle(parseCursorAgentOutput(stdout.join(""), stderr.join(""), code ?? 1));
    });
  });
}

function parseCursorAgentOutput(stdout: string, stderr: string, exitCode: number): AgentRunResult {
  let envelope: CursorAgentEnvelope;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      error: `Invalid cursor-agent JSON output: ${stdout.slice(0, 500)}`,
      exitCode,
      stderr,
    };
  }

  if (envelope.status !== "completed") {
    return {
      ok: false,
      error:
        optionalString(envelope.error) ??
        optionalString(envelope.structuredError) ??
        "Agent failed",
      raw: envelope,
      exitCode,
      stderr,
    };
  }

  return {
    ok: true,
    structuredOutput: envelope.structuredOutput,
    raw: envelope,
    sessionId: optionalString(envelope.sessionId) ?? optionalString(envelope.session_id),
    usage: envelope.usage,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
