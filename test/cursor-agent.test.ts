import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCursorAgent } from "../lib/cursor-agent.ts";

function createFakeCursorAgentScript(body: string[]): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-agent-"));
  const fakeAgent = join(workspace, "fake-cursor-agent.mjs");
  writeFileSync(fakeAgent, ["#!/usr/bin/env node", ...body, ""].join("\n"), "utf8");
  chmodSync(fakeAgent, 0o755);
  return fakeAgent;
}

test("createCursorAgent passes prompts over stdin", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-agent-"));
  const fakeAgent = createFakeCursorAgentScript([
    "const chunks = [];",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => chunks.push(String(chunk)));",
    "process.stdin.on('end', () => {",
    "  console.log(JSON.stringify({",
    "    status: 'completed',",
    "    structuredOutput: {",
    "      prompt: chunks.join(''),",
    "      hasStdin: process.argv.includes('--stdin'),",
    "      hasPromptFile: process.argv.includes('--prompt-file'),",
    "    },",
    "  }));",
    "});",
  ]);

  const result = await createCursorAgent({ cursorAgentPath: fakeAgent }).run({
    workspace,
    prompt: "review this",
    schemaPath: join(workspace, "schema.json"),
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual({
    prompt: "review this",
    hasStdin: true,
    hasPromptFile: false,
  });
});

test("createCursorAgent returns provider structured output without review validation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-agent-"));
  const fakeAgent = createFakeCursorAgentScript([
    "console.log(JSON.stringify({",
    '  status: "completed",',
    "  structuredOutput: { verdict: 'pass', summary: 'missing findings' }",
    "}));",
  ]);

  const result = await createCursorAgent({ cursorAgentPath: fakeAgent }).run({
    workspace,
    prompt: "review this",
    schemaPath: join(workspace, "schema.json"),
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual({ verdict: "pass", summary: "missing findings" });
});

test("createCursorAgent rejects process failures", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-agent-"));

  const result = await createCursorAgent({
    cursorAgentPath: join(workspace, "missing-agent.mjs"),
  }).run({
    workspace,
    prompt: "review this",
    schemaPath: join(workspace, "schema.json"),
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/Invalid cursor-agent JSON output/);
  expect(result.stderr).toMatch(/Cannot find module|MODULE_NOT_FOUND/);
});

test("createCursorAgent returns stdin write failures", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-agent-"));
  const fakeAgent = createFakeCursorAgentScript([
    "import { closeSync } from 'node:fs';",
    "process.stderr.write('closed before stdin\\n');",
    "closeSync(0);",
    "setTimeout(() => process.exit(1), 500);",
  ]);

  const result = await createCursorAgent({ cursorAgentPath: fakeAgent }).run({
    workspace,
    prompt: "x".repeat(32 * 1024 * 1024),
    schemaPath: join(workspace, "schema.json"),
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).not.toBe("");
});
