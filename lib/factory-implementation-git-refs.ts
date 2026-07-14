import { execFileSync } from "node:child_process";

export type FactoryImplementationGitAuthority = {
  head: string;
  branchRef: string;
  branchTip: string;
  phaseRefs: string;
};

export function readFactoryImplementationGitAuthority(input: {
  workspace: string;
  branchRef: string;
  phaseRunId: string;
}): FactoryImplementationGitAuthority {
  return {
    head: git(input.workspace, ["rev-parse", "--verify", "HEAD"]).trim(),
    branchRef: git(input.workspace, ["symbolic-ref", "-q", "HEAD"]).trim(),
    branchTip: git(input.workspace, ["rev-parse", "--verify", input.branchRef]).trim(),
    phaseRefs: git(input.workspace, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      `refs/harness/factory/${input.phaseRunId}/`,
    ]),
  };
}

export function sameFactoryImplementationGitAuthority(
  before: FactoryImplementationGitAuthority,
  after: FactoryImplementationGitAuthority,
): boolean {
  return (
    before.head === after.head &&
    before.branchRef === after.branchRef &&
    before.branchTip === after.branchTip &&
    before.phaseRefs === after.phaseRefs
  );
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
