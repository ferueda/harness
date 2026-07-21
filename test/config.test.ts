import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
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
  HARNESS_RECOMMENDED_COMMAND,
  HARNESS_SHIM_RELATIVE_PATH,
  type InitHarnessOptions,
  findHarnessConfig,
  initHarnessConfig,
  loadHarnessConfigSnapshot,
  resolveHarnessOptions,
  resolveLinearAutomationSettings,
  resolveLinearAutomationSettingsFromSnapshot,
} from "../lib/config.ts";
const TEST_HARNESS_ENTRYPOINT = "/opt/harness/dist/bin/harness.js";

function initOptions(options: Partial<InitHarnessOptions> = {}): InitHarnessOptions {
  return {
    ...options,
    harnessEntrypoint: options.harnessEntrypoint ?? TEST_HARNESS_ENTRYPOINT,
    nodePath: options.nodePath ?? process.execPath,
  };
}

function expectHarnessShim(workspace: string): string {
  const shimPath = join(workspace, HARNESS_SHIM_RELATIVE_PATH);
  const content = readFileSync(shimPath, "utf8");
  expect(content).toContain(process.execPath);
  expect(content).toContain(TEST_HARNESS_ENTRYPOINT);
  expect(statSync(shimPath).mode & 0o111).not.toBe(0);
  return shimPath;
}

