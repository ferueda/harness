import { git } from "./factory-publication-git.ts";

export function prepareImplementationPublication(input: {
  workspace: string;
  branchRef: string;
  baseRef: string;
  reviewedHead: string;
  title: string;
  workItemKey: string;
}) {
  const branch = git(input.workspace, [
    "rev-parse",
    "--verify",
    `${input.branchRef}^{commit}`,
  ]).trim();
  if (branch !== input.reviewedHead)
    throw new Error("Implementation branch tip does not match the final reviewed candidate");
  const current = git(input.workspace, ["symbolic-ref", "-q", "HEAD"]).trim();
  if (current !== input.branchRef)
    throw new Error(`Implementation publication requires persisted branch ${input.branchRef}`);
  if (git(input.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]).trim())
    throw new Error("Implementation publication requires a clean workspace");
  return {
    baseRef: input.baseRef,
    headBranch: input.branchRef,
    headSha: input.reviewedHead,
    title: input.title,
    body: `Factory reviewed implementation for ${input.workItemKey}.\n\nReviewed head: ${input.reviewedHead}`,
  };
}
