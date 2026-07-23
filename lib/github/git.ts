import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { errorMessage, GitHubPublicationError, redactSecrets } from "./error.ts";
import type {
  GitHubPublicationAuthor,
  GitPushInput,
  GitPushTransport,
  GitRemoteBranchInput,
} from "./types.ts";
import { inspectGitChanges } from "../repository/git.ts";
import type {
  RepositoryChange,
  RepositoryChangeStatus,
  RepositoryRun,
} from "../repository/types.ts";

const execFileAsync = promisify(execFile);
const FULL_GIT_SHA = /^[0-9a-f]{40,64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const TRAILER = "Harness-Run-ID";
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

export async function preparePublicationCommit(input: {
  run: RepositoryRun;
  expectedChanges: readonly RepositoryChange[];
  author: GitHubPublicationAuthor;
  commitMessage: string;
}): Promise<string> {
  const { run } = input;
  assertRunIdentity(run);
  await assertWorkspace(run);
  await assertBranchName(run.branch, "head branch");
  const fullMessage = publicationCommitMessage(input.commitMessage, run.id);
  const headSha = (await runLocalGit(run.workspace, ["rev-parse", "--verify", "HEAD"])).trim();

  if (headSha === run.baseSha) {
    const currentChanges = await inspectGitChanges(run.workspace);
    assertChangesEqual(currentChanges, input.expectedChanges, "workspace");
    await stageExpectedChanges(run.workspace, input.expectedChanges);
    const stagedChanges = await readStagedChanges(run.workspace);
    assertPublishedChangesEqual(stagedChanges, input.expectedChanges, "staged");
    await commitChanges(run.workspace, fullMessage, input.author);
  } else {
    const currentChanges = await inspectGitChanges(run.workspace);
    if (currentChanges.length !== 0) {
      throw new GitHubPublicationError(
        "run-conflict",
        "Repository run contains both a prior commit and uncommitted changes.",
      );
    }
  }

  const committedSha = (await runLocalGit(run.workspace, ["rev-parse", "--verify", "HEAD"])).trim();
  await assertPublicationCommit({
    workspace: run.workspace,
    baseSha: run.baseSha,
    commitSha: committedSha,
    expectedChanges: input.expectedChanges,
    author: input.author,
    fullMessage,
  });
  return committedSha;
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

async function assertWorkspace(run: RepositoryRun): Promise<void> {
  if (!isAbsolute(run.workspace)) {
    throw new GitHubPublicationError("invalid-input", "Repository run workspace must be absolute.");
  }
  const [workspace, root, branch, remote] = await Promise.all([
    realpath(run.workspace),
    runLocalGit(run.workspace, ["rev-parse", "--show-toplevel"]).then((value) =>
      realpath(value.trim()),
    ),
    runLocalGit(run.workspace, ["branch", "--show-current"]).then((value) => value.trim()),
    runLocalGit(run.workspace, ["remote", "get-url", "origin"]).then((value) => value.trim()),
  ]);
  if (workspace !== root || branch !== run.branch || remote !== run.remote) {
    throw new GitHubPublicationError(
      "run-conflict",
      "Repository run workspace, branch, or origin no longer matches its durable identity.",
    );
  }
  const pushUrls = (
    await runLocalGit(run.workspace, ["config", "--get-all", "remote.origin.pushurl"], {
      acceptedExitCodes: [0, 1],
    })
  ).trim();
  if (pushUrls) {
    throw new GitHubPublicationError(
      "run-conflict",
      "Repository run must not override the origin push URL.",
    );
  }
}

function assertRunIdentity(run: RepositoryRun): void {
  if (
    run.version !== 1 ||
    !RUN_ID.test(run.id) ||
    !FULL_GIT_SHA.test(run.baseSha) ||
    !run.remote.trim() ||
    containsCommandControl(run.remote)
  ) {
    throw new GitHubPublicationError("invalid-input", "Repository run identity is invalid.");
  }
}

function containsCommandControl(value: string): boolean {
  return value.includes("\u0000") || value.includes("\r") || value.includes("\n");
}

function publicationCommitMessage(message: string, runId: string): string {
  const trimmed = message.trim();
  if (!trimmed || trimmed.includes("\u0000") || new RegExp(`^${TRAILER}:`, "im").test(trimmed)) {
    throw new GitHubPublicationError(
      "invalid-input",
      `Commit message must be non-empty and must not contain a ${TRAILER} trailer.`,
    );
  }
  return `${trimmed}\n\n${TRAILER}: ${runId}`;
}

async function stageExpectedChanges(
  workspace: string,
  expectedChanges: readonly RepositoryChange[],
): Promise<void> {
  const paths = new Set<string>();
  for (const change of expectedChanges) {
    paths.add(change.path);
    if (change.previousPath) paths.add(change.previousPath);
  }
  if (paths.size === 0 || expectedChanges.some((change) => change.status === "conflicted")) {
    throw new GitHubPublicationError(
      "invalid-input",
      "Publication requires at least one non-conflicted expected change.",
    );
  }
  await runLocalGit(workspace, ["--literal-pathspecs", "add", "-A", "--", ...paths]);
}

async function commitChanges(
  workspace: string,
  message: string,
  author: GitHubPublicationAuthor,
): Promise<void> {
  await runLocalGit(workspace, ["commit", "--no-gpg-sign", "--no-verify", "-m", message], {
    environment: {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    },
  });
}

async function assertPublicationCommit(input: {
  workspace: string;
  baseSha: string;
  commitSha: string;
  expectedChanges: readonly RepositoryChange[];
  author: GitHubPublicationAuthor;
  fullMessage: string;
}): Promise<void> {
  const details = await readCommitDetails(input.workspace, input.commitSha);
  if (
    details.parents.length !== 1 ||
    details.parents[0] !== input.baseSha ||
    details.authorName !== input.author.name ||
    details.authorEmail !== input.author.email ||
    details.message !== input.fullMessage
  ) {
    throw new GitHubPublicationError(
      "run-conflict",
      "Existing repository commit does not match this publication run.",
    );
  }
  const committedChanges = await readCommittedChanges(
    input.workspace,
    input.baseSha,
    input.commitSha,
  );
  assertPublishedChangesEqual(committedChanges, input.expectedChanges, "committed");
}

async function readCommitDetails(
  workspace: string,
  commitSha: string,
): Promise<
  Readonly<{
    parents: readonly string[];
    authorName: string;
    authorEmail: string;
    message: string;
  }>
> {
  const output = await runLocalGit(workspace, [
    "show",
    "-s",
    "--format=%P%x00%an%x00%ae%x00%B",
    commitSha,
  ]);
  const [parents = "", authorName = "", authorEmail = "", ...messageParts] = output.split("\0");
  return Object.freeze({
    parents: Object.freeze(parents.trim().split(/\s+/).filter(Boolean)),
    authorName,
    authorEmail,
    message: messageParts.join("\0").trimEnd(),
  });
}

async function readStagedChanges(workspace: string): Promise<readonly RepositoryChange[]> {
  const output = await runLocalGit(workspace, [
    "diff",
    "--cached",
    "--name-status",
    "-z",
    "-M",
    "-C",
    "--no-ext-diff",
    "HEAD",
  ]);
  return parseNameStatus(output);
}

async function readCommittedChanges(
  workspace: string,
  baseSha: string,
  commitSha: string,
): Promise<readonly RepositoryChange[]> {
  const output = await runLocalGit(workspace, [
    "diff",
    "--name-status",
    "-z",
    "-M",
    "-C",
    "--no-ext-diff",
    baseSha,
    commitSha,
  ]);
  return parseNameStatus(output);
}

function parseNameStatus(output: string): readonly RepositoryChange[] {
  if (!output) return Object.freeze([]);
  const fields = output.split("\0");
  const changes: RepositoryChange[] = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    if (!code) continue;
    const status = nameStatus(code);
    if (status === "renamed" || status === "copied") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) throw invalidNameStatus();
      changes.push(Object.freeze({ path, previousPath, status }));
      continue;
    }
    const path = fields[index++];
    if (!path) throw invalidNameStatus();
    changes.push(Object.freeze({ path, status }));
  }
  return Object.freeze(changes);
}

