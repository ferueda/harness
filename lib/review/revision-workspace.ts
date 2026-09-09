import { realpathSync } from "node:fs";
import { gitExec } from "./run-context.ts";

// Each reviewer owns a disposable checkout; never stash or reset the caller's work.
export async function withReviewWorkspace<T>(
  sourceWorkspace: string,
  headSha: string,
  workspace: string,
  review: (workspace: string) => Promise<T>,
): Promise<T> {
  gitExec(sourceWorkspace, [
    "-c",
    "core.hooksPath=/dev/null",
    "worktree",
    "add",
    "--detach",
    "--",
    workspace,
    headSha,
  ]);
  try {
    assertReviewRevision(workspace, headSha);
    const result = await review(workspace);
    assertReviewRevision(workspace, headSha);
    return result;
  } finally {
    gitExec(sourceWorkspace, ["worktree", "remove", "--force", "--", workspace]);
  }
}

function assertReviewRevision(workspace: string, headSha: string): void {
  const root = gitExec(workspace, ["rev-parse", "--show-toplevel"]);
  const actualHead = gitExec(workspace, ["rev-parse", "--verify", "HEAD"]);
  const status = gitExec(workspace, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":!.harness",
  ]);
  if (realpathSync(root) !== realpathSync(workspace) || actualHead !== headSha || status) {
    throw new Error("Review workspace no longer matches the captured Git revision");
  }
}
