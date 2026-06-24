import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL = join(REPO_ROOT, "install");
const PATH_WARNING = "Add this directory to PATH:";

function runInstall(options: { binDir?: string; cwd?: string; path?: string } = {}) {
  return spawnSync("bash", [INSTALL], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_INSTALL_BIN_DIR: options.binDir ?? mkdtempSync(join(tmpdir(), "harness-bin-")),
      HARNESS_INSTALL_SKIP_PNPM: "1",
      PATH: options.path ?? process.env.PATH,
    },
  });
}

function expectInstalledHarness(binDir: string) {
  const shimPath = join(realpathSync(binDir), "harness");
  expect(existsSync(shimPath)).toBe(true);
  expect(statSync(shimPath).mode & 0o111).not.toBe(0);
  const content = readFileSync(shimPath, "utf8");
  expect(content).toContain(process.execPath);
  expect(content).toContain(join(REPO_ROOT, "bin/harness.ts"));
  const help = spawnSync(shimPath, ["--help"], { encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(help.stdout).toMatch(/Usage: harness/);
}

test("install writes a user-level harness shim", () => {
  const binDir = mkdtempSync(join(tmpdir(), "harness install '"));
  const result = runInstall({ binDir });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Installed harness:");
  expect(result.stdout).toContain("Checkout root:");
  expectInstalledHarness(binDir);
});

test("install reports PATH guidance when bin dir is not on PATH", () => {
  const binDir = mkdtempSync(join(tmpdir(), "harness-bin-"));
  const result = runInstall({ binDir, path: process.env.PATH });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(PATH_WARNING);
});

test("install does not report PATH guidance when bin dir is on PATH", () => {
  const binDir = mkdtempSync(join(tmpdir(), "harness-bin-"));
  const result = runInstall({
    binDir,
    path: `${binDir}:${process.env.PATH ?? ""}`,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain(PATH_WARNING);
});

test("install works when invoked outside the checkout cwd", () => {
  const binDir = mkdtempSync(join(tmpdir(), "harness-bin-"));
  const cwd = mkdtempSync(join(tmpdir(), "harness-cwd-"));
  const result = runInstall({ binDir, cwd });
  expect(result.status).toBe(0);
  expectInstalledHarness(binDir);
});

test("install is idempotent", () => {
  const binDir = mkdtempSync(join(tmpdir(), "harness-bin-"));
  const first = runInstall({ binDir });
  const second = runInstall({ binDir });
  expect(first.status).toBe(0);
  expect(second.status).toBe(0);
  expectInstalledHarness(binDir);
});
