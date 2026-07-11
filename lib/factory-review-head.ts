import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export class FactoryReviewHeadError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryReviewHeadError";
  }
}

export type FactoryCandidateTuple = {
  ref: string;
  commit: string;
  tree: string;
};

export type FactoryReviewHead = FactoryCandidateTuple & {
  reviewBase: string;
  reviewHead: string;
  reviewCommitSha: string;
  treeSha: string;
  diffPatch: string;
};

const HARNESS_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Harness Factory",
  GIT_AUTHOR_EMAIL: "factory@harness.local",
  GIT_COMMITTER_NAME: "Harness Factory",
  GIT_COMMITTER_EMAIL: "factory@harness.local",
} as const;
const GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;
const EMPTY_TREE = "0000000000000000000000000000000000000000";

export function createFactoryReviewHead(input: {
  workspace: string;
  runDir: string;
  runId: string;
  reviewBase: string;
}): FactoryReviewHead {
  const reviewHead = `refs/harness/factory/${input.runId}/implementation`;
  return materializeCandidate({
    workspace: input.workspace,
    runDir: input.runDir,
    ref: reviewHead,
    parent: input.reviewBase,
    originalReviewBase: input.reviewBase,
    message: `harness factory implementation ${input.runId}`,
  });
}

export function createFactoryRemediationCandidate(input: {
  workspace: string;
  runDir: string;
  implementationRunId: string;
  candidateVersion: number;
  priorCandidate: FactoryCandidateTuple;
  originalReviewBase: string;
}): FactoryReviewHead {
  const ref = `refs/harness/factory/${input.implementationRunId}/review/${input.candidateVersion}`;
  return materializeCandidate({
    workspace: input.workspace,
    runDir: input.runDir,
    ref,
    parent: input.priorCandidate.commit,
    originalReviewBase: input.originalReviewBase,
    message: `harness factory remediation ${input.implementationRunId} candidate ${input.candidateVersion}`,
  });
}

export function createFactoryPartialEvidenceCandidate(input: {
  workspace: string;
  runDir: string;
  implementationRunId: string;
  attemptId: string;
  reviewIndex: number;
  parentCandidate: FactoryCandidateTuple;
  originalReviewBase: string;
}): FactoryReviewHead {
  const ref = `refs/harness/factory/${input.implementationRunId}/review-attempt/${input.attemptId}/${input.reviewIndex}/partial`;
  return materializeCandidate({
    workspace: input.workspace,
    runDir: input.runDir,
    ref,
    parent: input.parentCandidate.commit,
    originalReviewBase: input.originalReviewBase,
    message: `harness factory partial review evidence ${input.attemptId}/${input.reviewIndex}`,
  });
}

export function validateFactoryCandidateTuple(input: {
  workspace: string;
  candidate: FactoryCandidateTuple;
  expectedOriginalBase?: string;
  expectedWorkspaceTree?: boolean;
}): void {
  if (input.expectedOriginalBase) {
    const head = git(input.workspace, ["rev-parse", "HEAD"]).trim();
    if (head !== input.expectedOriginalBase) {
      throw new FactoryReviewHeadError(
        `Workspace HEAD ${head} does not match review base ${input.expectedOriginalBase}`,
      );
    }
  }
  const commit = git(input.workspace, ["rev-parse", input.candidate.ref]).trim();
  if (commit !== input.candidate.commit) {
    throw new FactoryReviewHeadError(
      `Candidate ref ${input.candidate.ref} resolves to ${commit}, expected ${input.candidate.commit}`,
    );
  }
  const tree = git(input.workspace, ["rev-parse", `${commit}^{tree}`]).trim();
  if (tree !== input.candidate.tree) {
    throw new FactoryReviewHeadError(
      `Candidate commit ${commit} resolves to tree ${tree}, expected ${input.candidate.tree}`,
    );
  }
  if (input.expectedWorkspaceTree) {
    const workspaceTree = materializeWorkspaceTree(input.workspace, commit);
    if (workspaceTree !== tree) {
      throw new FactoryReviewHeadError(
        `Workspace tree ${workspaceTree} does not match candidate tree ${tree}`,
      );
    }
  }
  if (input.expectedOriginalBase) {
    const parent = git(input.workspace, ["rev-parse", `${commit}^`]).trim();
    if (parent !== input.expectedOriginalBase && input.candidate.ref.endsWith("/implementation")) {
      throw new FactoryReviewHeadError(
        `Initial review candidate parent ${parent} does not match review base ${input.expectedOriginalBase}`,
      );
    }
  }
}

