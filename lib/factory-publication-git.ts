import { execFileSync } from "node:child_process";

export function resolveLocalCommit(workspace: string, commit: string): string {
  try {
    return git(workspace, ["rev-parse", "--verify", `${commit}^{commit}`]).trim();
  } catch (error) {
    throw new Error(`Merge commit is not available locally: ${commit}`, { cause: error });
  }
}

export function assertCommitAncestor(
  workspace: string,
  ancestor: string,
  descendant: string,
): void {
  try {
    git(workspace, ["merge-base", "--is-ancestor", ancestor, descendant]);
  } catch (error) {
    throw new Error(`Merge commit ${descendant} does not contain reviewed head ${ancestor}`, {
      cause: error,
    });
  }
}

export function git(workspace: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", [...args], {
    cwd: workspace,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
