import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { CURSOR_SDK_MODEL_MODES } from "../lib/agents.ts";
import {
  HARNESS_GITIGNORE_ENTRY,
  HARNESS_RECOMMENDED_COMMAND,
  HARNESS_SHIM_RELATIVE_PATH,
} from "../lib/config.ts";
import {
  fetchFactoryLinearWorkItem,
  createFactoryLinearWorkItem,
} from "../bin/factory-commands.ts";
import {
  appendFactoryLifecycleEvent,
  factoryLifecycleStatePath,
  loadFactoryLifecycleState,
} from "../lib/factory-lifecycle.ts";
import { resolveFactoryStore } from "../lib/factory-store.ts";
import {
  fakeLinearAdapter,
  LINEAR_SETTINGS,
  LINEAR_WORK_ITEM,
} from "./factory-linear-test-helpers.ts";
import { parseFactoryRunStartedProgress } from "./factory-run-started-test-helpers.ts";
import { runFactoryHarness } from "./factory-store-test-helpers.ts";
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS_BIN = join(REPO_ROOT, "bin/harness.ts");

function runHarness(
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  if (args[0] === "factory") {
    return runFactoryHarness({
      bin: HARNESS_BIN,
      args,
      cwd: options.cwd,
      input: options.input,
      env: options.env,
    }).result;
  }
  return spawnSync(process.execPath, [HARNESS_BIN, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

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

function createPlainWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cli-"));
  writeFileSync(join(workspace, "plan.md"), "# Plan\n\nReview me.\n", "utf8");
  return workspace;
}

function seedMissingLifecycleProjection(input: {
  workspace: string;
  storeRoot: string;
  id: string;
  source: "file" | "linear";
  title: string;
}) {
  const store = resolveFactoryStore({
    workspace: input.workspace,
    factoryStoreRoot: input.storeRoot,
    env: {},
  });
  const workItemKey = `${input.source}:${input.id}`;
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: "2026-07-09T00:00:00.000Z",
      source: "harness",
      data: { source: input.source, title: input.title },
    },
  });
  rmSync(factoryLifecycleStatePath(store.factoryStateRoot, workItemKey));
  rmSync(join(store.factoryStateRoot, "locks"), { recursive: true, force: true });
  return store;
}

