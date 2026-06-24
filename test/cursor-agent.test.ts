import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { invokeCursorAgent } from "../lib/cursor-agent.ts";

test("invokeCursorAgent accepts valid reviewer structured output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-agent-"));
  const fakeAgent = join(workspace, "fake-cursor-agent.mjs");
  writeFileSync(
    fakeAgent,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({",
      '  status: "completed",',
      "  structuredOutput: { verdict: 'pass', summary: 'ok', findings: [] }",
      "}));",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeAgent, 0o755);

  const result = await invokeCursorAgent({
    cursorAgentPath: fakeAgent,
    workspace,
    promptPath: join(workspace, "prompt.md"),
    schemaPath: join(workspace, "schema.json"),
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.review.verdict).toBe("pass");
  expect(result.review.findings).toEqual([]);
});

test("invokeCursorAgent rejects invalid reviewer structured output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-agent-"));
  const fakeAgent = join(workspace, "fake-cursor-agent.mjs");
  writeFileSync(
    fakeAgent,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({",
      '  status: "completed",',
      "  structuredOutput: { verdict: 'pass', summary: 'missing findings' }",
      "}));",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeAgent, 0o755);

  const result = await invokeCursorAgent({
    cursorAgentPath: fakeAgent,
    workspace,
    promptPath: join(workspace, "prompt.md"),
    schemaPath: join(workspace, "schema.json"),
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/Invalid reviewer structured output: findings:/);
});

test("invokeCursorAgent rejects agent process failures", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-agent-"));

  const result = await invokeCursorAgent({
    cursorAgentPath: join(workspace, "missing-agent.mjs"),
    workspace,
    promptPath: join(workspace, "prompt.md"),
    schemaPath: join(workspace, "schema.json"),
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/Invalid cursor-agent JSON output/);
  expect(result.stderr).toMatch(/Cannot find module|MODULE_NOT_FOUND/);
});
