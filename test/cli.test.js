import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HARNESS_GITIGNORE_ENTRY } from "../lib/config.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS_BIN = join(REPO_ROOT, "bin/harness.mjs");

test("harness init creates config through the CLI", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cli-"));
  spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });

  const result = spawnSync(
    process.execPath,
    [HARNESS_BIN, "init", "--workspace", workspace, "--base", "develop"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.configCreated, true);
  assert.equal(output.gitignoreUpdated, true);
  assert.equal(readFileSync(join(workspace, "harness.json"), "utf8"), '{\n  "base": "develop"\n}\n');
  assert.equal(readFileSync(join(workspace, ".gitignore"), "utf8"), `${HARNESS_GITIGNORE_ENTRY}\n`);
});

test("harness init resolves workspace from nested cwd", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cli-"));
  const nested = join(workspace, "packages/app");
  mkdirSync(nested, { recursive: true });
  spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });

  const result = spawnSync(process.execPath, [HARNESS_BIN, "init"], {
    cwd: nested,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.configCreated, true);
  assert.equal(output.gitignoreUpdated, true);
  assert.equal(readFileSync(join(workspace, "harness.json"), "utf8"), '{\n  "base": "main"\n}\n');
  assert.equal(readFileSync(join(workspace, ".gitignore"), "utf8"), `${HARNESS_GITIGNORE_ENTRY}\n`);
});

test("harness init is idempotent through the CLI", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cli-"));
  spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });

  const first = spawnSync(process.execPath, [HARNESS_BIN, "init", "--workspace", workspace], {
    encoding: "utf8",
  });
  assert.equal(first.status, 0);

  const result = spawnSync(process.execPath, [HARNESS_BIN, "init", "--workspace", workspace], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.configCreated, false);
  assert.equal(output.gitignoreUpdated, false);
});
