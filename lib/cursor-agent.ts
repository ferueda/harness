import { spawnSync } from "node:child_process";
import { ReviewOutputSchema, formatZodError, type ReviewOutput } from "./schemas.ts";

type CursorAgentResult =
  | {
      ok: true;
      review: ReviewOutput;
      envelope: Record<string, any>;
      exitCode: 0;
    }
  | {
      ok: false;
      error: string;
      envelope?: Record<string, any>;
      exitCode: number;
      stderr?: string;
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
}): CursorAgentResult {
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

  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: process.env,
  });

  let envelope: Record<string, any>;
  try {
    envelope = JSON.parse(result.stdout.trim());
  } catch {
    return {
      ok: false,
      error: `Invalid cursor-agent JSON output: ${result.stdout.slice(0, 500)}`,
      exitCode: result.status ?? 1,
      stderr: result.stderr,
    };
  }

  if (envelope.status !== "completed" || !envelope.structuredOutput) {
    return {
      ok: false,
      error: envelope.error ?? envelope.structuredError ?? "Reviewer failed",
      envelope,
      exitCode: result.status ?? 1,
      stderr: result.stderr,
    };
  }

  const review = ReviewOutputSchema.safeParse(envelope.structuredOutput);
  if (!review.success) {
    return {
      ok: false,
      error: `Invalid reviewer structured output: ${formatZodError(review.error)}`,
      envelope,
      exitCode: result.status ?? 1,
      stderr: result.stderr,
    };
  }

  return {
    ok: true,
    review: review.data,
    envelope,
    exitCode: 0,
  };
}
