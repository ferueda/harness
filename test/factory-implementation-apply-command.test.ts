import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

const BIN = join(process.cwd(), "bin/harness.ts");

test("implementation never enters the legacy Linear apply lifecycle", () => {
  const result = spawnSync(
    process.execPath,
    [BIN, "factory", "implementation", "run", "--linear-issue", "ENG-123"],
    { encoding: "utf8", env: { ...process.env, LINEAR_API_KEY: "test" } },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Factory implementation is not available");
  expect(result.stdout).toBe("");
});
