import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HARNESS_GITIGNORE_ENTRY,
  findHarnessConfig,
  initHarnessConfig,
  resolveHarnessOptions,
} from "../lib/config.js";

test("findHarnessConfig walks up from nested directories", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  const nested = join(workspace, "packages/app");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(workspace, "harness.json"), '{ "base": "develop" }\n', "utf8");

  assert.equal(findHarnessConfig(nested), join(workspace, "harness.json"));
});

test("resolveHarnessOptions uses harness.json directory as workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  const nested = join(workspace, "packages/app");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(workspace, "harness.json"), '{ "base": "develop" }\n', "utf8");

  const options = resolveHarnessOptions({ headRef: "feature" }, nested);

  assert.equal(options.workspace, workspace);
  assert.equal(options.baseRef, "develop");
  assert.equal(options.headRef, "feature");
});

test("resolveHarnessOptions lets explicit flags override harness.json", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(join(workspace, "harness.json"), '{ "base": "develop" }\n', "utf8");

  const options = resolveHarnessOptions({ workspace, baseRef: "main" }, "/");

  assert.equal(options.workspace, workspace);
  assert.equal(options.baseRef, "main");
  assert.equal(options.headRef, "HEAD");
});

test("resolveHarnessOptions falls back to Git root without harness.json", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-git-"));
  const nested = join(workspace, "src/app");
  mkdirSync(nested, { recursive: true });
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });

  const options = resolveHarnessOptions({}, nested);

  assert.equal(options.workspace, realpathSync(workspace));
  assert.equal(options.baseRef, "main");
});

test("initHarnessConfig creates harness.json and ignores harness artifacts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });

  const result = initHarnessConfig({ baseRef: "develop" }, workspace);

  assert.equal(result.workspace, realpathSync(workspace));
  assert.equal(result.configCreated, true);
  assert.equal(result.gitignoreUpdated, true);
  assert.equal(readFileSync(join(workspace, "harness.json"), "utf8"), '{\n  "base": "develop"\n}\n');
  assert.equal(readFileSync(join(workspace, ".gitignore"), "utf8"), `${HARNESS_GITIGNORE_ENTRY}\n`);
});

test("initHarnessConfig is idempotent", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "harness.json"), '{\n  "base": "develop"\n}\n', "utf8");
  writeFileSync(join(workspace, ".gitignore"), `node_modules\n${HARNESS_GITIGNORE_ENTRY}\n`, "utf8");

  const result = initHarnessConfig({ baseRef: "main" }, workspace);

  assert.equal(result.configCreated, false);
  assert.equal(result.gitignoreUpdated, false);
  assert.equal(readFileSync(join(workspace, "harness.json"), "utf8"), '{\n  "base": "develop"\n}\n');
  assert.equal(readFileSync(join(workspace, ".gitignore"), "utf8"), `node_modules\n${HARNESS_GITIGNORE_ENTRY}\n`);
});

test("initHarnessConfig creates .gitignore when needed", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });

  const result = initHarnessConfig({}, workspace);

  assert.equal(result.gitignoreUpdated, true);
  assert.equal(result.configCreated, true);
  assert.equal(existsSync(join(workspace, ".gitignore")), true);
  assert.equal(readFileSync(join(workspace, "harness.json"), "utf8"), '{\n  "base": "main"\n}\n');
});