export function readFactoryCandidateTree(workspace: string, ref: string): string {
  try {
    return git(workspace, ["rev-parse", `${ref}^{tree}`]).trim();
  } catch (error) {
    throw new FactoryReviewHeadError(`Cannot resolve candidate tree for ${ref}`, { cause: error });
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

function materializeCandidate(input: {
  workspace: string;
  runDir: string;
  ref: string;
  parent: string;
  originalReviewBase: string;
  message: string;
}): FactoryReviewHead {
  const indexDir = join(input.runDir, "tmp");
  const indexPath = join(indexDir, `review-index-${process.pid}-${Date.now()}`);
  mkdirSync(indexDir, { recursive: true });
  const env = { ...process.env, GIT_INDEX_FILE: indexPath, ...HARNESS_GIT_IDENTITY };
  try {
    git(input.workspace, ["read-tree", input.parent], env);
    git(input.workspace, ["add", "-A", "--", "."], env);
    const treeSha = git(input.workspace, ["write-tree"], env).trim();
    assertReviewTreeOmitsHarness(input.workspace, treeSha, env);
    const commit = git(
      input.workspace,
      ["commit-tree", treeSha, "-p", input.parent, "-m", input.message],
      env,
    ).trim();
    // Compare-and-swap against the all-zero old value: existing immutable refs fail closed.
    git(input.workspace, ["update-ref", input.ref, commit, EMPTY_TREE], env);
    const diffPatch = git(
      input.workspace,
      ["diff", "--binary", `${input.originalReviewBase}..${commit}`],
      {
        ...process.env,
      },
    );
    return {
      ref: input.ref,
      commit,
      tree: treeSha,
      reviewBase: input.originalReviewBase,
      reviewHead: input.ref,
      reviewCommitSha: commit,
      treeSha,
      diffPatch,
    };
  } catch (error) {
    if (error instanceof FactoryReviewHeadError) throw error;
    throw new FactoryReviewHeadError(
      `Failed to materialize factory review head: ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    for (const suffix of ["", ".lock"]) {
      try {
        rmSync(`${indexPath}${suffix}`, { force: true });
      } catch {
        // Temporary index cleanup is best effort; it cannot alter the real index.
      }
    }
  }
}

function materializeWorkspaceTree(workspace: string, parent: string): string {
  const indexDir = join(workspace, ".git", "harness-review-tree");
  const indexPath = join(indexDir, `${process.pid}-${Date.now()}`);
  mkdirSync(indexDir, { recursive: true });
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    git(workspace, ["read-tree", parent], env);
    git(workspace, ["add", "-A", "--", "."], env);
    return git(workspace, ["write-tree"], env).trim();
  } finally {
    try {
      rmSync(indexPath, { force: true });
    } catch {
      // Best effort.
    }
  }
}

function assertReviewTreeOmitsHarness(
  workspace: string,
  treeSha: string,
  env: NodeJS.ProcessEnv,
): void {
  const harnessPaths = git(
    workspace,
    ["ls-tree", "-r", "--name-only", treeSha, "--", ".harness"],
    env,
  )
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  if (harnessPaths.length === 0) return;
  const sample = harnessPaths.slice(0, 5).join(", ");
  const more = harnessPaths.length > 5 ? ` (+${harnessPaths.length - 5} more)` : "";
  throw new FactoryReviewHeadError(
    `Review tree must not include .harness/ artifacts (found ${harnessPaths.length}: ${sample}${more}). Add ".harness/" to .gitignore or run harness init before factory implementation.`,
  );
}

function git(workspace: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
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
