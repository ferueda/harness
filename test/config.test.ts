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
  parsePositiveIntegerOption,
  resolveFactoryImplementationReviewer,
  resolveFactoryImplementationSettings,
  resolveFactoryLinearSettings,
  resolveFactoryPlanningSettings,
  resolveFactoryRoleAgent,
  resolveHarnessOptions,
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

const LINEAR_STATUSES = {
  intake: "Backlog",
  parked: "Parked",
  needsInfo: "Needs Clarification",
  needsPlanReview: "Plan Needs Review",
  needsPlan: "Needs Plan",
  readyToImplement: "Ready to Implement",
  implementing: "Implementing",
  implementationFailed: "Implementation Failed",
  triaging: "Triaging",
  planning: "Planning",
  triageFailed: "Triage Failed",
  planningFailed: "Planning Failed",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
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

test("resolveFactoryRoleAgent resolves absent factory through defaultAgent then cursor", () => {
  const codexWorkspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(codexWorkspace, {
    defaultAgent: "codex",
    agents: { codex: { model: "gpt-custom" } },
  });
  expect(
    resolveFactoryRoleAgent({ workspace: codexWorkspace, station: "triage", role: "triager" }, "/"),
  ).toMatchObject({
    workspace: codexWorkspace,
    agent: "codex",
    model: "gpt-custom",
    modelReasoningEffort: "high",
  });

  const cursorWorkspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  expect(
    resolveFactoryRoleAgent(
      { workspace: cursorWorkspace, station: "triage", role: "triager" },
      "/",
    ),
  ).toMatchObject({
    workspace: cursorWorkspace,
    agent: "cursor",
    model: "grok-4.5",
  });
});

test("resolveFactoryRoleAgent reads triage role model override", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    agents: { cursor: { model: "composer-2.5" } },
    factory: {
      triage: {
        roles: {
          triager: { agent: "cursor", model: "claude-opus-4-8" },
        },
      },
    },
  });

  expect(
    resolveFactoryRoleAgent({ workspace, station: "triage", role: "triager" }, "/"),
  ).toMatchObject({
    agent: "cursor",
    model: "claude-opus-4-8",
  });
});

test("resolveFactoryRoleAgent accepts Cursor grok-4.5 role model", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    agents: { cursor: { model: "composer-2.5" } },
    factory: {
      triage: {
        roles: {
          triager: { agent: "cursor", model: "grok-4.5" },
        },
      },
    },
  });

  expect(
    resolveFactoryRoleAgent({ workspace, station: "triage", role: "triager" }, "/"),
  ).toMatchObject({
    agent: "cursor",
    model: "grok-4.5",
  });
});

test("resolveFactoryRoleAgent resolves planning roles independently", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    defaultAgent: "cursor",
    agents: {
      cursor: { model: "composer-2.5" },
      codex: {
        model: "gpt-config",
        executable: "/opt/codex",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        modelReasoningEffort: "medium",
      },
    },
    factory: {
      planning: {
        roles: {
          planner: { model: "claude-opus-4-8" },
          reviewer: { agent: "codex" },
        },
      },
    },
  });

  expect(
    resolveFactoryRoleAgent({ workspace, station: "planning", role: "planner" }, "/"),
  ).toMatchObject({
    agent: "cursor",
    model: "claude-opus-4-8",
  });
  expect(
    resolveFactoryRoleAgent({ workspace, station: "planning", role: "reviewer" }, "/"),
  ).toMatchObject({
    agent: "codex",
    model: "gpt-config",
    codexPathOverride: "/opt/codex",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelReasoningEffort: "medium",
  });
});

test("resolveFactoryPlanningSettings reads configured value and defaults to three", () => {
  const configuredWorkspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(configuredWorkspace, {
    factory: { planning: { maxReviewIterations: 5 } },
  });
  expect(resolveFactoryPlanningSettings({ workspace: configuredWorkspace }, "/")).toMatchObject({
    workspace: configuredWorkspace,
    maxReviewIterations: 5,
  });

  const defaultWorkspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  expect(resolveFactoryPlanningSettings({ workspace: defaultWorkspace }, "/")).toMatchObject({
    workspace: defaultWorkspace,
    maxReviewIterations: 3,
  });
});

