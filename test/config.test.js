import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findHarnessConfig, resolveHarnessOptions } from "../lib/config.js";

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
