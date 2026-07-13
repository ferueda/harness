import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export class FactoryReviewHeadError extends Error {
  readonly kind: "invariant" | "git";

  constructor(message: string, options: { cause?: unknown; kind?: "invariant" | "git" } = {}) {
    super(message, options);
    this.name = "FactoryReviewHeadError";
    this.kind = options.kind ?? "invariant";
  }
}

export type FactoryReviewHead = {
  reviewBase: string;
  reviewHead: string;
  reviewCommitSha: string;
  treeSha: string;
  diffPatch: string;
};

const GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;

export function createFactoryReviewHead(input: {
  workspace: string;
  runDir: string;
  runId: string;
  attempt: number;
  reviewBase: string;
  timestamp: string;
}): FactoryReviewHead {
  const reviewHead = `refs/harness/factory/${input.runId}/${input.attempt}`;
  const indexPath = join(input.runDir, "tmp", `candidate-index-${input.attempt}`);
  mkdirSync(join(input.runDir, "tmp"), { recursive: true });
  rmSync(indexPath, { force: true });
  const env = candidateEnv(indexPath, input.timestamp);
  try {
    git(input.workspace, ["read-tree", input.reviewBase], env);
    git(input.workspace, ["add", "-A", "--", "."], env);
    const treeSha = git(input.workspace, ["write-tree"], env).trim();
    assertTreeOmitsHarness(input.workspace, treeSha, env);
    const baseTree = git(input.workspace, ["rev-parse", `${input.reviewBase}^{tree}`], env).trim();
    if (treeSha === baseTree)
      throw new FactoryReviewHeadError("Implementation produced no tree change");
    const reviewCommitSha = git(
      input.workspace,
      [
        "commit-tree",
        treeSha,
        "-p",
        input.reviewBase,
        "-m",
        `harness factory implementation ${input.runId} attempt ${input.attempt}`,
      ],
      env,
    ).trim();
    const existing = tryGit(input.workspace, ["rev-parse", "--verify", reviewHead], env)?.trim();
    if (existing && existing !== reviewCommitSha)
      throw new FactoryReviewHeadError(`Divergent factory candidate ref: ${reviewHead}`);
    if (!existing) git(input.workspace, ["update-ref", reviewHead, reviewCommitSha, ""], env);
    return {
      reviewBase: input.reviewBase,
      reviewHead,
      reviewCommitSha,
      treeSha,
      diffPatch: git(
        input.workspace,
        ["diff", "--binary", `${input.reviewBase}..${reviewCommitSha}`],
        process.env,
      ),
    };
  } catch (error) {
    if (error instanceof FactoryReviewHeadError) throw error;
    throw new FactoryReviewHeadError(`Failed to materialize factory candidate: ${message(error)}`, {
      cause: error,
      kind: "git",
    });
  } finally {
    rmSync(indexPath, { force: true });
  }
}

export function readFactoryWorkspaceTree(input: {
  workspace: string;
  runDir: string;
  baseSha: string;
}): { tree: string; status: string } {
  const indexPath = join(input.runDir, "tmp", "workspace-index");
  mkdirSync(join(input.runDir, "tmp"), { recursive: true });
  rmSync(indexPath, { force: true });
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    git(input.workspace, ["read-tree", input.baseSha], env);
    git(input.workspace, ["add", "-A", "--", "."], env);
    return {
      tree: git(input.workspace, ["write-tree"], env).trim(),
      status: git(
        input.workspace,
        ["status", "--porcelain=v1", "--untracked-files=all"],
        process.env,
      ),
    };
  } finally {
    rmSync(indexPath, { force: true });
  }
}

export function promoteFactoryCandidate(input: {
  workspace: string;
  runDir: string;
  branchRef: string;
  baseSha: string;
  candidateSha: string;
}): void {
  const current = git(input.workspace, ["rev-parse", input.branchRef], process.env).trim();
  const candidateTree = git(
    input.workspace,
    ["rev-parse", `${input.candidateSha}^{tree}`],
    process.env,
  ).trim();
  const baseTree = git(
    input.workspace,
    ["rev-parse", `${input.baseSha}^{tree}`],
    process.env,
  ).trim();
  const live = readFactoryWorkspaceTree({
    workspace: input.workspace,
    runDir: input.runDir,
    baseSha: input.baseSha,
  });
  const indexTree = git(input.workspace, ["write-tree"], process.env).trim();
  if (live.tree !== candidateTree)
    throw new FactoryReviewHeadError("Implementation workspace changed before promotion");
  if (
    (current === input.baseSha && indexTree !== baseTree) ||
    (current === input.candidateSha && indexTree !== baseTree && indexTree !== candidateTree)
  )
    throw new FactoryReviewHeadError("Implementation index changed before promotion");
  if (current === input.baseSha)
    git(
      input.workspace,
      ["update-ref", input.branchRef, input.candidateSha, input.baseSha],
      process.env,
    );
  else if (current !== input.candidateSha)
    throw new FactoryReviewHeadError("Persisted implementation branch moved during review");
  git(input.workspace, ["read-tree", input.candidateSha], process.env);
  const status = git(
    input.workspace,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    process.env,
  );
  if (status.trim())
    throw new FactoryReviewHeadError("Candidate promotion did not leave a clean workspace");
}

function candidateEnv(indexPath: string, timestamp: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "Harness Factory",
    GIT_AUTHOR_EMAIL: "factory@harness.local",
    GIT_COMMITTER_NAME: "Harness Factory",
    GIT_COMMITTER_EMAIL: "factory@harness.local",
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  };
}

function assertTreeOmitsHarness(workspace: string, treeSha: string, env: NodeJS.ProcessEnv): void {
  const paths = git(workspace, ["ls-tree", "-r", "--name-only", treeSha, "--", ".harness"], env)
    .trim()
    .split("\n")
    .filter(Boolean);
  if (paths.length)
    throw new FactoryReviewHeadError("Candidate tree must not include .harness/ artifacts");
}

function git(workspace: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    env,
    maxBuffer: GIT_DIFF_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryGit(workspace: string, args: string[], env: NodeJS.ProcessEnv): string | undefined {
  try {
    return git(workspace, args, env);
  } catch {
    return undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
