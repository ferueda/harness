import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

const BIN = join(process.cwd(), "bin/harness.ts");

test.each([["--dry-run"], []])(
  "implementation run is unavailable until its Factory PR ships",
  (...args) => {
    const result = spawnSync(process.execPath, [BIN, "factory", "implementation", ...args], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Factory implementation is not available");
  },
);
