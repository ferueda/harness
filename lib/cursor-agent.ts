import { spawnSync } from "node:child_process";

export function invokeCursorAgent({
  cursorAgentPath,
  workspace,
  promptPath,
  schemaPath,
  model,
  maxRuntimeMs,
}) {
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

  let envelope;
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

  return {
    ok: true,
    review: envelope.structuredOutput,
    envelope,
    exitCode: 0,
  };
}
