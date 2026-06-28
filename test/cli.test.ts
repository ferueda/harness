import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  HARNESS_GITIGNORE_ENTRY,
  HARNESS_RECOMMENDED_COMMAND,
  HARNESS_SHIM_RELATIVE_PATH,
} from "../lib/config.ts";
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS_BIN = join(REPO_ROOT, "bin/harness.ts");

function runHarness(
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
) {
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
  expect(output.cursor.models).toEqual(["composer-2.5", "claude-opus-4-8", "gpt-5.5"]);
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
  expect(output.prompts.implementation).toMatch(/implementation-review\.prompt\.md$/);
  expect(output.prompts.quality).toMatch(/quality-review\.prompt\.md$/);
  expect(output.prompts.simplify).toMatch(/simplify-review\.prompt\.md$/);

  const implementationPrompt = readFileSync(output.prompts.implementation, "utf8");
  const qualityPrompt = readFileSync(output.prompts.quality, "utf8");
  const simplifyPrompt = readFileSync(output.prompts.simplify, "utf8");
  expectIndependentReviewPrompts(implementationPrompt, qualityPrompt, simplifyPrompt);
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