function writeLinearConfig(workspace: string): void {
  writeFileSync(
    join(workspace, "harness.json"),
    JSON.stringify(
      {
        factory: {
          linear: {
            teamKey: "ENG",
            statuses: {
              intake: "Backlog",
              parked: "Parked",
              needsInfo: "Needs Clarification",
              needsPlanReview: "Plan Needs Review",
              needsPlan: "Needs Plan",
              readyToImplement: "Ready to Implement",
              triaging: "Triaging",
              planning: "Planning",
              triageFailed: "Triage Failed",
              planningFailed: "Planning Failed",
              done: "Done",
              canceled: "Canceled",
              duplicate: "Duplicate",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function createFactoryPlanningPublicationRun() {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cli-planning-publication-workspace-"));
  const runDir = mkdtempSync(join(tmpdir(), "harness-cli-planning-publication-run-"));
  const meta = {
    runId: "20260707-120000",
    workflow: "factory-planning",
    status: "plan-approved",
    workspace,
    runDir,
    workItem: { id: "linear:ENG-123", source: "linear", title: "Linear issue" },
    outputPlan: join(workspace, "dev/plans/ENG-123.md"),
    factoryMetadata: {
      tracker: { source: "linear", id: "ENG-123" },
      factoryStage: "plan-pr-open",
      approvedPlanPath: "dev/plans/ENG-123.md",
    },
    iterations: [{ index: 1 }],
    plannerAgent: { name: "cursor", model: "composer-2.5" },
    reviewerAgent: { name: "cursor", model: "composer-2.5" },
    summaryPath: join(runDir, "summary.md"),
    metaPath: join(runDir, "meta.json"),
    startedAt: "2026-07-07T12:00:00.000Z",
    durationMs: 1,
  };
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  writeFileSync(join(runDir, "summary.md"), "# Old Summary\n", "utf8");
  return { workspace, runDir };
}

function expectInitShim(
  workspace: string,
  output: Record<string, unknown>,
  expectedUpdated = true,
) {
  expect(typeof output.shimPath).toBe("string");
  const shimPath = output.shimPath as string;
  const expectedShimPath = join(workspace, HARNESS_SHIM_RELATIVE_PATH);
  expect(output.shimUpdated).toBe(expectedUpdated);
  expect(realpathSync(shimPath)).toBe(realpathSync(expectedShimPath));
  expect(output.recommendedCommand).toBe(HARNESS_RECOMMENDED_COMMAND);
  expect(readFileSync(shimPath, "utf8")).toContain(HARNESS_BIN);
  const shimHelp = spawnSync(shimPath, ["--help"], { cwd: workspace, encoding: "utf8" });
  expect(shimHelp.status).toBe(0);
  expect(shimHelp.stdout).toMatch(/Usage: harness/);
}

function expectIndependentReviewPrompts(...prompts: string[]) {
  for (const prompt of prompts) {
    expect(prompt).not.toMatch(/Prior implementation review file/);
    expect(prompt).not.toMatch(/Prior code quality review file/);
    expect(prompt).not.toMatch(/PRIOR_REVIEW_SECTION/);
  }
}

function writeRun(
  runsDir: string,
  runId: string,
  metadata?: { startedAt?: string; status?: string },
): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  if (metadata) {
    writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }
  return runDir;
}

test("harness init creates config through the CLI", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(["init", "--workspace", workspace, "--base", "develop"]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.configCreated).toBe(true);
  expect(output.gitignoreUpdated).toBe(true);
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "develop"\n}\n');
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(`${HARNESS_GITIGNORE_ENTRY}\n`);
  expectInitShim(workspace, output);
  expect(existsSync(join(workspace, ".agents/skills/change-review-workflow"))).toBe(false);
});
test("harness init resolves workspace from nested cwd", () => {
  const workspace = createGitWorkspace();
  const nested = join(workspace, "packages/app");
  mkdirSync(nested, { recursive: true });
  const result = runHarness(["init"], { cwd: nested });
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.configCreated).toBe(true);
  expect(output.gitignoreUpdated).toBe(true);
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "main"\n}\n');
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(`${HARNESS_GITIGNORE_ENTRY}\n`);
  expectInitShim(workspace, output);
});
test("harness init is idempotent through the CLI", () => {
  const workspace = createGitWorkspace();
  const first = runHarness(["init", "--workspace", workspace]);
  expect(first.status).toBe(0);
  const result = runHarness(["init", "--workspace", workspace]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.configCreated).toBe(false);
  expect(output.gitignoreUpdated).toBe(false);
  expectInitShim(workspace, output, false);
});
test("harness init does not report base skipped unless base was passed", () => {
  const workspace = createGitWorkspace();
  writeFileSync(join(workspace, "harness.json"), '{\n  "base": "develop"\n}\n', "utf8");
  const result = runHarness(["init", "--workspace", workspace]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.configCreated).toBe(false);
  expect(output.baseSkipped).toBe(false);
});
test("harness init works with explicit non-git workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cli-"));
  const result = runHarness(["init", "--workspace", workspace]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(readFileSync(join(workspace, "harness.json"), "utf8")).toBe('{\n  "base": "main"\n}\n');
  expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(`${HARNESS_GITIGNORE_ENTRY}\n`);
  expectInitShim(workspace, output);
});
test("harness root help exits cleanly", () => {
  const result = runHarness(["--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Usage: harness/);
  expect(result.stdout).toMatch(/init/);
  expect(result.stdout).toMatch(/run/);
  expect(result.stdout).toMatch(/runs/);
  expect(result.stdout).toMatch(/skills/);
});
test("harness models prints provider model defaults", () => {
  const result = runHarness(["models"]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.cursor.defaultModel).toBe("composer-2.5");
  expect(output.cursor.models).toEqual([...CURSOR_SDK_MODEL_MODES]);
  expect(output.cursor.modelsNote).toMatch(/Fixed Cursor SDK review modes/);
  expect(output.cursor.liveListCommand).toBeUndefined();
  expect(output.codex.defaultModel).toBe("gpt-5.5");
  expect(output.codex.defaultReasoningEffort).toBe("high");
  expect(output.codex.reasoningEfforts).toContain("xhigh");
});
test("harness init help exits cleanly", () => {
  const result = runHarness(["init", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Usage: harness init/);
  expect(result.stdout).toMatch(/local shim/);
  expect(result.stdout).toMatch(/--workspace/);
  expect(result.stdout).toMatch(/--base/);
});
test("harness without a subcommand exits with help and failure", () => {
  const result = runHarness([]);
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/Usage: harness/);
});
test("harness run change-review help exits cleanly", () => {
  const result = runHarness(["run", "change-review", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness run change-review/);
  expect(result.stdout).toMatch(/--handoff-stdin/);
  expect(result.stdout).not.toMatch(/--runtime/);
  expect(result.stdout).not.toMatch(/--cursor-wrapper/);
  expect(result.stdout).toMatch(/--steps/);
  expect(result.stdout).toMatch(/--dry-run/);
  expect(result.stdout).toMatch(/--verbose/);
});
test("harness run factory-triage help exposes item-only options", () => {
  const result = runHarness(["run", "factory-triage", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness run factory-triage/);
  expect(result.stdout).toMatch(/--item-file <path>/);
  expect(result.stdout).toMatch(/--dry-run/);
  expect(result.stdout).not.toMatch(/--linear-issue/);
  expect(result.stdout).not.toMatch(/--base/);
  expect(result.stdout).not.toMatch(/--head/);
  expect(result.stdout).not.toMatch(/--plan/);
  expect(result.stdout).not.toMatch(/--handoff/);
  expect(result.stdout).not.toMatch(/--steps/);
});
test("harness factory help exits cleanly", () => {
  const result = runHarness(["factory", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Usage: harness factory/);
  expect(result.stdout).toMatch(/status/);
  expect(result.stdout).toMatch(/linear/);
  expect(result.stdout).toMatch(/triage/);
  expect(result.stdout).toMatch(/planning/);
  expect(result.stdout).not.toMatch(/dispatch/);
});
test("harness factory linear help exits cleanly", () => {
  const result = runHarness(["factory", "linear", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness factory linear/);
  expect(result.stdout).toMatch(/list/);
  expect(result.stdout).toMatch(/fetch/);
  expect(result.stdout).toMatch(/create/);
});
test("harness factory linear list help exits cleanly", () => {
  const result = runHarness(["factory", "linear", "list", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness factory linear list/);
  expect(result.stdout).toMatch(/--status/);
  expect(result.stdout).toMatch(/--first/);
  expect(result.stdout).toMatch(/--after/);
  expect(result.stdout).toMatch(/--all/);
  expect(result.stdout).toMatch(/--workspace/);
});
test("harness factory linear fetch help exits cleanly", () => {
  const result = runHarness(["factory", "linear", "fetch", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness factory linear fetch/);
  expect(result.stdout).toMatch(/TEAM-123/);
  expect(result.stdout).toMatch(/--workspace/);
});
test("harness factory linear create help exits cleanly", () => {
  const result = runHarness(["factory", "linear", "create", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness factory linear create/);
  expect(result.stdout).toMatch(/--workspace/);
  expect(result.stdout).toMatch(/--title/);
  expect(result.stdout).toMatch(/--body/);
  expect(result.stdout).toMatch(/--body-file/);
  expect(result.stdout).not.toMatch(/--dry-run/);
  expect(result.stdout).not.toMatch(/--apply/);
});
test("harness factory linear list requires a status", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(["factory", "linear", "list", "--workspace", workspace]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--status is required/);
});
test("harness factory linear list requires Linear config", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    ["factory", "linear", "list", "--status", "intake", "--workspace", workspace],
    {
      env: { LINEAR_API_KEY: "test-key" },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/factory\.linear is required/);
});
test("harness factory linear list requires a Linear API key", () => {
  const workspace = createGitWorkspace();
  writeLinearConfig(workspace);
  const result = runHarness(
    ["factory", "linear", "list", "--status", "intake", "--workspace", workspace],
    {
      env: { LINEAR_API_KEY: "" },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/LINEAR_API_KEY is required/);
});
test("harness factory linear list rejects all-pages with an after cursor", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "factory",
    "linear",
    "list",
    "--status",
    "intake",
    "--all",
    "--after",
    "cursor-1",
    "--workspace",
    workspace,
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--all cannot be combined with --after/);
  expect(result.stderr).not.toMatch(/factory\.linear is required/);
  expect(result.stderr).not.toMatch(/LINEAR_API_KEY is required/);
});
test("harness factory linear fetch requires Linear config", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(["factory", "linear", "fetch", "ENG-123", "--workspace", workspace], {
    env: { LINEAR_API_KEY: "test-key" },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/factory\.linear is required/);
});
test("harness factory linear fetch requires a Linear API key", () => {
  const workspace = createGitWorkspace();
  writeLinearConfig(workspace);
  const result = runHarness(["factory", "linear", "fetch", "ENG-123", "--workspace", workspace], {
    env: { LINEAR_API_KEY: "" },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/LINEAR_API_KEY is required/);
});
test("harness factory linear create requires Linear config", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    [
      "factory",
      "linear",
      "create",
      "--title",
      "Example",
      "--body",
      "Body",
      "--workspace",
      workspace,
    ],
    {
      env: { LINEAR_API_KEY: "test-key" },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/factory\.linear is required/);
});
test("harness factory linear create requires a Linear API key", () => {
  const workspace = createGitWorkspace();
  writeLinearConfig(workspace);
  const result = runHarness(
    [
      "factory",
      "linear",
      "create",
      "--title",
      "Example",
      "--body",
      "Body",
      "--workspace",
      workspace,
    ],
    {
      env: { LINEAR_API_KEY: "" },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/LINEAR_API_KEY is required/);
});
test("harness factory linear create requires factory.linear.projectId", async () => {
  let createCalled = false;
  const { createLinearFactoryAdapterForClient } = await import("../lib/factory-linear-adapter.ts");
  await expect(
    createFactoryLinearWorkItem({
      title: "Example",
      body: "Body",
      env: { LINEAR_API_KEY: "test-key" },
      resolveLinearSettings: () => LINEAR_SETTINGS,
      adapterFactory: ({ settings }) =>
        createLinearFactoryAdapterForClient({
          client: {
            issue: async () => {
              throw new Error("issue should not run");
            },
            issues: async () => ({ nodes: [] }),
            teams: async () => ({ nodes: [] }),
            createIssue: async () => {
              createCalled = true;
              throw new Error("createIssue should not run");
            },
            updateIssue: async () => ({ success: true }),
            createComment: async () => ({ success: true }),
          },
          settings,
        }),
    }),
  ).rejects.toThrow(/factory\.linear\.projectId is required for Linear create/);
  expect(createCalled).toBe(false);
});
test("harness factory linear create rejects body and body-file together before config checks", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "factory",
    "linear",
    "create",
    "--title",
    "Example",
    "--body",
    "Body",
    "--body-file",
    "body.md",
    "--workspace",
    workspace,
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--body and --body-file are mutually exclusive/);
  expect(result.stderr).not.toMatch(/factory\.linear is required/);
  expect(result.stderr).not.toMatch(/LINEAR_API_KEY is required/);
});
test("harness factory linear create rejects missing body sources before config checks", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "factory",
    "linear",
    "create",
    "--title",
    "Example",
    "--workspace",
    workspace,
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/one of --body, --body-file, or stdin is required/);
  expect(result.stderr).not.toMatch(/factory\.linear is required/);
  expect(result.stderr).not.toMatch(/LINEAR_API_KEY is required/);
});
test("createFactoryLinearWorkItem rejects whitespace title or body before mutation", async () => {
  let createCalled = false;
  await expect(
    createFactoryLinearWorkItem({
      title: "   ",
      body: "Body",
      env: { LINEAR_API_KEY: "test-key" },
      resolveLinearSettings: () => ({ ...LINEAR_SETTINGS, projectId: "project-1" }),
      adapterFactory: () =>
        fakeLinearAdapter({
          createWorkItem: async () => {
            createCalled = true;
            throw new Error("createWorkItem should not run");
          },
        }),
    }),
  ).rejects.toThrow(/Linear create title must be non-empty/);
  await expect(
    createFactoryLinearWorkItem({
      title: "Title",
      body: "  \n",
      env: { LINEAR_API_KEY: "test-key" },
      resolveLinearSettings: () => ({ ...LINEAR_SETTINGS, projectId: "project-1" }),
      adapterFactory: () =>
        fakeLinearAdapter({
          createWorkItem: async () => {
            createCalled = true;
            throw new Error("createWorkItem should not run");
          },
        }),
    }),
  ).rejects.toThrow(/Linear create body must be non-empty/);
  expect(createCalled).toBe(false);
});
test("createFactoryLinearWorkItem returns compact JSON for inline, file, and stdin bodies", async () => {
  const workspace = createPlainWorkspace();
  writeFileSync(join(workspace, "body.md"), "File body content\n", "utf8");
  const created = {
    identifier: "ENG-124",
    url: "https://linear.app/acme/issue/ENG-124/example",
    id: "linear:ENG-124",
  };
  const calls: Array<{ title: string; body: string }> = [];
  const adapterFactory = () =>
    fakeLinearAdapter({
      createWorkItem: async (input) => {
        calls.push(input);
        return created;
      },
    });
  const settings = { ...LINEAR_SETTINGS, projectId: "project-1" };

  await expect(
    createFactoryLinearWorkItem({
      workspace,
      title: "Inline",
      body: "Inline body",
      env: { LINEAR_API_KEY: "test-key" },
      resolveLinearSettings: () => settings,
      adapterFactory,
    }),
  ).resolves.toEqual(created);

  await expect(
    createFactoryLinearWorkItem({
      workspace,
      title: "File",
      bodyFile: "body.md",
      env: { LINEAR_API_KEY: "test-key" },
      resolveLinearSettings: () => settings,
      adapterFactory,
    }),
  ).resolves.toEqual(created);

  const { Readable } = await import("node:stream");
  await expect(
    createFactoryLinearWorkItem({
      workspace,
      title: "Stdin",
      env: { LINEAR_API_KEY: "test-key" },
      stdin: Readable.from(["Stdin body"]),
      resolveLinearSettings: () => settings,
      adapterFactory,
    }),
  ).resolves.toEqual(created);

  expect(calls).toEqual([
    { title: "Inline", body: "Inline body" },
    { title: "File", body: "File body content" },
    { title: "Stdin", body: "Stdin body" },
  ]);
});
test("harness factory linear fetch overlays seeded lifecycle state", async () => {
  const workspace = createPlainWorkspace();
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-cli-fetch-store-"));
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: "work_item.imported:linear:ENG-123",
      type: "work_item.imported",
      workItemKey: "linear:ENG-123",
      occurredAt: "2026-07-08T00:00:00.000Z",
      source: "harness",
      data: {
        source: "linear",
        title: "Linear issue",
        tracker: { source: "linear", id: "ENG-123" },
      },
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: "triage.completed:triage-run-1",
      type: "triage.completed",
      workItemKey: "linear:ENG-123",
      occurredAt: "2026-07-08T00:01:00.000Z",
      runId: "triage-run-1",
      source: "harness",
      data: {
        route: "ready-to-plan",
        nextAction: "create-plan",
        rationale: "Requires a plan.",
        routeArtifactPath: "factory-route.md",
        triageArtifactPath: "factory-triage.json",
      },
    },
  });

  const workItem = await fetchFactoryLinearWorkItem({
    issue: "ENG-123",
    workspace,
    factoryStateRoot,
    env: { LINEAR_API_KEY: "test-key" },
    resolveLinearSettings: () => LINEAR_SETTINGS,
    adapterFactory: () =>
      fakeLinearAdapter({
        fetchWorkItem: async () => ({
          ...LINEAR_WORK_ITEM,
          metadata: {
            ...LINEAR_WORK_ITEM.metadata,
            factoryStage: "incoming",
            factoryRoute: "needs-info",
            factoryNextAction: "ask-human",
          },
        }),
      }),
  });

  expect(workItem.metadata).toMatchObject({
    factoryStage: "ready-to-plan",
    factoryRoute: "ready-to-plan",
    factoryNextAction: "create-plan",
    factoryRunId: "triage-run-1",
  });
});
test("harness factory status help exits cleanly", () => {
  const result = runHarness(["factory", "status", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness factory status/);
  expect(result.stdout).toMatch(/--inbox-dir/);
});
test("harness factory triage help exits cleanly without direct agent flags", () => {
  const result = runHarness(["factory", "triage", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness factory triage/);
  expect(result.stdout).toMatch(/--item-file <path>/);
  expect(result.stdout).toMatch(/--linear-issue <issue>/);
  expect(result.stdout).toMatch(/--apply/);
  expect(result.stdout).toMatch(/--dry-run/);
  expect(result.stdout).not.toMatch(/--agent/);
  expect(result.stdout).not.toMatch(/--model/);
  expect(result.stdout).not.toMatch(/--codex-executable/);
  expect(result.stdout).not.toMatch(/--sandbox/);
  expect(result.stdout).not.toMatch(/--approval-policy/);
  expect(result.stdout).not.toMatch(/--reasoning-effort/);
});
test("harness factory planning help exits cleanly without direct agent flags", () => {
  const result = runHarness(["factory", "planning", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness factory planning/);
  expect(result.stdout).toMatch(/run/);
  expect(result.stdout).toMatch(/publish/);
  expect(result.stdout).toMatch(/mark-plan-merged/);
  expect(result.stdout).not.toMatch(/--agent/);
  expect(result.stdout).not.toMatch(/--model/);
  expect(result.stdout).not.toMatch(/--codex-executable/);
  expect(result.stdout).not.toMatch(/--sandbox/);
  expect(result.stdout).not.toMatch(/--approval-policy/);
  expect(result.stdout).not.toMatch(/--reasoning-effort/);
});
test("harness factory planning run help exits cleanly without direct agent flags", () => {
  const result = runHarness(["factory", "planning", "run", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness factory planning run/);
  expect(result.stdout).toMatch(/--item-file <path>/);
  expect(result.stdout).toMatch(/--linear-issue <issue>/);
  expect(result.stdout).toMatch(/--output-plan <path>/);
  expect(result.stdout).toMatch(/--max-review-iterations <count>/);
  expect(result.stdout).toMatch(/--apply/);
  expect(result.stdout).toMatch(/--dry-run/);
  expect(result.stdout).not.toMatch(/--agent/);
  expect(result.stdout).not.toMatch(/--model/);
  expect(result.stdout).not.toMatch(/--codex-executable/);
  expect(result.stdout).not.toMatch(/--sandbox/);
  expect(result.stdout).not.toMatch(/--approval-policy/);
  expect(result.stdout).not.toMatch(/--reasoning-effort/);
});
test("harness factory planning publication help exits cleanly", () => {
  const publish = runHarness(["factory", "planning", "publish", "--help"]);
  expect(publish.status).toBe(0);
  expect(publish.stdout).toMatch(/harness factory planning publish/);
  expect(publish.stdout).toMatch(/--run-dir <path>/);
  expect(publish.stdout).toMatch(/--pr-url <url>/);
  expect(publish.stdout).toMatch(/--linear-issue <issue>/);
  expect(publish.stdout).toMatch(/--apply/);

  const merged = runHarness(["factory", "planning", "mark-plan-merged", "--help"]);
  expect(merged.status).toBe(0);
  expect(merged.stdout).toMatch(/harness factory planning mark-plan-merged/);
  expect(merged.stdout).toMatch(/--run-dir <path>/);
  expect(merged.stdout).toMatch(/--commit <sha>/);
  expect(merged.stdout).toMatch(/--linear-issue <issue>/);
  expect(merged.stdout).toMatch(/--apply/);
});
test("harness run factory-planning is not a command", () => {
  const result = runHarness(["run", "factory-planning"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/unknown command.*factory-planning/i);
});
test("harness factory dispatch is not a command", () => {
  const result = runHarness(["factory", "dispatch"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/unknown command.*dispatch/i);

  const help = runHarness(["factory", "dispatch", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).not.toMatch(/factory dispatch/);
});
test("harness run rejects removed review commands", () => {
  for (const workflow of ["review", "review-full"]) {
    const result = runHarness(["run", workflow]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(new RegExp(`unknown command.*${workflow}`, "i"));
  }
});
test("harness runs help exits cleanly", () => {
  const result = runHarness(["runs", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Usage: harness runs/);
  expect(result.stdout).toMatch(/prune/);
});
test("harness runs prune help exits cleanly", () => {
  const result = runHarness(["runs", "prune", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness runs prune/);
  expect(result.stdout).toMatch(/--older-than/);
  expect(result.stdout).toMatch(/--dry-run/);
  expect(result.stdout).toMatch(/--runs-dir/);
  expect(result.stdout).toMatch(/--workspace/);
});
test("harness skills install help exits cleanly", () => {
  const result = runHarness(["skills", "install", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness skills install/);
  expect(result.stdout).toMatch(/--workspace/);
  expect(result.stdout).toMatch(/--force/);
  expect(result.stdout).toMatch(/--dry-run/);
});
test("harness skills install copies a packaged skill into the workspace", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "skills",
    "install",
    "change-review-workflow",
    "--workspace",
    workspace,
  ]);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  const skillPath = join(workspace, ".agents/skills/change-review-workflow/SKILL.md");
  const metadataPath = join(workspace, ".agents/skills/change-review-workflow/agents/openai.yaml");
  const handoffPath = join(
    workspace,
    ".agents/skills/change-review-workflow/references/review-handoff.md",
  );
  expect(output).toMatchObject({
    workspace,
    skill: "change-review-workflow",
    targetPath: join(workspace, ".agents/skills/change-review-workflow"),
    status: "installed",
  });
  expect(readFileSync(skillPath, "utf8")).toContain("name: change-review-workflow");
  expect(readFileSync(metadataPath, "utf8")).toContain("Change Review Workflow");
  expect(readFileSync(handoffPath, "utf8")).toContain("## Template");
});
test("harness skills install skips existing local skills unless forced", () => {
  const workspace = createGitWorkspace();
  const skillPath = join(workspace, ".agents/skills/change-review-workflow/SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, "# Custom local skill\n", "utf8");

  const skipped = runHarness([
    "skills",
    "install",
    "change-review-workflow",
    "--workspace",
    workspace,
  ]);
  expect(skipped.status).toBe(0);
  expect(JSON.parse(skipped.stdout).status).toBe("skipped");
  expect(readFileSync(skillPath, "utf8")).toBe("# Custom local skill\n");

  const forced = runHarness([
    "skills",
    "install",
    "change-review-workflow",
    "--workspace",
    workspace,
    "--force",
  ]);
  expect(forced.status).toBe(0);
  expect(JSON.parse(forced.stdout).status).toBe("installed");
  expect(readFileSync(skillPath, "utf8")).toContain("name: change-review-workflow");
});
test("harness skills install previews forced overwrites without writing", () => {
  const workspace = createGitWorkspace();
  const skillPath = join(workspace, ".agents/skills/change-review-workflow/SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, "# Custom local skill\n", "utf8");

  const result = runHarness([
    "skills",
    "install",
    "change-review-workflow",
    "--workspace",
    workspace,
    "--dry-run",
    "--force",
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe("would_overwrite");
  expect(readFileSync(skillPath, "utf8")).toBe("# Custom local skill\n");
});
test("harness skills install dry-run does not write files", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "skills",
    "install",
    "change-review-workflow",
    "--workspace",
    workspace,
    "--dry-run",
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe("would_install");
  expect(existsSync(join(workspace, ".agents/skills/change-review-workflow"))).toBe(false);
});
test("harness skills install rejects unsafe skill names", () => {
  const workspace = createGitWorkspace();

  for (const skillName of ["../change-review-workflow", "nested/skill", "/tmp/skill"]) {
    const result = runHarness(["skills", "install", skillName, "--workspace", workspace]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid skill name:/);
  }
});
test("harness skills install rejects unknown packaged skills", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(["skills", "install", "missing-skill", "--workspace", workspace]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Packaged skill not found: missing-skill/);
});
test("harness skills install reports runtime errors as exit 1", () => {
  const missingWorkspace = join(mkdtempSync(join(tmpdir(), "harness-cli-")), "missing");
  const result = runHarness([
    "skills",
    "install",
    "change-review-workflow",
    "--workspace",
    missingWorkspace,
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Workspace does not exist/);
});
test("harness init rejects unknown flags", () => {
  const result = runHarness(["init", "--unknown"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/unknown option.*--unknown/i);
});
test("harness init rejects missing option values", () => {
  const result = runHarness(["init", "--workspace"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/argument missing|missing required argument|missing/i);
});
test("harness init reports runtime errors as exit 1", () => {
  const missingWorkspace = join(mkdtempSync(join(tmpdir(), "harness-cli-")), "missing");
  const result = runHarness(["init", "--workspace", missingWorkspace]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Workspace does not exist/);
});
test("harness run change-review rejects unknown flags", () => {
  const result = runHarness(["run", "change-review", "--unknown"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/unknown option.*--unknown/i);
});
test("harness run change-review rejects invalid max-runtime-ms values", () => {
  const result = runHarness(["run", "change-review", "--max-runtime-ms", "0"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/must be a positive number/);
});
test("harness run change-review rejects invalid agent provider values", () => {
  const result = runHarness(["run", "change-review", "--agent", "other"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/must be one of: cursor, codex/);
});
test("harness run change-review rejects removed Cursor CLI flags", () => {
  for (const args of [
    ["--runtime", "sdk"],
    ["--runtime", "cli"],
    ["--cursor-wrapper", "/opt/cursor-cli"],
    ["--cursor-agent", "/opt/cursor-cli"],
  ] as const) {
    const result = runHarness(["run", "change-review", ...args]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown option/i);
  }
});
test("harness run change-review rejects invalid sandbox values", () => {
  const result = runHarness(["run", "change-review", "--sandbox", "loose"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/must be one of: read-only, workspace-write, danger-full-access/);
});
test("harness run change-review rejects invalid approval policy values", () => {
  const result = runHarness(["run", "change-review", "--approval-policy", "always"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/must be one of: never, on-request, on-failure, untrusted/);
});
test("harness run change-review rejects invalid reasoning effort values", () => {
  const result = runHarness(["run", "change-review", "--reasoning-effort", "huge"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/must be one of: minimal, low, medium, high, xhigh/);
});
test("harness run change-review rejects Codex-only policy flags for Cursor", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "run",
    "change-review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--sandbox",
    "read-only",
    "--reasoning-effort",
    "high",
    "--dry-run",
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/apply only when --agent codex is active/);
});
test("harness run change-review rejects Codex executable override for Cursor", () => {
  const workspace = createGitWorkspace();
  writeFileSync(join(workspace, "harness.json"), '{ "defaultAgent": "cursor" }\n', "utf8");

  const result = runHarness([
    "run",
    "change-review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--codex-executable",
    "/opt/codex",
    "--dry-run",
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--codex-executable applies only when --agent codex is active/);
});
test("harness run change-review ignores Codex-only policy config for Cursor", () => {
  const workspace = createGitWorkspace();
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "defaultAgent": "cursor", "agents": { "codex": { "sandboxMode": "read-only" } } }\n',
    "utf8",
  );

  const result = runHarness([
    "run",
    "change-review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--dry-run",
  ]);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.agent).toMatchObject({ name: "cursor", model: "composer-2.5" });
});
test("harness run change-review lets Cursor override Codex policy config", () => {
  const workspace = createGitWorkspace();
  writeFileSync(
    join(workspace, "harness.json"),
    '{ "defaultAgent": "codex", "agents": { "codex": { "sandboxMode": "read-only", "approvalPolicy": "never" } } }\n',
    "utf8",
  );

  const result = runHarness([
    "run",
    "change-review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--agent",
    "cursor",
    "--dry-run",
  ]);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.agent).toMatchObject({ name: "cursor", model: "composer-2.5" });
});
test("harness run change-review rejects invalid steps", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const result = runHarness([
    "run",
    "change-review",
    "--workspace",
    workspace,
    "--runs-dir",
    runsDir,
    "--steps",
    "missing",
    "--dry-run",
  ]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(
    /unknown step: missing\. Valid steps: implementation, quality, simplify/,
  );
  expect(readdirSync(runsDir)).toEqual([]);
});
test("harness run change-review rejects empty steps", () => {
  const result = runHarness(["run", "change-review", "--steps", " , "]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/must include at least one step/);
});
test("harness run change-review rejects multiple handoff inputs", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    [
      "run",
      "change-review",
      "--workspace",
      workspace,
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--handoff",
      "handoff.md",
      "--handoff-stdin",
      "--dry-run",
    ],
    { input: "inline" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Use only one handoff input/);
});
test("harness run change-review rejects empty stdin handoff", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    [
      "run",
      "change-review",
      "--workspace",
      workspace,
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--handoff-stdin",
      "--dry-run",
    ],
    { input: "" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--handoff-stdin requires non-empty stdin/);
});
test("harness run change-review rejects blank stdin handoff", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    [
      "run",
      "change-review",
      "--workspace",
      workspace,
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--handoff-stdin",
      "--dry-run",
    ],
    { input: "  \n\t" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--handoff-stdin requires non-empty stdin/);
});
test("harness run rejects unknown workflows", () => {
  const result = runHarness(["run", "unknown"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/unknown command.*unknown/i);
});
test("harness runs prune rejects invalid durations", () => {
  const result = runHarness(["runs", "prune", "--older-than", "soon"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/invalid duration/i);
});
test("harness runs prune dry-run reports old runs without deleting", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const oldRun = writeRun(runsDir, "20260101-000000-aaaaaa", {
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const recentRun = writeRun(runsDir, "29990101-000000-bbbbbb", {
    status: "completed",
    startedAt: "2999-01-01T00:00:00.000Z",
  });

  const result = runHarness([
    "runs",
    "prune",
    "--workspace",
    workspace,
    "--runs-dir",
    runsDir,
    "--older-than",
    "7d",
    "--dry-run",
  ]);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.matched).toBe(1);
  expect(output.deleted).toBe(0);
  expect(output.kept).toBe(1);
  expect(output.runs).toMatchObject([{ runId: "20260101-000000-aaaaaa", deleted: false }]);
  expect(existsSync(oldRun)).toBe(true);
  expect(existsSync(recentRun)).toBe(true);
});
test("harness runs prune deletes old runs", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const oldRun = writeRun(runsDir, "20260101-000000-aaaaaa", {
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const recentRun = writeRun(runsDir, "29990101-000000-bbbbbb", {
    startedAt: "2999-01-01T00:00:00.000Z",
  });

  const result = runHarness([
    "runs",
    "prune",
    "--workspace",
    workspace,
    "--runs-dir",
    runsDir,
    "--older-than",
    "7d",
  ]);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.matched).toBe(1);
  expect(output.deleted).toBe(1);
  expect(output.kept).toBe(1);
  expect(existsSync(oldRun)).toBe(false);
  expect(existsSync(recentRun)).toBe(true);
});
test("harness runs prune treats missing runs dir as empty", () => {
  const workspace = createGitWorkspace();
  const runsDir = join(mkdtempSync(join(tmpdir(), "harness-runs-")), "missing");

  const result = runHarness([
    "runs",
    "prune",
    "--workspace",
    workspace,
    "--runs-dir",
    runsDir,
    "--older-than",
    "7d",
  ]);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.matched).toBe(0);
  expect(output.deleted).toBe(0);
  expect(output.kept).toBe(0);
  expect(output.skipped).toBe(0);
  expect(output.runs).toEqual([]);
});
test("harness runs prune accepts explicit runs-dir outside a workspace", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-non-workspace-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));

  const result = runHarness(
    ["runs", "prune", "--runs-dir", runsDir, "--older-than", "7d", "--dry-run"],
    {
      cwd,
    },
  );

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.workspace).toBe(realpathSync(cwd));
  expect(output.runsDir).toBe(runsDir);
});
test("harness run change-review dry-run works through the CLI", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "run",
    "change-review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--dry-run",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("dry_run");
  expect(output.agent).toMatchObject({ name: "cursor", model: "composer-2.5" });
  expect(output.workflow).toBe("change-review");
  expect(output.requestedSteps).toEqual(["implementation", "quality", "simplify"]);
  expect(output.partial).toBe(false);
  expect(output.workspace).toBe(workspace);
  expect(output.scope).toMatchObject({ baseRef: "HEAD", headRef: "HEAD" });
  expect(output.prompts.implementation).toMatch(/implementation-review\.prompt\.md$/);
  expect(output.prompts.quality).toMatch(/quality-review\.prompt\.md$/);
  expect(output.prompts.simplify).toMatch(/simplify-review\.prompt\.md$/);
  expect(existsSync(join(output.runDir, "context/diff.patch"))).toBe(true);

  const implementationPrompt = readFileSync(output.prompts.implementation, "utf8");
  const qualityPrompt = readFileSync(output.prompts.quality, "utf8");
  const simplifyPrompt = readFileSync(output.prompts.simplify, "utf8");
  expectIndependentReviewPrompts(implementationPrompt, qualityPrompt, simplifyPrompt);
});

test("harness run plan-review help exposes plan-only options", () => {
  const result = runHarness(["run", "plan-review", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness run plan-review/);
  expect(result.stdout).toMatch(/--plan <path>/);
  expect(result.stdout).not.toMatch(/--base/);
  expect(result.stdout).not.toMatch(/--head/);
  expect(result.stdout).not.toMatch(/--steps/);
});

test("harness run plan-review dry-run works in non-git workspaces", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness([
    "run",
    "plan-review",
    "--workspace",
    workspace,
    "--plan",
    "plan.md",
    "--dry-run",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("dry_run");
  expect(output.workflow).toBe("plan-review");
  expect(output.requestedSteps).toEqual(["spec"]);
  expect(output.prompts.spec).toMatch(/spec-review\.prompt\.md$/);
  expect(output.scope).toBeUndefined();
  expect(output.baseRef).toBeUndefined();
  expect(output.headRef).toBeUndefined();
  expect(output.mergeBase).toBeUndefined();
  expect(output.headSha).toBeUndefined();

  expect(readFileSync(join(output.runDir, "context/plan.md"), "utf8")).toBe(
    "# Plan\n\nReview me.\n",
  );
  const prompt = readFileSync(output.prompts.spec, "utf8");
  expect(prompt).toContain("Plan file:");
  expect(prompt).toContain("context/plan.md");
  expect(prompt).not.toContain("Diff file:");
});

test("harness run plan-review dry-run omits git scope in git workspaces", () => {
  const workspace = createGitWorkspace();
  writeFileSync(join(workspace, "plan.md"), "# Plan\n\nReview me in git.\n", "utf8");
  const result = runHarness([
    "run",
    "plan-review",
    "--workspace",
    workspace,
    "--plan",
    "plan.md",
    "--dry-run",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("dry_run");
  expect(output.workflow).toBe("plan-review");
  expect(output.scope).toBeUndefined();
  expect(existsSync(join(output.runDir, "context/diff.patch"))).toBe(false);

  const prompt = readFileSync(output.prompts.spec, "utf8");
  expect(prompt).toContain("Plan file:");
  expect(prompt).not.toContain("Diff file:");
});

test("harness run plan-review requires a plan", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness(["run", "plan-review", "--workspace", workspace, "--dry-run"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/required option.*--plan/i);
});

test("harness run plan-review rejects missing plan files", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness([
    "run",
    "plan-review",
    "--workspace",
    workspace,
    "--plan",
    "missing.md",
    "--dry-run",
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Plan file does not exist: missing\.md/);
});

test("harness run plan-review rejects change-review flags", () => {
  const workspace = createPlainWorkspace();
  for (const args of [
    ["--base", "HEAD"],
    ["--head", "HEAD"],
    ["--steps", "spec"],
  ] as const) {
    const result = runHarness([
      "run",
      "plan-review",
      "--workspace",
      workspace,
      "--plan",
      "plan.md",
      "--dry-run",
      ...args,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown option/i);
  }
});

test("harness run factory-triage dry-run works in non-git workspaces", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify(
      {
        id: "local-1",
        source: "file",
        title: "Clarify export shortcut",
        body: "Should export have a keyboard shortcut?",
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = runHarness([
    "run",
    "factory-triage",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--dry-run",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    workflow: "factory-triage",
    status: "dry_run",
    workspace,
    workItem: {
      id: "local-1",
      source: "file",
      title: "Clarify export shortcut",
    },
    route: "needs-info",
    nextAction: "ask-human",
    summaryPath: "summary.md",
    triagePath: "factory-triage.json",
    routePath: "factory-route.json",
    routeSummaryPath: "factory-route.md",
  });
  expect(existsSync(join(output.runDir, "events.jsonl"))).toBe(false);
  expect(existsSync(join(output.runDir, "context/diff.patch"))).toBe(false);
  expect(readFileSync(join(output.runDir, "context/work-item.json"), "utf8")).toContain(
    "Clarify export shortcut",
  );
  expect(readFileSync(join(output.runDir, "factory-triage.prompt.md"), "utf8")).toContain(
    "Work item JSON",
  );
  expect(readFileSync(join(output.runDir, "factory-route.md"), "utf8")).toContain(
    "# Factory Route",
  );
});

test("harness run factory-triage accepts absolute item-file paths", () => {
  const workspace = createPlainWorkspace();
  const itemPath = join(workspace, "item.json");
  writeFileSync(
    itemPath,
    JSON.stringify({
      id: "local-absolute",
      source: "file",
      title: "Absolute item path",
      body: "Route an item loaded by absolute path.",
    }),
    "utf8",
  );

  const result = runHarness([
    "run",
    "factory-triage",
    "--workspace",
    workspace,
    "--item-file",
    itemPath,
    "--dry-run",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.workItem).toMatchObject({
    id: "local-absolute",
    source: "file",
    title: "Absolute item path",
  });
});

test("harness run factory-triage requires an item file", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness(["run", "factory-triage", "--workspace", workspace, "--dry-run"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/required option.*--item-file/i);
});

test("harness run factory-triage rejects missing item files", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness([
    "run",
    "factory-triage",
    "--workspace",
    workspace,
    "--item-file",
    "missing.json",
    "--dry-run",
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Factory item file does not exist: missing\.json/);
});

test("harness run factory-triage rejects invalid item JSON", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(join(workspace, "item.json"), "{ nope", "utf8");
  const result = runHarness([
    "run",
    "factory-triage",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--dry-run",
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Invalid factory work item JSON/);
});

test("harness run factory-triage preserves post-bootstrap failure artifacts", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({
      id: "local-fail",
      source: "file",
      title: "Provider failure",
      body: "Force provider failure after context bootstrap.",
    }),
    "utf8",
  );
  const result = runHarness(
    [
      "run",
      "factory-triage",
      "--workspace",
      workspace,
      "--item-file",
      "item.json",
      "--max-runtime-ms",
      "1000",
    ],
    { env: { CURSOR_API_KEY: "" } },
  );
  expect(result.status).toBe(1);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    workflow: "factory-triage",
    status: "failed",
    workItem: {
      id: "local-fail",
      source: "file",
      title: "Provider failure",
    },
  });
  expect(existsSync(join(output.runDir, "factory-triage.prompt.md"))).toBe(true);
  expect(readFileSync(join(output.runDir, "meta.json"), "utf8")).toContain('"status": "failed"');
});

test("harness run factory-triage rejects review workflow flags", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({ id: "local-1", source: "file", title: "Task", body: "" }),
    "utf8",
  );
  for (const args of [
    ["--base", "HEAD"],
    ["--head", "HEAD"],
    ["--plan", "plan.md"],
    ["--handoff", "handoff.md"],
    ["--steps", "implementation"],
  ] as const) {
    const result = runHarness([
      "run",
      "factory-triage",
      "--workspace",
      workspace,
      "--item-file",
      "item.json",
      "--dry-run",
      ...args,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown option/i);
  }
});

test("harness factory status lists local inbox items", () => {
  const workspace = createPlainWorkspace();
  const inboxDir = join(workspace, ".harness/inbox/factory");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    join(inboxDir, "001-item.json"),
    JSON.stringify({
      id: "local-1",
      source: "file",
      title: "Queued item",
      body: "Ready for local triage.",
    }),
    "utf8",
  );

  const result = runHarness(["factory", "status", "--workspace", workspace]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    workspace,
    inboxDir,
    pendingCount: 1,
    processedCount: 0,
    failedCount: 0,
    pending: [
      {
        file: "001-item.json",
        id: "local-1",
        source: "file",
        title: "Queued item",
      },
    ],
  });
  expect(existsSync(join(workspace, ".harness/runs/factory"))).toBe(false);
});

test("harness factory status reports stale locks and ignored legacy state without writes", () => {
  const workspace = createPlainWorkspace();
  const storeRoot = mkdtempSync(join(tmpdir(), "harness-cli-status-store-"));
  const first = runHarness([
    "factory",
    "status",
    "--workspace",
    workspace,
    "--factory-store-root",
    storeRoot,
  ]);
  expect(first.status).toBe(0);
  const factoryStateRoot = JSON.parse(first.stdout).store.factoryStateRoot as string;

  const legacyEventPath = join(workspace, ".harness/factory/events/file-legacy.jsonl");
  mkdirSync(dirname(legacyEventPath), { recursive: true });
  writeFileSync(legacyEventPath, '{"legacy":true}\n', "utf8");
  const ownerPath = join(factoryStateRoot, "locks/file-legacy.lock/owner.json");
  mkdirSync(dirname(ownerPath), { recursive: true });
  writeFileSync(
    ownerPath,
    `${JSON.stringify({
      pid: 1,
      hostname: "other-host",
      token: "lock-token",
      workspace,
      workItemKey: "file:legacy",
      startedAt: "2000-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );

  const result = runHarness([
    "factory",
    "status",
    "--workspace",
    workspace,
    "--factory-store-root",
    storeRoot,
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    store: { factoryStateRoot },
    legacyFactoryState: { eventCount: 1, stateCount: 0, ignored: true },
    locks: [
      {
        workItemKey: "file:legacy",
        stale: true,
        classification: "remote-owner",
      },
    ],
  });
  expect(output.warnings).toEqual(
    expect.arrayContaining([
      "Legacy workspace-local factory lifecycle state is ignored in v1; the durable store wins.",
      "Durable factory store is empty for this project; legacy workspace-local lifecycle is ignored in v1.",
    ]),
  );
  expect(readFileSync(legacyEventPath, "utf8")).toBe('{"legacy":true}\n');
  expect(readFileSync(ownerPath, "utf8")).toContain("lock-token");
  expect(existsSync(join(factoryStateRoot, "events"))).toBe(false);
  expect(existsSync(join(factoryStateRoot, "state"))).toBe(false);
});

test("harness factory status resolves relative inbox-dir against workspace", () => {
  const workspace = createPlainWorkspace();
  const inboxDir = join(workspace, "custom-inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    join(inboxDir, "001-item.json"),
    JSON.stringify({
      id: "local-1",
      source: "file",
      title: "Queued item",
      body: "Ready for local triage.",
    }),
    "utf8",
  );

  const result = runHarness(
    ["factory", "status", "--workspace", workspace, "--inbox-dir", "custom-inbox"],
    { cwd: tmpdir() },
  );
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    workspace,
    inboxDir,
    pendingCount: 1,
  });
});

test("harness factory triage dry-run handles one item file", () => {
  const workspace = createPlainWorkspace();
  const storeRoot = mkdtempSync(join(tmpdir(), "harness-cli-triage-store-"));
  const inboxDir = join(workspace, ".harness/inbox/factory");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    join(inboxDir, "001-item.json"),
    JSON.stringify({
      id: "local-1",
      source: "file",
      title: "Queued item",
      body: "Ready for local triage.",
    }),
    "utf8",
  );
  const store = seedMissingLifecycleProjection({
    workspace,
    storeRoot,
    id: "local-1",
    source: "file",
    title: "Queued item",
  });

  const result = runHarness([
    "factory",
    "triage",
    "--workspace",
    workspace,
    "--item-file",
    ".harness/inbox/factory/001-item.json",
    "--dry-run",
    "--factory-store-root",
    storeRoot,
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    workspace,
    workflow: "factory-triage",
    status: "dry_run",
    workItem: {
      id: "local-1",
      source: "file",
      title: "Queued item",
    },
  });
  expect(existsSync(join(inboxDir, "001-item.json"))).toBe(true);
  expect(existsSync(join(inboxDir, "processed"))).toBe(false);
  expect(existsSync(join(workspace, ".harness/factory"))).toBe(false);
  expect(parseFactoryRunStartedProgress(result.stderr)).toEqual({
    harnessFactory: "run-started",
    station: "triage",
    runId: output.runId,
    runDir: output.runDir,
    workspace,
  });
  expect(existsSync(join(output.runDir, "events.jsonl"))).toBe(false);
  expect(output.warnings).toEqual([
    expect.objectContaining({
      code: "durable-state-missing",
      factoryStateRoot: store.factoryStateRoot,
      workItemKey: "file:local-1",
    }),
  ]);
  expect(existsSync(factoryLifecycleStatePath(store.factoryStateRoot, "file:local-1"))).toBe(false);
  expect(existsSync(join(store.factoryStateRoot, "locks"))).toBe(false);
});

test("harness factory triage records explicit runs-dir overrides in durable metadata", () => {
  const workspace = createPlainWorkspace();
  const storeRoot = mkdtempSync(join(tmpdir(), "harness-cli-override-store-"));
  const runsDir = mkdtempSync(join(tmpdir(), "harness-cli-override-runs-"));
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({ id: "local-override", source: "file", title: "Override run", body: "" }),
    "utf8",
  );
  const result = runHarness([
    "factory",
    "triage",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--runs-dir",
    runsDir,
    "--factory-store-root",
    storeRoot,
    "--dry-run",
  ]);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  const meta = JSON.parse(readFileSync(join(output.runDir, "meta.json"), "utf8"));
  expect(output.runDir.startsWith(runsDir)).toBe(true);
  expect(meta.factoryStore).toMatchObject({
    storeRoot: resolve(storeRoot),
    overrides: { runsDir: resolve(runsDir) },
  });
  expect(meta.factoryStore.factoryStateRoot).toBe(
    join(resolve(storeRoot), "projects", meta.factoryStore.projectId, "factory"),
  );
  expect(existsSync(join(workspace, ".harness/factory"))).toBe(false);
});

test("harness factory triage honors factory triager role config", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "harness.json"),
    JSON.stringify(
      {
        factory: {
          triage: {
            roles: {
              triager: {
                agent: "cursor",
                model: "claude-opus-4-8",
              },
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({
      id: "configured-triage",
      source: "file",
      title: "Configured triage",
      body: "Dry-run should still record the configured station role.",
    }),
    "utf8",
  );

  const result = runHarness([
    "factory",
    "triage",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--dry-run",
  ]);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  const meta = JSON.parse(readFileSync(join(output.runDir, "meta.json"), "utf8"));
  expect(meta.agent).toMatchObject({
    name: "cursor",
    model: "claude-opus-4-8",
  });
});

test("harness factory triage accepts absolute item-file paths", () => {
  const workspace = createPlainWorkspace();
  const itemPath = join(workspace, "item.json");
  writeFileSync(
    itemPath,
    JSON.stringify({
      id: "station-absolute",
      source: "file",
      title: "Station absolute item path",
      body: "Route a station item loaded by absolute path.",
    }),
    "utf8",
  );

  const result = runHarness([
    "factory",
    "triage",
    "--workspace",
    workspace,
    "--item-file",
    itemPath,
    "--dry-run",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.workItem).toMatchObject({
    id: "station-absolute",
    source: "file",
    title: "Station absolute item path",
  });
});

test("harness factory triage requires one input source", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness(["factory", "triage", "--workspace", workspace, "--dry-run"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/one of --item-file or --linear-issue is required/);
});

test("harness factory triage rejects multiple input sources", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness([
    "factory",
    "triage",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--linear-issue",
    "ENG-123",
    "--dry-run",
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--item-file and --linear-issue are mutually exclusive/);
});

test("harness factory triage rejects apply with item files", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({
      id: "local-1",
      source: "file",
      title: "Queued item",
      body: "Ready for local triage.",
    }),
    "utf8",
  );

  const result = runHarness([
    "factory",
    "triage",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--apply",
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--apply cannot be used with --item-file/);
});

test("harness factory triage rejects apply dry-runs before Linear config resolution", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness([
    "factory",
    "triage",
    "--workspace",
    workspace,
    "--linear-issue",
    "ENG-123",
    "--apply",
    "--dry-run",
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--apply cannot be combined with --dry-run/);
});

test("harness factory triage with Linear input requires Linear config", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    ["factory", "triage", "--linear-issue", "ENG-123", "--workspace", workspace],
    {
      env: { LINEAR_API_KEY: "test-key" },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/factory\.linear is required/);
});

test("harness factory triage with Linear input requires a Linear API key", () => {
  const workspace = createGitWorkspace();
  writeFileSync(
    join(workspace, "harness.json"),
    JSON.stringify(
      {
        factory: {
          linear: {
            teamKey: "ENG",
            statuses: {
              intake: "Backlog",
              parked: "Parked",
              needsInfo: "Needs Clarification",
              needsPlanReview: "Plan Needs Review",
              needsPlan: "Needs Plan",
              readyToImplement: "Ready to Implement",
              triaging: "Triaging",
              planning: "Planning",
              triageFailed: "Triage Failed",
              planningFailed: "Planning Failed",
              done: "Done",
              canceled: "Canceled",
              duplicate: "Duplicate",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const result = runHarness(
    ["factory", "triage", "--linear-issue", "ENG-123", "--workspace", workspace],
    {
      env: { LINEAR_API_KEY: "" },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/LINEAR_API_KEY is required/);
});

test("harness factory triage rejects missing item files", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness([
    "factory",
    "triage",
    "--workspace",
    workspace,
    "--item-file",
    "missing.json",
    "--dry-run",
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Factory item file does not exist: missing\.json/);
});

test("harness factory triage rejects invalid item JSON", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(join(workspace, "item.json"), "{ nope", "utf8");
  const result = runHarness([
    "factory",
    "triage",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--dry-run",
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Invalid factory work item JSON/);
});

test("harness factory planning dry-run works in non-git workspaces", () => {
  const workspace = createPlainWorkspace();
  const storeRoot = mkdtempSync(join(tmpdir(), "harness-cli-planning-store-"));
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify(
      {
        id: "plan-local-1",
        source: "file",
        title: "Plan export shortcut",
        body: "Design the keyboard shortcut implementation.",
        metadata: {
          factoryRoute: "ready-to-plan",
          factoryNextAction: "create-plan",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const store = seedMissingLifecycleProjection({
    workspace,
    storeRoot,
    id: "plan-local-1",
    source: "file",
    title: "Plan export shortcut",
  });

  const result = runHarness([
    "factory",
    "planning",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--dry-run",
    "--factory-store-root",
    storeRoot,
  ]);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    workflow: "factory-planning",
    status: "dry_run",
    workspace,
    workItem: {
      id: "plan-local-1",
      source: "file",
      title: "Plan export shortcut",
    },
    iterations: 1,
  });
  expect(output.outputPlan).toBeUndefined();
  expect(existsSync(join(output.runDir, "events.jsonl"))).toBe(false);
  expect(existsSync(join(workspace, ".harness/factory"))).toBe(false);
  expect(readFileSync(join(output.runDir, "context/work-item.json"), "utf8")).toContain(
    "Plan export shortcut",
  );
  expect(readFileSync(join(output.runDir, "iterations/1/planner.prompt.md"), "utf8")).toContain(
    "Factory Planning",
  );
  expect(readFileSync(join(output.runDir, "iterations/1/plan.md"), "utf8")).toContain(
    "Dry Run Plan",
  );
  expect(readFileSync(join(output.runDir, "meta.json"), "utf8")).toContain(
    '"workflow": "factory-planning"',
  );
  expect(parseFactoryRunStartedProgress(result.stderr)).toEqual({
    harnessFactory: "run-started",
    station: "planning",
    runId: output.runId,
    runDir: output.runDir,
    workspace,
  });
  expect(output.warnings).toEqual([
    expect.objectContaining({
      code: "durable-state-missing",
      factoryStateRoot: store.factoryStateRoot,
      workItemKey: "file:plan-local-1",
    }),
  ]);
  expect(existsSync(factoryLifecycleStatePath(store.factoryStateRoot, "file:plan-local-1"))).toBe(
    false,
  );
  expect(existsSync(join(store.factoryStateRoot, "locks"))).toBe(false);
});

test("harness factory planning requires one input source", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness(["factory", "planning", "--workspace", workspace, "--dry-run"]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/one of --item-file or --linear-issue is required/);
});

test("harness factory planning rejects multiple input sources before role config resolution", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "harness.json"),
    JSON.stringify({
      defaultAgent: "cursor",
      factory: {
        planning: {
          roles: {
            planner: {
              sandboxMode: "read-only",
            },
          },
        },
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({ id: "plan-local-1", source: "file", title: "Plan", body: "" }),
    "utf8",
  );

  const result = runHarness([
    "factory",
    "planning",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--linear-issue",
    "ENG-123",
    "--dry-run",
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--item-file and --linear-issue are mutually exclusive/);
  expect(result.stderr).not.toMatch(/sandboxMode applies only when role agent is codex/);
});

test("harness factory planning apply rejects item-file mode before role config resolution", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "harness.json"),
    JSON.stringify({
      defaultAgent: "cursor",
      factory: {
        planning: {
          roles: {
            planner: {
              sandboxMode: "read-only",
            },
          },
        },
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({ id: "plan-local-1", source: "file", title: "Plan", body: "" }),
    "utf8",
  );

  const result = runHarness([
    "factory",
    "planning",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--apply",
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--apply cannot be used with --item-file/);
  expect(result.stderr).not.toMatch(/sandboxMode applies only when role agent is codex/);
});

test("harness factory planning apply rejects dry-run before Linear config resolution", () => {
  const workspace = createPlainWorkspace();

  const result = runHarness([
    "factory",
    "planning",
    "--workspace",
    workspace,
    "--linear-issue",
    "ENG-123",
    "--apply",
    "--dry-run",
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--apply cannot be combined with --dry-run/);
  expect(result.stderr).not.toMatch(/factory\.linear is required/);
});

test("harness factory planning apply requires Linear issue before role config resolution", () => {
  const workspace = createPlainWorkspace();

  const result = runHarness(["factory", "planning", "--workspace", workspace, "--apply"]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--apply requires --linear-issue/);
  expect(result.stderr).not.toMatch(/factory\.linear is required/);
});

test("harness factory planning with Linear input requires Linear config", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness(
    ["factory", "planning", "--linear-issue", "ENG-123", "--workspace", workspace, "--dry-run"],
    { env: { LINEAR_API_KEY: "test-key" } },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/factory\.linear is required/);
});

test("harness factory planning with Linear input requires a Linear API key", () => {
  const workspace = createPlainWorkspace();
  writeLinearConfig(workspace);

  const result = runHarness(
    ["factory", "planning", "--linear-issue", "ENG-123", "--workspace", workspace, "--dry-run"],
    { env: { LINEAR_API_KEY: "" } },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/LINEAR_API_KEY is required/);
});

test("harness factory planning publication commands patch run metadata", () => {
  const workspace = createPlainWorkspace();
  const runDir = mkdtempSync(join(tmpdir(), "harness-cli-planning-run-"));
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(join(workspace, "dev/plans/FER-123.md"), "# Plan\n", "utf8");
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        runId: "20260707-120000",
        workflow: "factory-planning",
        status: "plan-approved",
        workspace,
        runDir,
        workItem: { id: "linear:FER-123", source: "linear", title: "Plan issue" },
        outputPlan: join(workspace, "dev/plans/FER-123.md"),
        factoryMetadata: {
          tracker: { source: "linear", id: "FER-123" },
          factoryStage: "plan-pr-open",
          approvedPlanPath: "dev/plans/FER-123.md",
        },
        iterations: [{ index: 1 }],
        plannerAgent: { name: "cursor", model: "composer-2.5" },
        reviewerAgent: { name: "cursor", model: "composer-2.5" },
        summaryPath: join(runDir, "summary.md"),
        metaPath: join(runDir, "meta.json"),
        factoryStore: {
          storeRoot: join(runDir, "store"),
          projectId: "cli-test-project",
          projectRoot: join(runDir, "store/projects/cli-test-project"),
          factoryStateRoot: join(runDir, "factory-state"),
          factoryRunsDir: join(runDir, "store/projects/cli-test-project/runs/factory"),
          reviewRunsDir: join(runDir, "store/projects/cli-test-project/runs/reviews"),
          repo: { name: "cli-test", id: "cli-test-project", idSource: "config" },
          overrides: {},
          warnings: [],
        },
        startedAt: "2026-07-07T12:00:00.000Z",
        durationMs: 1,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(runDir, "summary.md"), "# Old Summary\n", "utf8");

  const publish = runHarness([
    "factory",
    "planning",
    "publish",
    "--run-dir",
    runDir,
    "--pr-url",
    "https://github.com/owner/repo/pull/123",
  ]);
  expect(publish.status).toBe(0);
  const published = JSON.parse(publish.stdout);
  expect(published.factoryMetadata).toMatchObject({
    factoryStage: "plan-pr-open",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
  });
  expect(published.linearComment).toContain("Factory plan ready.");
  expect(
    loadFactoryLifecycleState({
      factoryStateRoot: published.factoryStore.factoryStateRoot,
      workItemKey: "linear:FER-123",
    }),
  ).toMatchObject({
    factoryStage: "plan-pr-open",
    approvedPlanPath: "dev/plans/FER-123.md",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
  });

  const merged = runHarness([
    "factory",
    "planning",
    "mark-plan-merged",
    "--run-dir",
    runDir,
    "--commit",
    "abc1234",
  ]);
  expect(merged.status).toBe(0);
  const output = JSON.parse(merged.stdout);
  expect(output.factoryMetadata).toMatchObject({
    factoryStage: "plan-approved",
    approvedPlanCommit: "abc1234",
  });
  expect(output.linearComment).toContain("Factory plan approved.");
  expect(
    loadFactoryLifecycleState({
      factoryStateRoot: output.factoryStore.factoryStateRoot,
      workItemKey: "linear:FER-123",
    }),
  ).toMatchObject({
    factoryStage: "plan-approved",
    approvedPlanPath: "dev/plans/FER-123.md",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    approvedPlanCommit: "abc1234",
  });
  expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("Ready to implement");
});

test("harness factory planning publish apply rejects missing Linear issue before metadata write", () => {
  const { runDir } = createFactoryPlanningPublicationRun();
  const result = runHarness([
    "factory",
    "planning",
    "publish",
    "--run-dir",
    runDir,
    "--pr-url",
    "https://github.com/owner/repo/pull/123",
    "--apply",
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--apply requires --linear-issue/);
  expect(readFileSync(join(runDir, "meta.json"), "utf8")).not.toContain("approvedPlanPrUrl");
});

test("harness factory planning publish apply rejects missing Linear key before metadata write", () => {
  const { runDir } = createFactoryPlanningPublicationRun();
  const result = runHarness(
    [
      "factory",
      "planning",
      "publish",
      "--run-dir",
      runDir,
      "--pr-url",
      "https://github.com/owner/repo/pull/123",
      "--linear-issue",
      "ENG-123",
      "--apply",
    ],
    { env: { LINEAR_API_KEY: "" } },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/LINEAR_API_KEY is required/);
  expect(readFileSync(join(runDir, "meta.json"), "utf8")).not.toContain("approvedPlanPrUrl");
});

test("harness factory planning publish apply rejects missing Linear config before metadata write", () => {
  const { runDir } = createFactoryPlanningPublicationRun();
  const result = runHarness(
    [
      "factory",
      "planning",
      "publish",
      "--run-dir",
      runDir,
      "--pr-url",
      "https://github.com/owner/repo/pull/123",
      "--linear-issue",
      "ENG-123",
      "--apply",
    ],
    { env: { LINEAR_API_KEY: "test-key" } },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/factory\.linear is required/);
  expect(readFileSync(join(runDir, "meta.json"), "utf8")).not.toContain("approvedPlanPrUrl");
});

test("harness factory planning rejects missing item files", () => {
  const workspace = createPlainWorkspace();
  const result = runHarness([
    "factory",
    "planning",
    "--workspace",
    workspace,
    "--item-file",
    "missing.json",
    "--dry-run",
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Factory item file does not exist: missing\.json/);
});

test("harness factory planning rejects invalid item JSON", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(join(workspace, "item.json"), "{ nope", "utf8");
  const result = runHarness([
    "factory",
    "planning",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--dry-run",
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Invalid factory work item JSON/);
});

test("harness factory planning rejects unknown flags", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({ id: "planning-flags", source: "file", title: "Flags", body: "" }),
    "utf8",
  );
  const result = runHarness([
    "factory",
    "planning",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--dry-run",
    "--base",
    "HEAD",
  ]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/unknown option/i);
});

test("harness factory planning rejects invalid factory role config", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "harness.json"),
    JSON.stringify({
      defaultAgent: "cursor",
      factory: {
        planning: {
          roles: {
            planner: {
              sandboxMode: "read-only",
            },
          },
        },
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({ id: "bad-planning-config", source: "file", title: "Bad config", body: "" }),
    "utf8",
  );

  const result = runHarness([
    "factory",
    "planning",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--dry-run",
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Invalid harness\.json/);
  expect(result.stderr).toMatch(/sandboxMode applies only when role agent is codex/);
});

test("harness factory triage rejects invalid factory role config", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "harness.json"),
    JSON.stringify({
      defaultAgent: "cursor",
      factory: {
        triage: {
          roles: {
            triager: {
              sandboxMode: "read-only",
            },
          },
        },
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({ id: "bad-config", source: "file", title: "Bad config", body: "" }),
    "utf8",
  );

  const result = runHarness([
    "factory",
    "triage",
    "--workspace",
    workspace,
    "--item-file",
    "item.json",
    "--dry-run",
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Invalid harness\.json/);
  expect(result.stderr).toMatch(/sandboxMode applies only when role agent is codex/);
});

test("harness factory triage preserves post-bootstrap failure artifacts", () => {
  const workspace = createPlainWorkspace();
  writeFileSync(
    join(workspace, "item.json"),
    JSON.stringify({
      id: "station-fail",
      source: "file",
      title: "Station provider failure",
      body: "Force provider failure after context bootstrap.",
    }),
    "utf8",
  );
  const result = runHarness(
    [
      "factory",
      "triage",
      "--workspace",
      workspace,
      "--item-file",
      "item.json",
      "--max-runtime-ms",
      "1000",
    ],
    { env: { CURSOR_API_KEY: "" } },
  );

  expect(result.status).toBe(1);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    workflow: "factory-triage",
    status: "failed",
    workItem: {
      id: "station-fail",
      source: "file",
      title: "Station provider failure",
    },
  });
  expect(output.summaryPath).toBeUndefined();
  expect(output.triagePath).toBeUndefined();
  expect(existsSync(join(output.runDir, "factory-triage.prompt.md"))).toBe(true);
  const runMeta = JSON.parse(readFileSync(join(output.runDir, "meta.json"), "utf8"));
  expect(JSON.stringify(runMeta)).toContain('"status":"failed"');
  expect(
    loadFactoryLifecycleState({
      factoryStateRoot: runMeta.factoryStore.factoryStateRoot,
      workItemKey: "file:station-fail",
    }),
  ).toMatchObject({
    factoryRunId: output.runId,
    lastEventId: `triage.failed:${output.runId}`,
  });
});

test("harness run change-review writes stdin handoff into run context", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    [
      "run",
      "change-review",
      "--workspace",
      workspace,
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--handoff-stdin",
      "--dry-run",
    ],
    { input: "# Stdin handoff\n\nReview the piped text input.\n" },
  );
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(readFileSync(join(output.runDir, "context/handoff.md"), "utf8")).toBe(
    "# Stdin handoff\n\nReview the piped text input.\n",
  );
  const implementationPrompt = readFileSync(output.prompts.implementation, "utf8");
  expect(implementationPrompt).toContain("## Handoff");
  expect(implementationPrompt).toContain("Review the piped text input.");
});
test("harness run change-review selected-step dry-run omits unrequested prompts", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "run",
    "change-review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--steps",
    "implementation",
    "--dry-run",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("dry_run");
  expect(output.executedSteps).toEqual(["implementation"]);
  expect(output.omittedSteps).toEqual(["quality", "simplify"]);
  expect(output.partial).toBe(true);
  expect(output.prompts.implementation).toMatch(/implementation-review\.prompt\.md$/);
  expect(output.prompts.quality).toBeUndefined();
  expect(output.prompts.simplify).toBeUndefined();
});
test("harness run change-review dry-run accepts Codex provider options", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "run",
    "change-review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--agent",
    "codex",
    "--codex-executable",
    "/opt/codex",
    "--sandbox",
    "workspace-write",
    "--approval-policy",
    "on-request",
    "--reasoning-effort",
    "medium",
    "--dry-run",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("dry_run");
  expect(output.agent).toMatchObject({
    name: "codex",
    model: "gpt-5.5",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelReasoningEffort: "medium",
  });
});
test("harness run change-review dry-run reads Codex provider from harness.json", () => {
  const workspace = createGitWorkspace();
  writeFileSync(join(workspace, "harness.json"), '{ "defaultAgent": "codex" }\n', "utf8");
  const result = runHarness([
    "run",
    "change-review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--dry-run",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.agent).toMatchObject({
    name: "codex",
    model: "gpt-5.5",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
  });
});
test("harness run change-review dry-run uses self-contained simplify prompt", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "run",
    "change-review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--dry-run",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("dry_run");
  expect(output.prompts.implementation).toMatch(/implementation-review\.prompt\.md$/);
  expect(output.prompts.quality).toMatch(/quality-review\.prompt\.md$/);
  expect(output.prompts.simplify).toMatch(/simplify-review\.prompt\.md$/);

  const simplifyPrompt = readFileSync(output.prompts.simplify, "utf8");
  const qualityPrompt = readFileSync(output.prompts.quality, "utf8");
  expect(simplifyPrompt).toContain("Prefer explicit, boring code");
  expect(simplifyPrompt).not.toContain("SKILL.md");
  expectIndependentReviewPrompts(qualityPrompt, simplifyPrompt);
});
