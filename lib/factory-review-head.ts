import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export class FactoryReviewHeadError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryReviewHeadError";
  }
}

export type FactoryReviewHead = {
  reviewBase: string;
  reviewHead: string;
  reviewCommitSha: string;
  diffPatch: string;
};

const HARNESS_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Harness Factory",
  GIT_AUTHOR_EMAIL: "factory@harness.local",
  GIT_COMMITTER_NAME: "Harness Factory",
  GIT_COMMITTER_EMAIL: "factory@harness.local",
} as const;
const GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;

export function createFactoryReviewHead(input: {
  workspace: string;
  runDir: string;
  runId: string;
  reviewBase: string;
}): FactoryReviewHead {
  const reviewHead = `refs/harness/factory/${input.runId}/implementation`;
  const indexPath = join(input.runDir, "tmp", "review-index");
  mkdirSync(join(input.runDir, "tmp"), { recursive: true });

  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    ...HARNESS_GIT_IDENTITY,
  };

  try {
    git(input.workspace, ["read-tree", input.reviewBase], env);
    git(input.workspace, ["add", "-A", "--", ".", ":!.harness"], env);
    const treeSha = git(input.workspace, ["write-tree"], env).trim();
    const reviewCommitSha = git(
      input.workspace,
      [
        "commit-tree",
        treeSha,
        "-p",
        input.reviewBase,
        "-m",
        `harness factory implementation ${input.runId}`,
      ],
      env,
    ).trim();
    git(input.workspace, ["update-ref", reviewHead, reviewCommitSha], env);
    const diffPatch = git(
      input.workspace,
      ["diff", "--binary", `${input.reviewBase}..${reviewCommitSha}`],
      {
        ...process.env,
      },
    );
    return {
      reviewBase: input.reviewBase,
      reviewHead,
      reviewCommitSha,
      diffPatch,
    };
  } catch (error) {
    throw new FactoryReviewHeadError(
      `Failed to materialize factory review head: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function readFactoryReviewBase(workspace: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new FactoryReviewHeadError(`Failed to read review base HEAD: ${errorMessage(error)}`, {
      cause: error,
    });
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
