import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveExecutable, runAgent } from "./lib/runner.mjs";
import { parseStructuredOutput } from "./lib/schema.mjs";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "cursor-agent.mjs");

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

test("dry-run emits the Cursor command without leaking the prompt", () => {
  const workspace = mkdtempSync(join(tmpdir(), "cursor-agent-workspace-"));
  const output = execFileSync(
    process.execPath,
    [
      SCRIPT_PATH,
      "--format",
      "json",
      "--dry-run",
      "--workspace",
      workspace,
      "inspect secrets",
    ],
    { encoding: "utf8" },
  );

  const envelope = JSON.parse(output);
  assert.equal(envelope.status, "completed");
  assert.match(envelope.dryRun.executable, /(^|\/)agent$/);
  assert.equal(envelope.dryRun.workspace, workspace);
  assert.deepEqual(envelope.dryRun.args, [
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

  assert.equal(result.status, 2);
  assert.match(result.stdout, /Missing value for --workspace/);
});

test("invalid enum flags fail before invoking Cursor", () => {
  const workspace = mkdtempSync(join(tmpdir(), "cursor-agent-workspace-"));
  const result = runCli(["--workspace", workspace, "--mode", "edit", "task"]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /Invalid --mode/);
});

test("resolveExecutable does not discover a cursor-agent launcher as Cursor CLI", () => {
  const binDir = mkdtempSync(join(tmpdir(), "cursor-agent-bin-"));
  const homeDir = mkdtempSync(join(tmpdir(), "cursor-agent-home-"));
  const launcher = join(binDir, "cursor-agent");
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o755);

  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalOverride = process.env.CURSOR_CLI_EXECUTABLE;
  process.env.PATH = binDir;
  process.env.HOME = homeDir;
  delete process.env.CURSOR_CLI_EXECUTABLE;

  try {
    assert.equal(resolveExecutable(), "agent");
  } finally {
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
    if (originalOverride === undefined) delete process.env.CURSOR_CLI_EXECUTABLE;
    else process.env.CURSOR_CLI_EXECUTABLE = originalOverride;
  }
});

test("resolveExecutable falls back to the Cursor installer local agent path", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "cursor-agent-home-"));
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
    assert.equal(resolveExecutable(), localAgent);
  } finally {
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
    if (originalOverride === undefined) delete process.env.CURSOR_CLI_EXECUTABLE;
    else process.env.CURSOR_CLI_EXECUTABLE = originalOverride;
  }
});

test("fake Cursor stream output becomes a successful envelope", () => {
  const workspace = mkdtempSync(join(tmpdir(), "cursor-agent-workspace-"));
  const fakeAgent = join(workspace, "agent");
  writeFileSync(
    fakeAgent,
    [
      "#!/bin/sh",
      "printf '%s\\n' '{\"session_id\":\"abc\"}'",
      "printf '%s\\n' '{\"type\":\"result\",\"result\":\"done\",\"session_id\":\"abc\",\"is_error\":false,\"usage\":{\"input_tokens\":1234,\"output_tokens\":5}}'",
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
      "say done",
    ],
    { env: { CURSOR_CLI_EXECUTABLE: fakeAgent } },
  );

  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, "completed");
  assert.equal(envelope.sessionId, "abc");
  assert.equal(envelope.result, "done");
  assert.equal(envelope.usageSummary, "1k in, 5 out");
});

test("disabled idle timeout allows silent Cursor work until max runtime", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cursor-agent-workspace-"));
  const fakeAgent = join(workspace, "agent");
  writeFileSync(
    fakeAgent,
    [
      "#!/bin/sh",
      "sleep 0.1",
      "printf '%s\\n' '{\"type\":\"result\",\"result\":\"done\",\"is_error\":false}'",
      "",
    ].join("\n"),
  );
  chmodSync(fakeAgent, 0o755);

  const result = await runAgent(
    { executable: fakeAgent, args: [] },
    { workspace, outputFormat: "stream-json", maxRuntimeMs: 1_000, idleTimeoutMs: 0 },
  );

  assert.equal(result.timedOut, false);
  assert.equal(result.timeoutKind, undefined);
  assert.equal(result.resultText, "done");
});

test("explicit idle timeout still kills silent Cursor work", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cursor-agent-workspace-"));
  const fakeAgent = join(workspace, "agent");
  writeFileSync(
    fakeAgent,
    [
      "#!/bin/sh",
      "sleep 1",
      "printf '%s\\n' '{\"type\":\"result\",\"result\":\"done\",\"is_error\":false}'",
      "",
    ].join("\n"),
  );
  chmodSync(fakeAgent, 0o755);

  const result = await runAgent(
    { executable: fakeAgent, args: [] },
    { workspace, outputFormat: "stream-json", maxRuntimeMs: 1_000, idleTimeoutMs: 20 },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutKind, "idle");
});

test("structured output parser extracts and validates JSON", () => {
  const schema = {
    type: "object",
    required: ["verdict"],
    properties: {
      verdict: { enum: ["pass", "fail"] },
    },
  };

  assert.deepEqual(parseStructuredOutput('```json\n{"verdict":"pass"}\n```', schema), {
    value: { verdict: "pass" },
  });
  assert.match(
    parseStructuredOutput('{"verdict":"maybe"}', schema).error,
    /expected one of/,
  );
});
