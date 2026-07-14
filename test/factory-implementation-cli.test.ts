import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

const BIN = join(process.cwd(), "bin/harness.ts");

test("implementation run help exposes the manual action surface", () => {
  const result = spawnSync(process.execPath, [BIN, "factory", "implementation", "run", "--help"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Run exactly one pending implementation action");
  expect(result.stdout).toContain("--rerun");
  expect(result.stdout).toContain("--rerun-guidance-file <path>");
  expect(result.stdout).not.toContain("--dry-run");
});

test("implementation run requires one durable input selector", () => {
  const result = spawnSync(process.execPath, [BIN, "factory", "implementation", "run"], {
    encoding: "utf8",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("one of --item-file or --linear-issue is required");
});
