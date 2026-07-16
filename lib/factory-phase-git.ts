import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { deriveFactoryRepoIdentity } from "./factory-store.ts";
import type { FactoryPhaseGitIdentity, FactoryPhaseRunIdentity } from "./factory-phase-run.ts";

export class FactoryPhaseGitError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryPhaseGitError";
  }
}

export function snapshotFactoryPhaseGit(
  workspace: string,
  options: { requireBranch?: boolean; optional?: boolean } = {},
): FactoryPhaseGitIdentity | undefined {
  let root: string;
  try {
    root = canonicalRepository(workspace);
  } catch (cause) {
    if (options.optional) return undefined;
    throw new FactoryPhaseGitError("Factory phase requires a Git repository", { cause });
  }
  const baseSha = git(root, ["rev-parse", "HEAD^{commit}"]).trim();
  const branchRef = tryGit(root, ["symbolic-ref", "-q", "HEAD"])?.trim();
  if (options.requireBranch && !branchRef?.startsWith("refs/heads/")) {
    throw new FactoryPhaseGitError("Factory phase requires an attached branch");
  }
  return {
    repositoryId: deriveFactoryRepoIdentity(root).id,
    baseSha,
    target: branchRef?.startsWith("refs/heads/")
      ? { mode: "branch", branchRef }
      : { mode: "detached" },
  };
}

/** Validate immutable Git authority while allowing the same repository at a new path. */
export function assertFactoryPhaseWorkspace(
  identity: FactoryPhaseRunIdentity,
  workspace: string,
): string {
  const resolved = resolve(workspace);
  if (identity.version === 1) {
    if (identity.workspace !== resolved)
      throw new FactoryPhaseGitError("Version-1 Factory phase identity is local-path only");
    return resolved;
  }
  if (!identity.git) {
    if (identity.workspace !== resolved)
      throw new FactoryPhaseGitError("Non-Git Factory phase identity is local-path only");
    return resolved;
  }
  const root = canonicalRepository(resolved);
  if (deriveFactoryRepoIdentity(root).id !== identity.git.repositoryId)
    throw new FactoryPhaseGitError("Factory phase repository identity changed since phase start");
  if (tryGit(root, ["cat-file", "-e", `${identity.git.baseSha}^{commit}`]) === undefined)
    throw new FactoryPhaseGitError("Factory phase base commit is unavailable");
  if (identity.git.target.mode === "detached") {
    const branch = tryGit(root, ["symbolic-ref", "-q", "HEAD"]);
    if (branch || git(root, ["rev-parse", "HEAD^{commit}"]).trim() !== identity.git.baseSha)
      throw new FactoryPhaseGitError("Factory phase detached target changed since phase start");
  } else {
    const branch = tryGit(root, ["symbolic-ref", "-q", "HEAD"])?.trim();
    if (branch !== identity.git.target.branchRef)
      throw new FactoryPhaseGitError("Factory phase branch target changed since phase start");
    git(root, ["merge-base", "--is-ancestor", identity.git.baseSha, "HEAD"]);
  }
  return root;
}

export function requireFactoryPhaseGit(identity: FactoryPhaseRunIdentity): FactoryPhaseGitIdentity {
  if (identity.version !== 2 || !identity.git)
    throw new FactoryPhaseGitError("Factory phase lacks hosted Git execution authority");
  return identity.git;
}

export function factoryPhaseBaseSha(identity: FactoryPhaseRunIdentity): string {
  return identity.version === 2 && identity.git
    ? identity.git.baseSha
    : legacyGit(identity).baseSha;
}

export function factoryPhaseBranchRef(identity: FactoryPhaseRunIdentity): string {
  if (identity.version === 2 && identity.git?.target.mode === "branch")
    return identity.git.target.branchRef;
  return legacyGit(identity).branchRef;
}

function legacyGit(identity: FactoryPhaseRunIdentity): { baseSha: string; branchRef: string } {
  if (
    identity.version === 1 &&
    identity.phase !== "triage" &&
    identity.baseSha &&
    identity.branchRef
  )
    return { baseSha: identity.baseSha, branchRef: identity.branchRef };
  throw new FactoryPhaseGitError("Factory phase lacks branch Git execution authority");
}

function canonicalRepository(workspace: string): string {
  return realpathSync(git(resolve(workspace), ["rev-parse", "--show-toplevel"]).trim());
}

function tryGit(workspace: string, args: string[]): string | undefined {
  try {
    return git(workspace, args);
  } catch {
    return undefined;
  }
}

function git(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new FactoryPhaseGitError(`Git command failed: git ${args.join(" ")}`, { cause });
  }
}