test("implementation review settings honor CLI, config, and default precedence", () => {
  const configuredWorkspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(configuredWorkspace, {
    factory: { implementation: { maxReviewIterations: 7 } },
  });
  expect(
    resolveFactoryImplementationSettings({ workspace: configuredWorkspace }, "/"),
  ).toMatchObject({
    maxReviewIterations: 7,
    source: "config",
  });
  expect(
    resolveFactoryImplementationSettings(
      { workspace: configuredWorkspace, maxReviewIterations: "2" },
      "/",
    ),
  ).toMatchObject({ maxReviewIterations: 2, source: "cli" });

  const defaultWorkspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  expect(resolveFactoryImplementationSettings({ workspace: defaultWorkspace }, "/")).toMatchObject({
    maxReviewIterations: 3,
    source: "default",
  });
});

test("implementation review settings enforce positive integers and secure reviewer policy", () => {
  expect(parsePositiveIntegerOption(1)).toBe(1);
  expect(parsePositiveIntegerOption("9")).toBe(9);
  expect(() => parsePositiveIntegerOption(0)).toThrow(/positive integer/);
  expect(() => parsePositiveIntegerOption("1.5")).toThrow(/positive integer/);

  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    agents: {
      codex: { model: "gpt-config", sandboxMode: "workspace-write", approvalPolicy: "on-request" },
    },
    factory: {
      implementation: {
        roles: {
          reviewer: {
            agent: "codex",
            model: "gpt-review",
            sandboxMode: "read-only",
            approvalPolicy: "never",
          },
        },
      },
    },
  });
  expect(resolveFactoryImplementationReviewer({ workspace }, "/")).toMatchObject({
    agent: "codex",
    model: "gpt-review",
    sandboxMode: "read-only",
    approvalPolicy: "never",
  });
});

test("resolveFactoryLinearSettings reads configured Linear tracker mapping", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    factory: {
      linear: {
        teamKey: "ENG",
        projectId: "00000000-0000-4000-8000-000000000001",
        statuses: LINEAR_STATUSES,
      },
    },
  });

  expect(resolveFactoryLinearSettings({ workspace }, "/")).toEqual({
    workspace,
    teamKey: "ENG",
    projectId: "00000000-0000-4000-8000-000000000001",
    statuses: LINEAR_STATUSES,
  });
});

test("resolveFactoryLinearSettings keeps projectId optional", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    factory: {
      linear: {
        teamKey: "ENG",
        statuses: LINEAR_STATUSES,
      },
    },
  });

  expect(resolveFactoryLinearSettings({ workspace }, "/")).toEqual({
    workspace,
    teamKey: "ENG",
    statuses: LINEAR_STATUSES,
  });
});

test("resolveFactoryLinearSettings allows omitting optional terminal statuses", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  const { done: _done, canceled: _canceled, duplicate: _duplicate, ...required } = LINEAR_STATUSES;
  writeHarnessJson(workspace, {
    factory: {
      linear: {
        teamKey: "ENG",
        statuses: required,
      },
    },
  });

  expect(resolveFactoryLinearSettings({ workspace }, "/")).toEqual({
    workspace,
    teamKey: "ENG",
    statuses: required,
  });
});

test("resolveFactoryLinearSettings requires explicit Linear config", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  expect(() => resolveFactoryLinearSettings({ workspace }, "/")).toThrow(
    /factory\.linear is required/,
  );
});

test("resolveFactoryLinearSettings reports the implementation status migration", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  const {
    implementing: _implementing,
    implementationFailed: _implementationFailed,
    ...legacyStatuses
  } = LINEAR_STATUSES;
  writeHarnessJson(workspace, {
    factory: {
      linear: {
        teamKey: "ENG",
        statuses: legacyStatuses,
      },
    },
  });

  expect(() => resolveFactoryLinearSettings({ workspace }, "/")).toThrow(
    /Missing required Linear implementation status mappings: factory\.linear\.statuses\.implementationFailed, factory\.linear\.statuses\.implementing.*add both mappings to harness\.json/,
  );
});

