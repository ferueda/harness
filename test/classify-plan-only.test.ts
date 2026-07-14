import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT_PATH = join(REPO_ROOT, "scripts/classify-plan-only.ts");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/test.yml");
const tempPaths: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeRepoFile(repo: string, path: string, content = "content\n"): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commit(repo: string, message: string): string {
  git(repo, "add", "--all");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function makeRepo(initialPath = "README.md"): { repo: string; baseSha: string } {
  const repo = mkdtempSync(join(tmpdir(), "harness-plan-only-"));
  tempPaths.push(repo);
  git(repo, "init", "--quiet");
  git(repo, "config", "user.email", "ci@example.com");
  git(repo, "config", "user.name", "CI Test");
  writeRepoFile(repo, initialPath);
  return { repo, baseSha: commit(repo, "base") };
}

function runClassifier(
  repo: string,
  env: { BASE_SHA?: string; HEAD_SHA?: string; GITHUB_OUTPUT?: string },
) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: repo,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

function classifyChange(paths: string[]): {
  result: ReturnType<typeof runClassifier>;
  output: string;
} {
  const { repo, baseSha } = makeRepo();
  for (const path of paths) writeRepoFile(repo, path);
  const headSha = commit(repo, "change");
  const outputPath = join(repo, "github-output");
  const result = runClassifier(repo, {
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
    GITHUB_OUTPUT: outputPath,
  });
  return { result, output: readFileSync(outputPath, "utf8") };
}

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("classifies only plan Markdown changes as plan-only", () => {
  const { result, output } = classifyChange(["dev/plans/change.md", "dev/plans/nested/more.md"]);
  expect(result.status).toBe(0);
  expect(output).toBe("plan_only=true\n");
});

test.each([
  ["code-only", ["lib/change.ts"]],
  ["mixed", ["dev/plans/change.md", "lib/change.ts"]],
  ["non-Markdown plan file", ["dev/plans/data.json"]],
])("classifies %s changes as unsafe", (_name, paths) => {
  const { result, output } = classifyChange(paths);
  expect(result.status).toBe(0);
  expect(output).toBe("plan_only=false\n");
});

test("classifies an unsafe source renamed into a plan Markdown path as unsafe", () => {
  const { repo, baseSha } = makeRepo("lib/unsafe.ts");
  mkdirSync(join(repo, "dev/plans"), { recursive: true });
  git(repo, "mv", "lib/unsafe.ts", "dev/plans/moved.md");
  const headSha = commit(repo, "move");
  const outputPath = join(repo, "github-output");

  const result = runClassifier(repo, {
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
    GITHUB_OUTPUT: outputPath,
  });

  expect(result.status).toBe(0);
  expect(readFileSync(outputPath, "utf8")).toBe("plan_only=false\n");
});

test("fails closed when a SHA is missing", () => {
  const { repo, baseSha } = makeRepo();
  const result = runClassifier(repo, {
    BASE_SHA: baseSha,
    GITHUB_OUTPUT: join(repo, "github-output"),
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("HEAD_SHA must be a full Git object ID");
});

test("fails closed when a SHA does not resolve", () => {
  const { repo, baseSha } = makeRepo();
  const result = runClassifier(repo, {
    BASE_SHA: baseSha,
    HEAD_SHA: "0".repeat(40),
    GITHUB_OUTPUT: join(repo, "github-output"),
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Failed to classify changed paths");
});

test.each(["BASE_SHA", "HEAD_SHA"] as const)(
  "fails closed when %s names a tree object",
  (treeEndpoint) => {
    const { repo, baseSha } = makeRepo();
    writeRepoFile(repo, "dev/plans/change.md");
    const headSha = commit(repo, "plan");
    const commitSha = treeEndpoint === "BASE_SHA" ? baseSha : headSha;
    const treeSha = git(repo, "rev-parse", `${commitSha}^{tree}`);
    const outputPath = join(repo, "github-output");

    const result = runClassifier(repo, {
      BASE_SHA: treeEndpoint === "BASE_SHA" ? treeSha : baseSha,
      HEAD_SHA: treeEndpoint === "HEAD_SHA" ? treeSha : headSha,
      GITHUB_OUTPUT: outputPath,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${treeEndpoint} must resolve to a commit object`);
    expect(existsSync(outputPath)).toBe(false);
  },
);

test("appends its value to GITHUB_OUTPUT", () => {
  const { repo, baseSha } = makeRepo();
  writeRepoFile(repo, "dev/plans/change.md");
  const headSha = commit(repo, "plan");
  const outputPath = join(repo, "github-output");
  appendFileSync(outputPath, "existing=value\n");

  const result = runClassifier(repo, {
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
    GITHUB_OUTPUT: outputPath,
  });

  expect(result.status).toBe(0);
  expect(readFileSync(outputPath, "utf8")).toBe("existing=value\nplan_only=true\n");
});

test("fails closed when GITHUB_OUTPUT cannot be written", () => {
  const { repo, baseSha } = makeRepo();
  writeRepoFile(repo, "dev/plans/change.md");
  const headSha = commit(repo, "plan");
  const result = runClassifier(repo, { BASE_SHA: baseSha, HEAD_SHA: headSha, GITHUB_OUTPUT: repo });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Failed to classify changed paths");
});

test("workflow preserves Tests/test and routes only plan-only pull requests to focused checks", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  expect(workflow).toContain("name: Tests");
  expect(workflow).toMatch(/jobs:\s+test:/);
  expect(workflow).toContain("node scripts/classify-plan-only.ts");
  expect(workflow).toContain("pnpm exec oxfmt --check dev/plans");
  expect(workflow).toContain("pnpm exec vitest run test/docs-contracts.test.ts");
  expect(workflow).toContain("run: pnpm check:ci");
});
