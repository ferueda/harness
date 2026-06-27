import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { resolveExecutable, runAgent } from "./lib/runner.ts";
import { parseStructuredOutput, type JsonSchema } from "./lib/schema.ts";
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "cursor-agent.ts");
const REVIEW_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../schemas/review-output.schema.json",
);
function runCli(args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}
test("dry-run emits the Cursor command without leaking the prompt", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-workspace-"));
  const output = execFileSync(
    process.execPath,
    [SCRIPT_PATH, "--format", "json", "--dry-run", "--workspace", workspace, "inspect secrets"],
    { encoding: "utf8" },
  );
  const envelope = JSON.parse(output);
  expect(envelope.status).toBe("completed");
  expect(envelope.dryRun.executable).toMatch(/(^|\/)agent$/);
  expect(envelope.dryRun.workspace).toBe(workspace);
  expect(envelope.dryRun.args).toEqual([
    "-p",
    "--output-format",
    "json",
    "--workspace",
    workspace,
    "--trust",
    "--approve-mcps",
  ]);
});
test("missing flag values fail as usage errors", () => {
  const result = runCli(["--workspace"]);
  expect(result.status).toBe(2);
  expect(result.stdout).toMatch(/Missing value for --workspace/);
  expect(result.stdout).toMatch(/harness-cursor --help/);
  expect(result.stdout).not.toMatch(/`cursor-agent/);
});
test("invalid enum flags fail before invoking Cursor", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-workspace-"));
  const result = runCli(["--workspace", workspace, "--mode", "edit", "task"]);
  expect(result.status).toBe(2);
  expect(result.stdout).toMatch(/Invalid --mode/);
});
test("help names the harness-cursor launcher", () => {
  const result = runCli(["--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Usage: harness-cursor/);
  expect(result.stdout).toMatch(/--full/);
  expect(result.stdout).not.toMatch(/Usage: .*cursor-agent/);
});
test("resolveExecutable does not discover harness-cursor launcher as Cursor CLI", () => {
  const binDir = mkdtempSync(join(tmpdir(), "harness-cursor-bin-"));
  const homeDir = mkdtempSync(join(tmpdir(), "harness-cursor-home-"));
  const launcher = join(binDir, "harness-cursor");
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o755);
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalOverride = process.env.CURSOR_CLI_EXECUTABLE;
  process.env.PATH = binDir;
  process.env.HOME = homeDir;
  delete process.env.CURSOR_CLI_EXECUTABLE;
  try {
    expect(resolveExecutable()).toBe("agent");
  } finally {
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
    if (originalOverride === undefined) delete process.env.CURSOR_CLI_EXECUTABLE;
    else process.env.CURSOR_CLI_EXECUTABLE = originalOverride;
  }
});
test("resolveExecutable falls back to the Cursor installer local agent path", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "harness-cursor-home-"));
  const localBin = join(homeDir, ".local/bin");
  mkdirSync(localBin, { recursive: true });
  const localAgent = join(localBin, "agent");
  writeFileSync(localAgent, "#!/bin/sh\nexit 0\n");
  chmodSync(localAgent, 0o755);
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalOverride = process.env.CURSOR_CLI_EXECUTABLE;
  process.env.PATH = "";
  process.env.HOME = homeDir;
  delete process.env.CURSOR_CLI_EXECUTABLE;
  try {
    expect(resolveExecutable()).toBe(localAgent);
  } finally {
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
    if (originalOverride === undefined) delete process.env.CURSOR_CLI_EXECUTABLE;
    else process.env.CURSOR_CLI_EXECUTABLE = originalOverride;
  }
});
test("fake Cursor stream output becomes a successful envelope", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-workspace-"));
  const fakeAgent = join(workspace, "agent");
  writeFileSync(
    fakeAgent,
    [
      "#!/bin/sh",
      "printf '%s\\n' '{\"session_id\":\"abc\"}'",
      'printf \'%s\\n\' \'{"type":"result","result":"done","session_id":"abc","is_error":false,"usage":{"input_tokens":1234,"output_tokens":5}}\'',
      "",
    ].join("\n"),
  );
  chmodSync(fakeAgent, 0o755);
  const result = runCli(
    ["--format", "json", "--output-format", "stream-json", "--workspace", workspace, "say done"],
    { env: { CURSOR_CLI_EXECUTABLE: fakeAgent } },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  expect(result.status).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.status).toBe("completed");
  expect(envelope.sessionId).toBe("abc");
  expect(envelope.result).toBe("done");
  expect(envelope.usageSummary).toBe("1k in, 5 out");
});
test("disabled idle timeout allows silent Cursor work until max runtime", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-workspace-"));
  const fakeAgent = join(workspace, "agent");
  writeFileSync(
    fakeAgent,
    [
      "#!/bin/sh",
      "sleep 0.1",
      'printf \'%s\\n\' \'{"type":"result","result":"done","is_error":false}\'',
      "",
    ].join("\n"),
  );
  chmodSync(fakeAgent, 0o755);
  const result = await runAgent(
    { executable: fakeAgent, args: [] },
    { workspace, outputFormat: "stream-json", maxRuntimeMs: 1000, idleTimeoutMs: 0 },
  );
  expect(result.timedOut).toBe(false);
  expect(result.timeoutKind).toBe(undefined);
  expect(result.resultText).toBe("done");
});
test("explicit idle timeout still kills silent Cursor work", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-workspace-"));
  const fakeAgent = join(workspace, "agent");
  writeFileSync(
    fakeAgent,
    [
      "#!/bin/sh",
      "sleep 1",
      'printf \'%s\\n\' \'{"type":"result","result":"done","is_error":false}\'',
      "",
    ].join("\n"),
  );
  chmodSync(fakeAgent, 0o755);
  const result = await runAgent(
    { executable: fakeAgent, args: [] },
    { workspace, outputFormat: "stream-json", maxRuntimeMs: 1000, idleTimeoutMs: 20 },
  );
  expect(result.timedOut).toBe(true);
  expect(result.timeoutKind).toBe("idle");
});
test("structured output parser extracts and validates JSON", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["verdict"],
    properties: {
      verdict: { enum: ["pass", "fail"] },
    },
  };
  expect(parseStructuredOutput('```json\n{"verdict":"pass"}\n```', schema)).toEqual({
    value: { verdict: "pass" },
  });
  expect(parseStructuredOutput('{"verdict":"maybe"}', schema).error).toMatch(/expected one of/);
});

test("structured output parser rejects unexpected properties when schema is strict", () => {
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "findings"],
    properties: {
      verdict: { enum: ["pass", "needs_changes"] },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: { type: "string" },
          },
        },
      },
    },
  };

  expect(
    parseStructuredOutput('{"verdict":"pass","findings":[{"title":"ok","extra":"nope"}]}', schema)
      .error,
  ).toMatch(/unexpected property "extra"/);
});

test("stream-json envelope parses prose-prefixed review JSON with findings", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-workspace-"));
  const fakeAgent = join(workspace, "agent");
  const reviewPayload = {
    verdict: "pass",
    summary: "looks good",
    findings: [
      {
        title: "style nit",
        severity: "Low",
        location: "schema.ts",
        issue: "minor",
        recommendation: "optional cleanup",
        rationale: "readability",
        must_fix: false,
      },
    ],
  };
  const resultText = `Review complete.\n\n${JSON.stringify(reviewPayload)}`;
  const escapedResult = JSON.stringify(resultText);
  writeFileSync(
    fakeAgent,
    [
      "#!/bin/sh",
      "printf '%s\\n' '{\"session_id\":\"review-abc\"}'",
      `printf '%s\\n' '{"type":"result","result":${escapedResult},"session_id":"review-abc","is_error":false}'`,
      "",
    ].join("\n"),
  );
  chmodSync(fakeAgent, 0o755);
  const result = runCli(
    [
      "--format",
      "json",
      "--output-format",
      "stream-json",
      "--workspace",
      workspace,
      "--schema",
      REVIEW_SCHEMA_PATH,
      "review changes",
    ],
    { env: { CURSOR_CLI_EXECUTABLE: fakeAgent } },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.status).toBe("completed");
  expect(envelope.structuredOutput).toEqual(reviewPayload);
});