test.each([
  ["implementing", /factory\.linear\.statuses\.implementing/],
  ["implementationFailed", /factory\.linear\.statuses\.implementationFailed/],
] as const)("resolveFactoryLinearSettings reports a missing %s mapping", (key, expected) => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  const statuses = { ...LINEAR_STATUSES };
  delete statuses[key];
  writeHarnessJson(workspace, { factory: { linear: { teamKey: "ENG", statuses } } });

  expect(() => resolveFactoryLinearSettings({ workspace }, "/")).toThrow(expected);
});

test("implementation status migration does not hide unrelated config errors", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  const {
    implementing: _implementing,
    implementationFailed: _implementationFailed,
    ...legacyStatuses
  } = LINEAR_STATUSES;
  writeHarnessJson(workspace, {
    base: 123,
    factory: { linear: { teamKey: "ENG", statuses: legacyStatuses } },
  });

  expect(() => resolveFactoryLinearSettings({ workspace }, "/")).toThrow(
    /base: Invalid input: expected string, received number/,
  );
});

test("implementation status migration does not mask a malformed implementation mapping", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  const { implementationFailed: _implementationFailed, ...statuses } = LINEAR_STATUSES;
  writeHarnessJson(workspace, {
    factory: { linear: { teamKey: "ENG", statuses: { ...statuses, implementing: "" } } },
  });

  expect(() => resolveFactoryLinearSettings({ workspace }, "/")).toThrow(
    /factory\.linear\.statuses\.implementing: Too small/,
  );
});

test("resolveFactoryRoleAgent defaults Codex planning planner to workspace-write", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    defaultAgent: "codex",
    agents: {
      codex: {
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
    },
    factory: {
      planning: {
        roles: {
          planner: { agent: "codex" },
          reviewer: { agent: "codex" },
        },
      },
    },
  });

  expect(
    resolveFactoryRoleAgent({ workspace, station: "planning", role: "planner" }, "/"),
  ).toMatchObject({
    agent: "codex",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  expect(
    resolveFactoryRoleAgent({ workspace, station: "planning", role: "reviewer" }, "/"),
  ).toMatchObject({
    agent: "codex",
    sandboxMode: "read-only",
    approvalPolicy: "never",
  });
});

test("resolveFactoryRoleAgent resolves missing role entries through fallback", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    defaultAgent: "cursor",
    factory: {
      planning: {
        roles: {
          reviewer: { agent: "codex", model: "gpt-review" },
        },
      },
    },
  });

  expect(
    resolveFactoryRoleAgent({ workspace, station: "planning", role: "planner" }, "/"),
  ).toMatchObject({
    agent: "cursor",
    model: "grok-4.5",
  });
});

test("resolveFactoryRoleAgent defaults Codex implementation implementer to workspace-write", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    defaultAgent: "codex",
    agents: {
      codex: {
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
    },
    factory: {
      implementation: {
        roles: {
          implementer: { agent: "codex" },
        },
      },
    },
  });

  expect(
    resolveFactoryRoleAgent({ workspace, station: "implementation", role: "implementer" }, "/"),
  ).toMatchObject({
    agent: "codex",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
});

test("resolveFactoryRoleAgent preserves Codex implementation role-level sandbox override", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    agents: {
      codex: {
        sandboxMode: "workspace-write",
      },
    },
    factory: {
      implementation: {
        roles: {
          implementer: {
            agent: "codex",
            sandboxMode: "read-only",
          },
        },
      },
    },
  });

  expect(
    resolveFactoryRoleAgent({ workspace, station: "implementation", role: "implementer" }, "/"),
  ).toMatchObject({
    agent: "codex",
    sandboxMode: "read-only",
  });
});

