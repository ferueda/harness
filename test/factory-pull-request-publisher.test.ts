import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  publishFactoryPullRequest,
  type FactoryCommandRunner,
} from "../lib/factory-pull-request-publisher.ts";

test("pushes an absent exact head, creates one PR, and reuses both on retry", () => {
  const fixture = repository();
  let pullRequests: unknown[] = [];
  const creates = vi.fn<() => void>();
  const pushes = vi.fn<() => void>();
  const runner: FactoryCommandRunner = (command, args, options) => {
    if (command === "git") {
      if (args[0] === "push") pushes();
      return execFileSync("git", [...args], { cwd: options.cwd, encoding: "utf8" });
    }
    if (args[1] === "list") return JSON.stringify(pullRequests);
    if (args[1] === "create") {
      creates();
      pullRequests = [
        {
          url: "https://example.test/repo/pull/1",
          baseRefName: "main",
          headRefName: "feature",
          headRefOid: fixture.head,
        },
      ];
      return "https://example.test/repo/pull/1\n";
    }
    throw new Error(`unexpected gh command ${args.join(" ")}`);
  };
  const input = {
    workspace: fixture.workspace,
    baseRef: "main",
    headBranch: "refs/heads/feature",
    headSha: fixture.head,
    title: "Reviewed change",
    body: "Reviewed body",
  };

  expect(publishFactoryPullRequest(input, runner).url).toContain("/pull/1");
  expect(publishFactoryPullRequest(input, runner).url).toContain("/pull/1");
  expect(pushes).toHaveBeenCalledTimes(1);
  expect(creates).toHaveBeenCalledTimes(1);
});

test("rejects a divergent remote head before GitHub mutation", () => {
  const fixture = repository();
  git(fixture.workspace, ["switch", "main"]);
  writeFileSync(join(fixture.workspace, "remote-only.txt"), "remote\n");
  git(fixture.workspace, ["add", "remote-only.txt"]);
  git(fixture.workspace, ["commit", "-m", "remote only"]);
  git(fixture.workspace, ["push", "origin", "HEAD:refs/heads/feature"]);
  git(fixture.workspace, ["switch", "feature"]);
  const gh = vi.fn<() => void>();
  const runner: FactoryCommandRunner = (command, args, options) => {
    if (command === "gh") {
      gh();
      return "[]";
    }
    return execFileSync("git", [...args], { cwd: options.cwd, encoding: "utf8" });
  };

  expect(() =>
    publishFactoryPullRequest(
      {
        workspace: fixture.workspace,
        baseRef: "main",
        headBranch: "feature",
        headSha: fixture.head,
        title: "Reviewed change",
        body: "Reviewed body",
      },
      runner,
    ),
  ).toThrow(/diverges/);
  expect(gh).not.toHaveBeenCalled();
});

function repository(): { workspace: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-pr-publisher-"));
  const workspace = join(root, "workspace");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["init", "-b", "main", workspace]);
  git(workspace, ["config", "user.name", "Test"]);
  git(workspace, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(workspace, "base.txt"), "base\n");
  git(workspace, ["add", "base.txt"]);
  git(workspace, ["commit", "-m", "base"]);
  git(workspace, ["remote", "add", "origin", origin]);
  git(workspace, ["push", "-u", "origin", "main"]);
  git(workspace, ["switch", "-c", "feature"]);
  writeFileSync(join(workspace, "feature.txt"), "feature\n");
  git(workspace, ["add", "feature.txt"]);
  git(workspace, ["commit", "-m", "feature"]);
  return { workspace, head: git(workspace, ["rev-parse", "HEAD"]).trim() };
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}