function writeHarnessJson(workspace: string, value: unknown): void {
  writeFileSync(join(workspace, "harness.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const LINEAR_AUTOMATION = {
  readiness: {
    teamId: "team-1",
    projectId: "project-1",
    stateIds: {
      backlog: "state-backlog",
      open: "state-open",
      inProgress: "state-in-progress",
      inReview: "state-in-review",
      done: "state-done",
      canceled: "state-canceled",
      duplicate: "state-duplicate",
    },
    nextActionLabelIds: {
      plan: "label-plan",
      implement: "label-implement",
      needsInput: "label-needs-input",
    },
  },
  triage: {
    agent: "codex",
    maxRuntimeMs: 120_000,
  },
};

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
test("resolveHarnessOptions reads agent defaults from harness.json", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(
    join(workspace, "harness.json"),
    JSON.stringify(
      {
        base: "develop",
        defaultAgent: "codex",
        agents: {
          codex: {
            model: "gpt-test",
            executable: "/opt/codex",
            sandboxMode: "workspace-write",
            approvalPolicy: "on-request",
            modelReasoningEffort: "medium",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const options = resolveHarnessOptions({ workspace }, "/");
  expect(options.baseRef).toBe("develop");
  expect(options.agentProvider).toBe("codex");
  expect(options.model).toBe("gpt-test");
  expect(options.codexPathOverride).toBe("/opt/codex");
  expect(options.sandboxMode).toBe("workspace-write");
  expect(options.approvalPolicy).toBe("on-request");
  expect(options.modelReasoningEffort).toBe("medium");
});
test("resolveHarnessOptions reads provider-scoped Cursor config", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "defaultAgent": "cursor", "agents": { "cursor": { "model": "gpt-5.6-sol-high" } } }\n',
    "utf8",
  );
  const options = resolveHarnessOptions({ workspace }, "/");
  expect(options.agentProvider).toBe("cursor");
  expect(options.model).toBe("gpt-5.6-sol-high");
  expect(options.modelReasoningEffort).toBeUndefined();
});
test("resolveHarnessOptions applies provider model defaults", () => {
  const cursorWorkspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  const cursorOptions = resolveHarnessOptions({ workspace: cursorWorkspace }, "/");
  expect(cursorOptions.agentProvider).toBe("cursor");
  expect(cursorOptions.model).toBe("grok-4.5");
  expect(cursorOptions.modelReasoningEffort).toBeUndefined();

  const codexWorkspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(join(codexWorkspace, "harness.json"), '{ "defaultAgent": "codex" }\n', "utf8");
  const codexOptions = resolveHarnessOptions({ workspace: codexWorkspace }, "/");
  expect(codexOptions.agentProvider).toBe("codex");
  expect(codexOptions.model).toBe("gpt-5.6-sol");
  expect(codexOptions.modelReasoningEffort).toBe("high");
});

test("resolveLinearAutomationSettings resolves one immutable worker snapshot", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-linear-automation-"));
  writeHarnessJson(workspace, {
    agents: {
      codex: {
        model: "gpt-worker",
        executable: "/opt/codex-worker",
        modelReasoningEffort: "medium",
      },
    },
    linearAutomation: LINEAR_AUTOMATION,
  });

  const snapshot = loadHarnessConfigSnapshot(workspace, "/");
  writeHarnessJson(workspace, {
    linearAutomation: {
      ...LINEAR_AUTOMATION,
      readiness: {
        ...LINEAR_AUTOMATION.readiness,
        projectId: "project-newer",
      },
    },
  });
  const settings = resolveLinearAutomationSettingsFromSnapshot(snapshot);

  expect(settings).toEqual({
    workspace,
    readiness: LINEAR_AUTOMATION.readiness,
    triage: {
      ...LINEAR_AUTOMATION.triage,
      model: "gpt-worker",
      modelReasoningEffort: "medium",
      codexPathOverride: "/opt/codex-worker",
    },
  });
  expect(Object.isFrozen(settings)).toBe(true);
  expect(Object.isFrozen(settings.readiness.stateIds)).toBe(true);
  expect(Object.isFrozen(settings.readiness.nextActionLabelIds)).toBe(true);
  expect(Object.isFrozen(settings.triage)).toBe(true);
});

test("resolveLinearAutomationSettings prefers triage model overrides", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-linear-automation-"));
  writeHarnessJson(workspace, {
    agents: { codex: { model: "gpt-provider", modelReasoningEffort: "low" } },
    linearAutomation: {
      ...LINEAR_AUTOMATION,
      triage: {
        ...LINEAR_AUTOMATION.triage,
        model: "gpt-triage",
        modelReasoningEffort: "xhigh",
      },
    },
  });

  expect(resolveLinearAutomationSettings({ workspace }, "/").triage).toMatchObject({
    model: "gpt-triage",
    modelReasoningEffort: "xhigh",
  });
});

test("resolveLinearAutomationSettings rejects missing or invalid worker config", () => {
  const missing = mkdtempSync(join(tmpdir(), "harness-linear-automation-"));
  expect(() => resolveLinearAutomationSettings({ workspace: missing }, "/")).toThrow(
    /linearAutomation is required/,
  );

  const invalid = mkdtempSync(join(tmpdir(), "harness-linear-automation-"));
  writeHarnessJson(invalid, {
    linearAutomation: {
      ...LINEAR_AUTOMATION,
      readiness: {
        ...LINEAR_AUTOMATION.readiness,
        stateIds: {
          ...LINEAR_AUTOMATION.readiness.stateIds,
          open: LINEAR_AUTOMATION.readiness.stateIds.backlog,
        },
      },
    },
  });
  expect(() => resolveLinearAutomationSettings({ workspace: invalid }, "/")).toThrow(
    /linearAutomation\.readiness\.stateIds: IDs must be unique/,
  );

  const legacyOrganization = mkdtempSync(join(tmpdir(), "harness-linear-automation-"));
  writeHarnessJson(legacyOrganization, {
    linearAutomation: { ...LINEAR_AUTOMATION, organizationId: "organization-1" },
  });
  expect(() => resolveLinearAutomationSettings({ workspace: legacyOrganization }, "/")).toThrow(
    /linearAutomation: Unrecognized key: "organizationId"/,
  );

  const unsupportedProvider = mkdtempSync(join(tmpdir(), "harness-linear-automation-"));
  writeHarnessJson(unsupportedProvider, {
    linearAutomation: {
      ...LINEAR_AUTOMATION,
      triage: { ...LINEAR_AUTOMATION.triage, agent: "cursor" },
    },
  });
  expect(() => resolveLinearAutomationSettings({ workspace: unsupportedProvider }, "/")).toThrow(
    /linearAutomation\.triage\.agent: Invalid input: expected "codex"/,
  );
});

test("resolveHarnessOptions clearly rejects removed Factory configuration", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, { factory: {} });

  expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(
    /factory.*(?:removed|no longer supported)/i,
  );
});

