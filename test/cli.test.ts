import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { HARNESS_GITIGNORE_ENTRY } from "../lib/config.ts";
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS_BIN = join(REPO_ROOT, "bin/harness.ts");
function createGitWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cli-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: workspace });
  writeFileSync(join(workspace, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}
test("harness init creates config through the CLI", () => {
  const workspace = createGitWorkspace();
  const result = spawnSync(
    process.execPath,
    [HARNESS_BIN, "init", "--workspace", workspace, "--base", "develop"],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.configCreated).toBe(true);
  expect(output.gitignoreUpdated).toBe(true);
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "develop"\n}\n');
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(`${HARNESS_GITIGNORE_ENTRY}\n`);
});
test("harness init resolves workspace from nested cwd", () => {
  const workspace = createGitWorkspace();
  const nested = join(workspace, "packages/app");
  mkdirSync(nested, { recursive: true });
  const result = spawnSync(process.execPath, [HARNESS_BIN, "init"], {
    cwd: nested,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.configCreated).toBe(true);
  expect(output.gitignoreUpdated).toBe(true);
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "main"\n}\n');
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(`${HARNESS_GITIGNORE_ENTRY}\n`);
});
test("harness init is idempotent through the CLI", () => {
  const workspace = createGitWorkspace();
  const first = spawnSync(process.execPath, [HARNESS_BIN, "init", "--workspace", workspace], {
    encoding: "utf8",
  });
  expect(first.status).toBe(0);
  const result = spawnSync(process.execPath, [HARNESS_BIN, "init", "--workspace", workspace], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.configCreated).toBe(false);
  expect(output.gitignoreUpdated).toBe(false);
});
test("harness init works with explicit non-git workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cli-"));
  const result = spawnSync(process.execPath, [HARNESS_BIN, "init", "--workspace", workspace], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "main"\n}\n');
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(`${HARNESS_GITIGNORE_ENTRY}\n`);
});
test("harness run dual-review help exits cleanly", () => {
  const result = spawnSync(process.execPath, [HARNESS_BIN, "run", "dual-review", "--help"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness run dual-review/);
});
test("harness run dual-review rejects unknown flags", () => {
  const result = spawnSync(process.execPath, [HARNESS_BIN, "run", "dual-review", "--unknown"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/Unknown option: --unknown/);
});
test("harness run dual-review dry-run works through the CLI", () => {
  const workspace = createGitWorkspace();
  const result = spawnSync(
    process.execPath,
    [
      HARNESS_BIN,
      "run",
      "dual-review",
      "--workspace",
      workspace,
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("dry_run");
  expect(output.workspace).toBe(workspace);
});
