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

function runHarness(args: string[], options: { cwd?: string; input?: string } = {}) {
  return spawnSync(process.execPath, [HARNESS_BIN, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
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

function expectInitShim(workspace: string, output: Record<string, unknown>) {
  if (typeof output.shimPath !== "string") {
    throw new Error("Expected init output to include shimPath");
  }
  const shimPath = output.shimPath;
  const expectedShimPath = join(workspace, HARNESS_SHIM_RELATIVE_PATH);
  expect(output.shimUpdated).toBe(true);
  expect(realpathSync(shimPath)).toBe(realpathSync(expectedShimPath));
  expect(output.recommendedCommand).toBe(HARNESS_RECOMMENDED_COMMAND);
  expect(readFileSync(shimPath, "utf8")).toContain(HARNESS_BIN);
  const shimHelp = spawnSync(shimPath, ["--help"], { cwd: workspace, encoding: "utf8" });
  expect(shimHelp.status).toBe(0);
  expect(shimHelp.stdout).toMatch(/Usage: harness/);
}

function createFakeCursorAgent({
  reviewVerdict,
  expectedMaxRuntimeMs,
}: {
  reviewVerdict: "pass" | "needs_changes" | "blocked";
  expectedMaxRuntimeMs?: string;
}) {
  const scriptPath = join(mkdtempSync(join(tmpdir(), "harness-agent-")), "cursor-agent.js");
  const structuredOutput = {
    verdict: reviewVerdict,
    summary: "fake reviewer",
    findings:
      reviewVerdict === "pass"
        ? []
        : [
            {
              title: "Fake finding",
              severity: "Medium",
              location: "fake",
              issue: "fake issue",
              recommendation: "fake recommendation",
              rationale: "fake rationale",
              must_fix: true,
            },
          ],
  };
  const envelope = JSON.stringify({ status: "completed", structuredOutput });
  const runtimeCheck = expectedMaxRuntimeMs
    ? `if (!process.argv.includes(${JSON.stringify(expectedMaxRuntimeMs)})) {
  console.log(JSON.stringify({ status: "failed", error: "missing expected runtime" }));
  process.exit(0);
}
`
    : "";
  writeFileSync(scriptPath, `${runtimeCheck}console.log(${JSON.stringify(envelope)});\n`, "utf8");
  return scriptPath;
}

function createPromptAwareCursorAgent() {
  const scriptPath = join(mkdtempSync(join(tmpdir(), "harness-agent-")), "cursor-agent.js");
  const passOutput = {
    verdict: "pass",
    summary: "implementation passed",
    findings: [],
  };
  writeFileSync(
    scriptPath,
    [
      "const { basename } = require('node:path');",
      "const promptPath = process.argv[process.argv.indexOf('--prompt-file') + 1] ?? '';",
      "const promptName = basename(promptPath);",
      "if (promptName === 'quality-review.prompt.md') {",
      "  console.log(JSON.stringify({",
      "    status: 'completed',",
      "    structuredOutput: { verdict: 'pass', summary: 'missing findings' },",
      "  }));",
      "  process.exit(0);",
      "}",
      `console.log(${JSON.stringify(JSON.stringify({ status: "completed", structuredOutput: passOutput }))});`,
      "",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
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
  expect(output.shimUpdated).toBe(false);
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
test("harness run review help exits cleanly", () => {
  const result = runHarness(["run", "review", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness run review/);
  expect(result.stdout).toMatch(/--handoff-stdin/);
  expect(result.stdout).toMatch(/--dry-run/);
});
test("harness run review-full help exits cleanly", () => {
  const result = runHarness(["run", "review-full", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/harness run review-full/);
  expect(result.stdout).toMatch(/--dry-run/);
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
test("harness run review rejects unknown flags", () => {
  const result = runHarness(["run", "review", "--unknown"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/unknown option.*--unknown/i);
});
test("harness run review rejects invalid runtime values", () => {
  const result = runHarness(["run", "review", "--max-runtime-ms", "0"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/must be a positive number/);
});
test("harness run review rejects multiple handoff inputs", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    [
      "run",
      "review",
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
test("harness run review rejects empty stdin handoff", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    [
      "run",
      "review",
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
test("harness run review rejects blank stdin handoff", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    [
      "run",
      "review",
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
test("harness run review dry-run works through the CLI", () => {
  const workspace = createGitWorkspace();
  const result = runHarness([
    "run",
    "review",
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
  expect(output.workspace).toBe(workspace);
  expect(output.prompts.implementation).toMatch(/implementation-review\.prompt\.md$/);
  expect(output.prompts.quality).toMatch(/quality-review\.prompt\.md$/);

  const implementationPrompt = readFileSync(output.prompts.implementation, "utf8");
  const qualityPrompt = readFileSync(output.prompts.quality, "utf8");
  expectIndependentReviewPrompts(implementationPrompt, qualityPrompt);
});
test("harness run review writes stdin handoff into run context", () => {
  const workspace = createGitWorkspace();
  const result = runHarness(
    [
      "run",
      "review",
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
});
test("harness run review-full dry-run includes simplify prompt", () => {
  const workspace = createGitWorkspace();
  const devSkillPath = join(workspace, ".agents/skills/simplify/SKILL.md");
  mkdirSync(dirname(devSkillPath), { recursive: true });
  writeFileSync(devSkillPath, "# Dev simplify\n", "utf8");
  const result = runHarness([
    "run",
    "review-full",
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
  expect(simplifyPrompt).toContain(`- \`${join(REPO_ROOT, "skills/simplify-review/SKILL.md")}\``);
  expect(simplifyPrompt).not.toContain(devSkillPath);
  expectIndependentReviewPrompts(qualityPrompt, simplifyPrompt);
});
test("harness run review accepts positive finite runtime values", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const result = runHarness([
    "run",
    "review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--max-runtime-ms",
    "1.5",
    "--runs-dir",
    runsDir,
    "--cursor-agent",
    createFakeCursorAgent({ reviewVerdict: "pass", expectedMaxRuntimeMs: "1.5" }),
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.verdict).toBe("pass");
});
test("harness run review exits 0 when reviewers pass", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const result = runHarness([
    "run",
    "review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--runs-dir",
    runsDir,
    "--cursor-agent",
    createFakeCursorAgent({ reviewVerdict: "pass" }),
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("completed");
  expect(output.verdict).toBe("pass");
  expect(output.reviews.implementation.verdict).toBe("pass");
  expect(output.reviews.codeQuality.verdict).toBe("pass");
});
test("harness run review returns failed metadata when one reviewer provider fails", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const result = runHarness([
    "run",
    "review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--runs-dir",
    runsDir,
    "--cursor-agent",
    createPromptAwareCursorAgent(),
  ]);
  expect(result.status).toBe(1);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("failed");
  expect(output.verdict).toBeUndefined();
  expect(output.runId).toEqual(expect.any(String));
  expect(output.workspace).toBe(workspace);
  expect(output.scope).toEqual(expect.any(Object));
  expect(output.startedAt).toEqual(expect.any(String));
  expect(output.durationMs).toEqual(expect.any(Number));
  expect(output.failedReviews).toEqual([
    {
      key: "codeQuality",
      stage: "quality",
      error: expect.stringMatching(/Invalid reviewer structured output: findings:/),
    },
  ]);
  expect(output.reviews.implementation.verdict).toBe("pass");
  expect(output.implementationReview.verdict).toBe("pass");
  expect(output.qualityReview).toBeUndefined();

  const [runId] = readdirSync(runsDir);
  const meta = JSON.parse(readFileSync(join(runsDir, runId, "meta.json"), "utf8"));
  expect(meta.status).toBe("failed");
  expect(meta.failedReviews).toEqual(output.failedReviews);
  expect(meta.reviews.implementation.verdict).toBe("pass");

  const summary = readFileSync(join(runsDir, runId, "summary.md"), "utf8");
  expect(summary).toMatch(/## Implementation review/);
  expect(summary).toMatch(/## Failed reviewers/);
  expect(summary).toMatch(/codeQuality/);

  const rawFailure = JSON.parse(
    readFileSync(join(runsDir, runId, "quality-review.raw.json"), "utf8"),
  );
  expect(rawFailure.status).toBe("completed");
  expect(rawFailure.structuredOutput.summary).toBe("missing findings");
});
test("harness run review exits 1 when reviewers do not pass", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const result = runHarness([
    "run",
    "review",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--runs-dir",
    runsDir,
    "--cursor-agent",
    createFakeCursorAgent({ reviewVerdict: "needs_changes" }),
  ]);
  expect(result.status).toBe(1);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("completed");
  expect(output.verdict).toBe("needs_changes");
});
test("harness run review-full exits 0 when all reviewers pass", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const result = runHarness([
    "run",
    "review-full",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--runs-dir",
    runsDir,
    "--cursor-agent",
    createFakeCursorAgent({ reviewVerdict: "pass" }),
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("completed");
  expect(output.verdict).toBe("pass");
  expect(output.reviews.implementation.verdict).toBe("pass");
  expect(output.reviews.codeQuality.verdict).toBe("pass");
  expect(output.reviews.simplify.verdict).toBe("pass");

  const [runId] = readdirSync(runsDir);
  const simplifyPrompt = readFileSync(join(runsDir, runId, "simplify-review.prompt.md"), "utf8");
  const qualityPrompt = readFileSync(join(runsDir, runId, "quality-review.prompt.md"), "utf8");
  expectIndependentReviewPrompts(qualityPrompt, simplifyPrompt);
});
test("harness run review-full exits 1 when reviewers do not pass", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const result = runHarness([
    "run",
    "review-full",
    "--workspace",
    workspace,
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--runs-dir",
    runsDir,
    "--cursor-agent",
    createFakeCursorAgent({ reviewVerdict: "needs_changes" }),
  ]);
  expect(result.status).toBe(1);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("completed");
  expect(output.verdict).toBe("needs_changes");
  expect(output.reviews.implementation.verdict).toBe("needs_changes");
  expect(output.reviews.codeQuality.verdict).toBe("needs_changes");
  expect(output.reviews.simplify.verdict).toBe("needs_changes");
});
