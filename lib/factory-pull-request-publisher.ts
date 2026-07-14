import { execFileSync } from "node:child_process";

export type FactoryCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => string;

export type FactoryPullRequest = {
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
};

export type PublishFactoryPullRequestInput = {
  workspace: string;
  baseRef: string;
  headBranch: string;
  headSha: string;
  title: string;
  body: string;
};

export function publishFactoryPullRequest(
  input: PublishFactoryPullRequestInput,
  runner: FactoryCommandRunner = runCommand,
): FactoryPullRequest {
  const headBranch = input.headBranch.replace(/^refs\/heads\//, "");
  const local = runner("git", ["rev-parse", "--verify", `${input.headBranch}^{commit}`], {
    cwd: input.workspace,
  }).trim();
  if (local !== input.headSha)
    throw new Error(`Local publication head ${local} does not match reviewed ${input.headSha}`);
  runner("git", ["remote", "get-url", "origin"], { cwd: input.workspace });

  const remote = remoteHead(input.workspace, headBranch, runner);
  if (remote && remote !== input.headSha)
    throw new Error(`Remote publication branch diverges from reviewed head ${input.headSha}`);
  // Validate any durable GitHub identity before the first external mutation.
  const existing = findPullRequest(input, headBranch, runner);
  if (!remote) {
    try {
      runner("git", ["push", "origin", `${input.headSha}:refs/heads/${headBranch}`], {
        cwd: input.workspace,
      });
    } catch (error) {
      if (remoteHead(input.workspace, headBranch, runner) !== input.headSha) throw error;
    }
    if (remoteHead(input.workspace, headBranch, runner) !== input.headSha)
      throw new Error("Remote publication branch was not created at the reviewed head");
  }

  if (existing) return existing;
  // Recover a PR created concurrently after the preflight query.
  const concurrent = findPullRequest(input, headBranch, runner);
  if (concurrent) return concurrent;
  try {
    runner(
      "gh",
      [
        "pr",
        "create",
        "--base",
        input.baseRef.replace(/^refs\/heads\//, ""),
        "--head",
        headBranch,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      { cwd: input.workspace },
    );
  } catch (error) {
    const recovered = findPullRequest(input, headBranch, runner);
    if (recovered) return recovered;
    throw error;
  }
  const created = findPullRequest(input, headBranch, runner);
  if (!created) throw new Error("GitHub did not report the created pull request");
  return created;
}

function remoteHead(
  workspace: string,
  branch: string,
  runner: FactoryCommandRunner,
): string | undefined {
  const output = runner("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], {
    cwd: workspace,
  }).trim();
  if (!output) return undefined;
  const lines = output.split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error(`Remote returned multiple refs for ${branch}`);
  return lines[0]!.split(/\s+/)[0];
}

function findPullRequest(
  input: PublishFactoryPullRequestInput,
  headBranch: string,
  runner: FactoryCommandRunner,
): FactoryPullRequest | undefined {
  const raw = runner(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      headBranch,
      "--json",
      "url,baseRefName,headRefName,headRefOid",
    ],
    { cwd: input.workspace },
  );
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("Invalid gh pr list response");
  if (value.length > 1) throw new Error(`Multiple pull requests exist for ${headBranch}`);
  if (value.length === 0) return undefined;
  const pr = parsePullRequest(value[0]);
  const base = input.baseRef.replace(/^refs\/heads\//, "");
  if (pr.baseRefName !== base || pr.headRefName !== headBranch || pr.headRefOid !== input.headSha)
    throw new Error("Existing pull request conflicts with reviewed publication identity");
  return pr;
}

function parsePullRequest(value: unknown): FactoryPullRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid GitHub pull request");
  const record = value as Record<string, unknown>;
  for (const key of ["url", "baseRefName", "headRefName", "headRefOid"] as const)
    if (typeof record[key] !== "string" || record[key].length === 0)
      throw new Error(`GitHub pull request is missing ${key}`);
  return record as FactoryPullRequest;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): string {
  return execFileSync(command, [...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
