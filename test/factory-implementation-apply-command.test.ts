import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

const BIN = join(process.cwd(), "bin/harness.ts");

test("implementation apply remains Linear-only", () => {
  const result = spawnSync(
    process.execPath,
    [BIN, "factory", "implementation", "run", "--item-file", "item.json", "--apply"],
    { encoding: "utf8" },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("--apply requires --linear-issue");
});