test("resolveHarnessOptions rejects legacy Cursor runtime cli config", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "defaultAgent": "cursor", "agents": { "cursor": { "runtime": "cli", "model": "gpt-5.6-sol-high" } } }\n',
    "utf8",
  );
  expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(
    /Invalid harness\.json: agents\.cursor\.runtime:/,
  );
});
test("resolveHarnessOptions rejects legacy Cursor runtime sdk config", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "agents": { "cursor": { "runtime": "sdk" } } }\n',
    "utf8",
  );
  expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(
    /Invalid harness\.json: agents\.cursor\.runtime:/,
  );
});
test("resolveHarnessOptions ignores Codex policy config for Cursor", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "agents": { "codex": { "sandboxMode": "read-only", "approvalPolicy": "never" } } }\n',
    "utf8",
  );
  const options = resolveHarnessOptions({ workspace }, "/");
  expect(options.agentProvider).toBe("cursor");
  expect(options.sandboxMode).toBeUndefined();
  expect(options.approvalPolicy).toBeUndefined();
  expect(options.modelReasoningEffort).toBeUndefined();
});
test("resolveHarnessOptions strips Codex policy config when CLI overrides to Cursor", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "defaultAgent": "codex", "agents": { "codex": { "sandboxMode": "read-only", "approvalPolicy": "never" } } }\n',
    "utf8",
  );
  const options = resolveHarnessOptions({ workspace, agentProvider: "cursor" as const }, "/");
  expect(options.agentProvider).toBe("cursor");
  expect(options.sandboxMode).toBeUndefined();
  expect(options.approvalPolicy).toBeUndefined();
  expect(options.modelReasoningEffort).toBeUndefined();
});
test("resolveHarnessOptions lets explicit flags override harness.json", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "base": "develop", "defaultAgent": "codex", "agents": { "codex": { "model": "gpt-test" } } }\n',
    "utf8",
  );
  const options = resolveHarnessOptions(
    { workspace, baseRef: "main", agentProvider: "cursor" as const, model: "gpt-override" },
    "/",
  );
  expect(options.workspace).toBe(workspace);
  expect(options.baseRef).toBe("main");
  expect(options.headRef).toBe("HEAD");
  expect(options.agentProvider).toBe("cursor");
  expect(options.model).toBe("gpt-override");
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
test("resolveHarnessOptions rejects invalid agent config values", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(join(workspace, "harness.json"), '{ "defaultAgent": "other" }\n', "utf8");
  expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(
    /Invalid harness\.json: defaultAgent:/,
  );
});
test("resolveHarnessOptions rejects invalid sandbox config values", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "agents": { "codex": { "sandboxMode": "loose" } } }\n',
    "utf8",
  );
  expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(
    /Invalid harness\.json: agents\.codex\.sandboxMode:/,
  );
});
test("resolveHarnessOptions rejects invalid approval policy config values", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "agents": { "codex": { "approvalPolicy": "always" } } }\n',
    "utf8",
  );
  expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(
    /Invalid harness\.json: agents\.codex\.approvalPolicy:/,
  );
});
test("resolveHarnessOptions rejects invalid reasoning effort config values", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "agents": { "codex": { "modelReasoningEffort": "huge" } } }\n',
    "utf8",
  );
  expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(
    /Invalid harness\.json: agents\.codex\.modelReasoningEffort:/,
  );
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
  expect(result.shimPath).toBe(join(result.workspace, HARNESS_SHIM_RELATIVE_PATH));
  expect(result.recommendedCommand).toBe(HARNESS_RECOMMENDED_COMMAND);
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
test("initHarnessConfig rejects missing harness entrypoint", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  expect(() => initHarnessConfig({} as InitHarnessOptions, workspace)).toThrow(
    /harnessEntrypoint is required/,
  );
});
test("initHarnessConfig rewrites shim when harness entrypoint changes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  const firstEntrypoint = "/opt/harness/first.js";
  const secondEntrypoint = "/opt/harness/second.js";
  initHarnessConfig(initOptions({ harnessEntrypoint: firstEntrypoint }), workspace);
  const result = initHarnessConfig(initOptions({ harnessEntrypoint: secondEntrypoint }), workspace);
  const shim = readFileSync(join(workspace, HARNESS_SHIM_RELATIVE_PATH), "utf8");
  expect(result.shimUpdated).toBe(true);
  expect(shim).toContain(secondEntrypoint);
  expect(shim).not.toContain(firstEntrypoint);
});
test("initHarnessConfig rewrites shim when node path changes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  const firstNodePath = "/opt/node/first/bin/node";
  const secondNodePath = "/opt/node/second/bin/node";
  initHarnessConfig(initOptions({ nodePath: firstNodePath }), workspace);
  const result = initHarnessConfig(initOptions({ nodePath: secondNodePath }), workspace);
  const shim = readFileSync(join(workspace, HARNESS_SHIM_RELATIVE_PATH), "utf8");
  expect(result.shimUpdated).toBe(true);
  expect(shim).toContain(secondNodePath);
  expect(shim).not.toContain(firstNodePath);
});
test("initHarnessConfig quotes shim paths with spaces and single quotes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-init-"));
  const quoteDir = mkdtempSync(join(tmpdir(), "harness quote '"));
  const nodePath = join(quoteDir, "node wrapper");
  const harnessEntrypoint = join(quoteDir, "entry point's script");
  const argFile = join(quoteDir, "arg.txt");
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(nodePath, '#!/usr/bin/env bash\nexec "$@"\n', "utf8");
  writeFileSync(
    harnessEntrypoint,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$1" > ${JSON.stringify(argFile)}\n`,
    "utf8",
  );
  chmodSync(nodePath, 0o755);
  chmodSync(harnessEntrypoint, 0o755);
  const result = initHarnessConfig(initOptions({ harnessEntrypoint, nodePath }), workspace);
  const shim = spawnSync(result.shimPath, ["hello world"], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(shim.status).toBe(0);
  expect(shim.stderr).toBe("");
  expect(readFileSync(argFile, "utf8")).toBe("hello world\n");
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