test("resolveFactoryRoleAgent reads configured implementation Cursor role", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    defaultAgent: "codex",
    factory: {
      implementation: {
        roles: {
          implementer: { agent: "cursor", model: "gpt-5.6-sol-high" },
        },
      },
    },
  });

  expect(
    resolveFactoryRoleAgent({ workspace, station: "implementation", role: "implementer" }, "/"),
  ).toMatchObject({
    agent: "cursor",
    model: "gpt-5.6-sol-high",
  });
});

test("resolveFactoryRoleAgent preserves Codex implementation role fields", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(workspace, {
    factory: {
      implementation: {
        roles: {
          implementer: {
            agent: "codex",
            model: "gpt-implementation",
            executable: "/opt/codex",
            sandboxMode: "workspace-write",
            approvalPolicy: "on-request",
            modelReasoningEffort: "xhigh",
          },
        },
      },
    },
  });

  expect(
    resolveFactoryRoleAgent({ workspace, station: "implementation", role: "implementer" }, "/"),
  ).toMatchObject({
    agent: "codex",
    model: "gpt-implementation",
    codexPathOverride: "/opt/codex",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelReasoningEffort: "xhigh",
  });
});

test("factory config rejects unknown station, role, and role fields", () => {
  const cases = [
    [{ factory: { deployment: {} } }, /factory: Unrecognized key/],
    [
      { factory: { triage: { roles: { reviewer: {} } } } },
      /factory\.triage\.roles: Unrecognized key/,
    ],
    [
      { factory: { planning: { roles: { reviwer: {} } } } },
      /factory\.planning\.roles: Unrecognized key/,
    ],
    [
      { factory: { triage: { roles: { triager: { temperature: 0 } } } } },
      /factory\.triage\.roles\.triager: Unrecognized key/,
    ],
    [
      { factory: { linear: { teamKey: "ENG", statuses: LINEAR_STATUSES, labels: {} } } },
      /factory\.linear: Unrecognized key/,
    ],
    [
      {
        factory: { linear: { teamKey: "ENG", projectId: "not-a-uuid", statuses: LINEAR_STATUSES } },
      },
      /factory\.linear\.projectId/,
    ],
    [
      {
        factory: {
          linear: {
            teamKey: "ENG",
            statuses: { ...LINEAR_STATUSES, planApproved: "Plan Approved" },
          },
        },
      },
      /factory\.linear\.statuses: Unrecognized key/,
    ],
  ] as const;

  for (const [config, pattern] of cases) {
    const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
    writeHarnessJson(workspace, config);
    expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(pattern);
  }
});

test("factory config rejects Codex-only fields on effective Cursor roles", () => {
  const cases = [
    {
      defaultAgent: "cursor",
      factory: {
        triage: { roles: { triager: { agent: "cursor", modelReasoningEffort: "high" } } },
      },
    },
    {
      defaultAgent: "cursor",
      factory: { planning: { roles: { reviewer: { sandboxMode: "read-only" } } } },
    },
    {
      factory: { planning: { roles: { planner: { approvalPolicy: "never" } } } },
    },
    {
      defaultAgent: "cursor",
      factory: { implementation: { roles: { implementer: { sandboxMode: "workspace-write" } } } },
    },
  ];

  for (const config of cases) {
    const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
    writeHarnessJson(workspace, config);
    expect(() => resolveHarnessOptions({ workspace }, "/")).toThrow(
      /applies only when role agent is codex/,
    );
  }
});

test("factory config rejects unsupported Cursor models and keeps Codex models permissive", () => {
  const cursorWorkspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(cursorWorkspace, {
    factory: { triage: { roles: { triager: { agent: "cursor", model: "unknown-cursor" } } } },
  });
  expect(() => resolveHarnessOptions({ workspace: cursorWorkspace }, "/")).toThrow(
    /Unsupported Cursor model: unknown-cursor/,
  );

  const codexWorkspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeHarnessJson(codexWorkspace, {
    factory: { planning: { roles: { reviewer: { agent: "codex", model: "future-codex" } } } },
  });
  expect(
    resolveFactoryRoleAgent(
      { workspace: codexWorkspace, station: "planning", role: "reviewer" },
      "/",
    ),
  ).toMatchObject({
    agent: "codex",
    model: "future-codex",
  });
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
