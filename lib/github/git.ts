import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { errorMessage, GitHubPublicationError, redactSecrets } from "./error.ts";
import type { GitPushInput, GitPushTransport, GitRemoteBranchInput } from "./types.ts";

const execFileAsync = promisify(execFile);
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_CONFIG_ARGS = Object.freeze([
  "-c",
  "credential.helper=",
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "commit.gpgsign=false",
]);
const AUTH_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
] as const);
const ASKPASS_SOURCE = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' "$HARNESS_GITHUB_TOKEN" ;;
  *) exit 1 ;;
esac
`;

export type AuthenticatedGitExecutor = (input: {
  cwd: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
}) => Promise<string>;

export function createAuthenticatedGitTransport(
  options: {
    executor?: AuthenticatedGitExecutor;
    environment?: NodeJS.ProcessEnv;
  } = {},
): GitPushTransport {
  const executor = options.executor ?? executeGit;
  const environment = options.environment ?? process.env;

  return Object.freeze({
    async readRemoteBranch(input: GitRemoteBranchInput): Promise<string | null> {
      const output = await runAuthenticatedGit({
        ...input,
        executor,
        environment,
        args: ["ls-remote", "--heads", "--", input.remote, `refs/heads/${input.branch}`],
      });
      return parseRemoteHead(output, input.branch);
    },

    async pushBranch(input: GitPushInput): Promise<void> {
      await runAuthenticatedGit({
        ...input,
        executor,
        environment,
        args: [
          "push",
          "--porcelain",
          "--",
          input.remote,
          `${input.commitSha}:refs/heads/${input.branch}`,
        ],
        includeWorkspaceObjects: true,
      });
    },
  });
}

export async function assertBranchName(branch: string, description: string): Promise<void> {
  if (!branch.trim() || containsCommandControl(branch)) {
    throw new GitHubPublicationError("invalid-input", `${description} must be a Git branch name.`);
  }
  try {
    await runLocalGit(process.cwd(), ["check-ref-format", "--branch", branch]);
  } catch {
    throw new GitHubPublicationError("invalid-input", `${description} must be a Git branch name.`);
  }
}

function containsCommandControl(value: string): boolean {
  return value.includes("\u0000") || value.includes("\r") || value.includes("\n");
}

function parseRemoteHead(output: string, branch: string): string | null {
  const lines = output.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.length !== 1) {
    throw new GitHubPublicationError(
      "remote-conflict",
      `Git remote returned multiple heads for ${branch}.`,
    );
  }
  const [sha, ref, ...rest] = (lines[0] ?? "").split(/\s+/);
  if (rest.length !== 0 || !sha || !FULL_GIT_SHA.test(sha) || ref !== `refs/heads/${branch}`) {
    throw new GitHubPublicationError(
      "git-failed",
      `Git remote returned an invalid head for ${branch}.`,
    );
  }
  return sha;
}

async function runAuthenticatedGit(
  input: GitRemoteBranchInput & {
    args: readonly string[];
    executor: AuthenticatedGitExecutor;
    environment: NodeJS.ProcessEnv;
    commitSha?: string;
    includeWorkspaceObjects?: boolean;
  },
): Promise<string> {
  const helperDirectory = await mkdtemp(join(tmpdir(), "harness-github-askpass-"));
  const helperPath = join(helperDirectory, "askpass.sh");
  const gitDirectory = join(helperDirectory, "repository.git");
  try {
    if (
      input.includeWorkspaceObjects &&
      (!input.commitSha || !FULL_GIT_SHA.test(input.commitSha))
    ) {
      throw new GitHubPublicationError(
        "invalid-input",
        "Authenticated Git requires an exact commit SHA.",
      );
    }
    await initializeIsolatedGitRepository(helperDirectory, gitDirectory, input.environment);
    if (input.includeWorkspaceObjects) {
      const objectDirectory = await readObjectDirectory(input.workspace);
      if (containsCommandControl(objectDirectory)) {
        throw new GitHubPublicationError(
          "invalid-input",
          "Repository object directory contains unsupported control characters.",
        );
      }
      const alternateFile = join(gitDirectory, "objects", "info", "alternates");
      await mkdir(join(gitDirectory, "objects", "info"), { recursive: true });
      await writeFile(alternateFile, `${objectDirectory}\n`, { encoding: "utf8", flag: "wx" });
    }
    await writeFile(helperPath, ASKPASS_SOURCE, { encoding: "utf8", flag: "wx", mode: 0o700 });
    await chmod(helperPath, 0o700);
    const environment = authenticatedGitEnvironment(input.environment, helperPath, input.token);
    return await input.executor({
      cwd: gitDirectory,
      args: [...GIT_CONFIG_ARGS, "--git-dir=.", ...input.args],
      environment,
    });
  } catch (error) {
    throw new GitHubPublicationError(
      "git-failed",
      `Authenticated Git command failed: ${redactSecrets(errorMessage(error), [input.token])}`,
    );
  } finally {
    await rm(helperDirectory, { force: true, recursive: true });
  }
}

async function initializeIsolatedGitRepository(
  cwd: string,
  gitDirectory: string,
  source: NodeJS.ProcessEnv,
): Promise<void> {
  await execFileAsync(
    "git",
    [...GIT_CONFIG_ARGS, "init", "--bare", "--quiet", "--", gitDirectory],
    {
      cwd,
      encoding: "utf8",
      env: { ...unauthenticatedGitEnvironment(source) },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

async function readObjectDirectory(workspace: string): Promise<string> {
  const commonDirectory = (
    await runLocalGit(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  if (!isAbsolute(commonDirectory)) {
    throw new GitHubPublicationError(
      "git-failed",
      "Git returned a non-absolute common repository directory.",
    );
  }
  return realpath(join(commonDirectory, "objects"));
}

function unauthenticatedGitEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of AUTH_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
}

function authenticatedGitEnvironment(
  source: NodeJS.ProcessEnv,
  helperPath: string,
  token: string,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    ...unauthenticatedGitEnvironment(source),
    GIT_ASKPASS: helperPath,
    GIT_ASKPASS_REQUIRE: "force",
    HARNESS_GITHUB_TOKEN: token,
  };
  return Object.freeze(environment);
}

async function executeGit(input: {
  cwd: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
}): Promise<string> {
  const { stdout } = await execFileAsync("git", [...input.args], {
    cwd: input.cwd,
    encoding: "utf8",
    env: { ...input.environment },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function runLocalGit(workspace: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...GIT_CONFIG_ARGS, ...args], {
      cwd: resolve(workspace),
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new GitHubPublicationError("git-failed", `Git command failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}
