import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const AGENT_PROVIDER_URL = pathToFileURL(join(process.cwd(), "providers/registry.ts")).href;

function runModuleScript(script: string, options: { env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

test("Cursor provider always uses SDK and lazy-loads on run", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-agent-provider-"));
  const script = `
    const { createAgentProvider } = await import(${JSON.stringify(AGENT_PROVIDER_URL)});
    const provider = createAgentProvider({ provider: "cursor" });
    const result = await provider.run({
      workspace: ${JSON.stringify(workspace)},
      prompt: "review this",
      maxRuntimeMs: 1000,
    });
    console.log(JSON.stringify(result));
  `;

  const result = runModuleScript(script, { env: { CURSOR_API_KEY: "" } });

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    ok: false,
    error: "CURSOR_API_KEY required for Cursor SDK runtime",
    exitCode: 1,
  });
});