function nameStatus(code: string): RepositoryChangeStatus {
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("C")) return "copied";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "U") return "conflicted";
  if (code === "M" || code === "T") return "modified";
  throw invalidNameStatus();
}

function invalidNameStatus(): GitHubPublicationError {
  return new GitHubPublicationError("git-failed", "Git returned an invalid change record.");
}

function assertChangesEqual(
  actual: readonly RepositoryChange[],
  expected: readonly RepositoryChange[],
  stage: string,
): void {
  if (canonicalChanges(actual) !== canonicalChanges(expected)) {
    throw new GitHubPublicationError(
      "changes-mismatch",
      `Repository ${stage} changes do not match the approved change set.`,
    );
  }
}

function assertPublishedChangesEqual(
  actual: readonly RepositoryChange[],
  expected: readonly RepositoryChange[],
  stage: string,
): void {
  if (canonicalPublishedChanges(actual) !== canonicalPublishedChanges(expected)) {
    throw new GitHubPublicationError(
      "changes-mismatch",
      `Repository ${stage} changes do not match the approved change set.`,
    );
  }
}

function canonicalChanges(changes: readonly RepositoryChange[]): string {
  return JSON.stringify(
    changes
      .map((change) => ({
        path: change.path,
        previousPath: change.previousPath ?? "",
        status: change.status,
      }))
      .sort(compareChanges),
  );
}

function canonicalPublishedChanges(changes: readonly RepositoryChange[]): string {
  const normalized: Array<{ path: string; previousPath: string; status: string }> = [];
  for (const change of changes) {
    if (change.status === "renamed") {
      if (change.previousPath) {
        normalized.push({ path: change.previousPath, previousPath: "", status: "deleted" });
      }
      normalized.push({ path: change.path, previousPath: "", status: "added" });
      continue;
    }
    if (change.status === "copied" || change.status === "untracked") {
      normalized.push({ path: change.path, previousPath: "", status: "added" });
      continue;
    }
    normalized.push({ path: change.path, previousPath: "", status: change.status });
  }
  return JSON.stringify(normalized.sort(compareChanges));
}

function compareChanges(
  left: { path: string; previousPath: string; status: string },
  right: { path: string; previousPath: string; status: string },
): number {
  return (
    left.path.localeCompare(right.path) ||
    left.status.localeCompare(right.status) ||
    left.previousPath.localeCompare(right.previousPath)
  );
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

async function runLocalGit(
  workspace: string,
  args: readonly string[],
  options: {
    acceptedExitCodes?: readonly number[];
    environment?: Readonly<Record<string, string>>;
  } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...GIT_CONFIG_ARGS, ...args], {
      cwd: resolve(workspace),
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.environment },
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const exitCode = (error as { code?: unknown }).code;
    if (typeof exitCode === "number" && options.acceptedExitCodes?.includes(exitCode)) {
      return "";
    }
    throw new GitHubPublicationError("git-failed", `Git command failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}
