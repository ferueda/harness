import { spawn } from "node:child_process";
import { ReviewOutputSchema, formatZodError, type ReviewOutput } from "./schemas.ts";

type CursorAgentResult =
  | {
      ok: true;
      review: ReviewOutput;
      envelope: CursorAgentEnvelope;
      exitCode: 0;
    }
  | {
      ok: false;
      error: string;
      envelope?: CursorAgentEnvelope;
      exitCode: number;
      stderr?: string;
    };

type CursorAgentEnvelope = {
  status?: unknown;
  structuredOutput?: unknown;
  error?: unknown;
  structuredError?: unknown;
  [key: string]: unknown;
};

export function invokeCursorAgent({
  cursorAgentPath,
  workspace,
  promptPath,
  schemaPath,
  model,
  maxRuntimeMs,
}: {
  cursorAgentPath: string;
  workspace: string;
  promptPath: string;
  schemaPath: string;
  model?: string;
  maxRuntimeMs: number;
}): Promise<CursorAgentResult> {
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
    "--schema",
    schemaPath,
    "--prompt-file",
    promptPath,
    "--max-runtime-ms",
    String(maxRuntimeMs),
  ];
  if (model) args.push("--model", model);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const settle = (result: CursorAgentResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", (error) => {
      settle({
        ok: false,
        error: error.message,
        exitCode: 1,
        stderr: stderr.join(""),
      });
    });
    child.on("close", (code) => {
      settle(parseCursorAgentOutput(stdout.join(""), stderr.join(""), code ?? 1));
    });
  });
}

function parseCursorAgentOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
): CursorAgentResult {
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

  if (envelope.status !== "completed" || !envelope.structuredOutput) {
    return {
      ok: false,
      error:
        optionalString(envelope.error) ??
        optionalString(envelope.structuredError) ??
        "Reviewer failed",
      envelope,
      exitCode,
      stderr,
    };
  }

  const review = ReviewOutputSchema.safeParse(envelope.structuredOutput);
  if (!review.success) {
    return {
      ok: false,
      error: `Invalid reviewer structured output: ${formatZodError(review.error)}`,
      envelope,
      exitCode,
      stderr,
    };
  }

  return {
    ok: true,
    review: review.data,
    envelope,
    exitCode: 0,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
