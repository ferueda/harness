import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { invokeCursorAgent } from "../lib/cursor-agent.ts";

test("invokeCursorAgent rejects invalid reviewer structured output", () => {
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

  const result = invokeCursorAgent({
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
