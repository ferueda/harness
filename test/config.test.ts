import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  HARNESS_GITIGNORE_ENTRY,
  findHarnessConfig,
  initHarnessConfig,
  resolveHarnessOptions,
} from "../lib/config.ts";
const TEST_HARNESS_ENTRYPOINT = "/opt/harness/dist/bin/harness.js";

function initOptions(options: { workspace?: string; baseRef?: string } = {}) {
  return {
    ...options,
    harnessEntrypoint: TEST_HARNESS_ENTRYPOINT,
    nodePath: process.execPath,
  };
}

function expectHarnessShim(workspace: string): string {
  const shimPath = join(workspace, ".harness/bin/harness");
  const content = readFileSync(shimPath, "utf8");
  expect(content).toContain(process.execPath);
  expect(content).toContain(TEST_HARNESS_ENTRYPOINT);
  expect(statSync(shimPath).mode & 0o111).not.toBe(0);
  return shimPath;
}
test("findHarnessConfig walks up from nested directories", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  const nested = join(workspace, "packages/app");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(workspace, "harness.json"), '{ "base": "develop" }\n', "utf8");
  expect(findHarnessConfig(nested)).toBe(join(workspace, "harness.json"));
});
test("resolveHarnessOptions uses harness.json directory as workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  const nested = join(workspace, "packages/app");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(workspace, "harness.json"), '{ "base": "develop" }\n', "utf8");
  const options = resolveHarnessOptions({ headRef: "feature" }, nested);
  expect(options.workspace).toBe(workspace);
  expect(options.baseRef).toBe("develop");
  expect(options.headRef).toBe("feature");
});
test("resolveHarnessOptions lets explicit flags override harness.json", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(join(workspace, "harness.json"), '{ "base": "develop" }\n', "utf8");
  const options = resolveHarnessOptions({ workspace, baseRef: "main" }, "/");
  expect(options.workspace).toBe(workspace);
  expect(options.baseRef).toBe("main");
  expect(options.headRef).toBe("HEAD");
});
test("resolveHarnessOptions accepts unknown harness.json keys", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(join(workspace, "harness.json"), '{ "base": "develop", "future": true }\n', "utf8");
  const options = resolveHarnessOptions({ workspace }, "/");
  expect(options.baseRef).toBe("develop");
});
test("resolveHarnessOptions rejects invalid harness.json values", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(join(workspace, "harness.json"), '{ "base": 123 }\n', "utf8");
  expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(/Invalid harness\.json: base:/);
});
test("resolveHarnessOptions rejects non-object harness.json values", () => {
  for (const contents of ["null", "[]", '"repo"']) {
    const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
    writeFileSync(join(workspace, "harness.json"), `${contents}\n`, "utf8");
    expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(/Invalid harness\.json:/);
  }
});
test("resolveHarnessOptions falls back to Git root without harness.json", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-git-"));
  const nested = join(workspace, "src/app");
  mkdirSync(nested, { recursive: true });
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  const options = resolveHarnessOptions({}, nested);
  expect(options.workspace).toBe(realpathSync(workspace));
  expect(options.baseRef).toBe("main");
});
test("initHarnessConfig creates harness.json, ignores artifacts, and writes shim", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  const result = initHarnessConfig(initOptions({ baseRef: "develop" }), workspace);
  expect(result.workspace).toBe(realpathSync(workspace));
  expect(result.configCreated).toBe(true);
  expect(result.gitignoreUpdated).toBe(true);
  expect(result.shimUpdated).toBe(true);
  expect(result.shimPath).toBe(join(result.workspace, ".harness/bin/harness"));
  expect(result.recommendedCommand).toBe(".harness/bin/harness run review");
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "develop"\n}\n');
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(`${HARNESS_GITIGNORE_ENTRY}\n`);
  expectHarnessShim(workspace);
});
test("initHarnessConfig is idempotent", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  initHarnessConfig(initOptions({ baseRef: "develop" }), workspace);
  writeFileSync(
    join(workspace, ".gitignore"),
    `node_modules\n${HARNESS_GITIGNORE_ENTRY}\n`,
    "utf8",
  );
  const result = initHarnessConfig(initOptions({ baseRef: "main" }), workspace);
  expect(result.configCreated).toBe(false);
  expect(result.gitignoreUpdated).toBe(false);
  expect(result.shimUpdated).toBe(false);
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "develop"\n}\n');
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(
    `node_modules\n${HARNESS_GITIGNORE_ENTRY}\n`,
  );
});
test("initHarnessConfig creates .gitignore when needed", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  const result = initHarnessConfig(initOptions(), workspace);
  expect(result.gitignoreUpdated).toBe(true);
  expect(result.configCreated).toBe(true);
  expect(result.shimUpdated).toBe(true);
  expect(existsSync(join(workspace, ".gitignore"))).toBe(true);
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "main"\n}\n');
  expectHarnessShim(workspace);
});
test("initHarnessConfig resolves git root from nested cwd", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  const nested = join(workspace, "packages/app");
  mkdirSync(nested, { recursive: true });
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  const result = initHarnessConfig(initOptions(), nested);
  expect(result.workspace).toBe(realpathSync(workspace));
  expect(result.configCreated).toBe(true);
  expect(result.gitignoreUpdated).toBe(true);
  expect(result.shimUpdated).toBe(true);
  expect(existsSync(join(workspace, "harness.json"))).toBe(true);
  expect(existsSync(join(workspace, ".gitignore"))).toBe(true);
  expectHarnessShim(workspace);
  expect(existsSync(join(nested, "harness.json"))).toBe(false);
});
test("initHarnessConfig appends to existing .gitignore", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, ".gitignore"), "node_modules\n", "utf8");
  const result = initHarnessConfig(initOptions(), workspace);
  expect(result.gitignoreUpdated).toBe(true);
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(
    `node_modules\n${HARNESS_GITIGNORE_ENTRY}\n`,
  );
});
test("initHarnessConfig appends to .gitignore without trailing newline", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, ".gitignore"), "node_modules", "utf8");
  const result = initHarnessConfig(initOptions(), workspace);
  expect(result.gitignoreUpdated).toBe(true);
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(
    `node_modules\n${HARNESS_GITIGNORE_ENTRY}\n`,
  );
});
test("initHarnessConfig updates gitignore when config exists", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "harness.json"), '{\n  "base": "develop"\n}\n', "utf8");
  const result = initHarnessConfig(initOptions(), workspace);
  expect(result.configCreated).toBe(false);
  expect(result.gitignoreUpdated).toBe(true);
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "develop"\n}\n');
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(`${HARNESS_GITIGNORE_ENTRY}\n`);
});
test("initHarnessConfig accepts equivalent harness ignore entries", () => {
  for (const entry of [
    ".harness",
    ".harness/",
    ".harness/*",
    ".harness/**",
    "**/.harness",
    "**/.harness/",
  ]) {
    const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    writeFileSync(join(workspace, ".gitignore"), `${entry}\n`, "utf8");
    const result = initHarnessConfig(initOptions(), workspace);
    expect(result.gitignoreUpdated).toBe(false);
    expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(`${entry}\n`);
  }
});
test("initHarnessConfig reports skipped base when config exists", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "harness.json"), '{\n  "base": "develop"\n}\n', "utf8");
  const result = initHarnessConfig(initOptions({ baseRef: "main" }), workspace);
  expect(result.configCreated).toBe(false);
  expect(result.baseSkipped).toBe(true);
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "develop"\n}\n');
});
test("initHarnessConfig rejects missing workspaces", () => {
  const workspace = join(tmpdir(), "missing-harness-workspace");
  expect(() => initHarnessConfig(initOptions({ workspace }), "/")).toThrow(
    /Workspace does not exist:/,
  );
});
