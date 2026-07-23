import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAuthenticatedGitTransport, type AuthenticatedGitExecutor } from "./git.ts";

describe("authenticated Git transport", () => {
  it("keeps credentials out of arguments and static askpass content", async () => {
    const token = "github-secret+/=";
    let captured:
      | Readonly<{
          cwd: string;
          args: readonly string[];
          environment: Readonly<Record<string, string>>;
          helper: string;
          mode: number;
        }>
      | undefined;
    const executor: AuthenticatedGitExecutor = async (input) => {
      const helperPath = input.environment.GIT_ASKPASS ?? "";
      captured = {
        cwd: input.cwd,
        args: input.args,
        environment: input.environment,
        helper: await readFile(helperPath, "utf8"),
        mode: (await stat(helperPath)).mode & 0o777,
      };
      return "";
    };
    const transport = createAuthenticatedGitTransport({
      executor,
      environment: {
        PATH: process.env.PATH,
        GIT_TRACE: "1",
        GIT_CURL_VERBOSE: "1",
      },
    });

    await transport.pushBranch({
      workspace: process.cwd(),
      remote: "https://github.com/ferueda/harness.git",
      branch: "codex/FER-286",
      commitSha: "a".repeat(40),
      token,
    });

    expect(captured).toBeDefined();
    expect(captured?.cwd).not.toBe(process.cwd());
    expect(captured?.args.join(" ")).not.toContain(token);
    expect(captured?.args.join(" ")).toContain(`${"a".repeat(40)}:refs/heads/codex/FER-286`);
    expect(captured?.args.join(" ")).toContain("credential.helper=");
    expect(captured?.args.join(" ")).toContain("core.hooksPath=");
    expect(captured?.helper).not.toContain(token);
    expect(captured?.helper).toContain("HARNESS_GITHUB_TOKEN");
    expect(captured?.mode).toBe(0o700);
    expect(captured?.environment.HARNESS_GITHUB_TOKEN).toBe(token);
    expect(captured?.environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(captured?.environment.GIT_TRACE).toBeUndefined();
    expect(captured?.environment.GIT_CURL_VERBOSE).toBeUndefined();
    expect(existsSync(captured?.environment.GIT_ASKPASS ?? "")).toBe(false);
  });

  it("redacts credential forms from authenticated Git errors", async () => {
    const token = "github-secret+/=";
    const encoded = encodeURIComponent(token);
    const transport = createAuthenticatedGitTransport({
      executor: async () => {
        throw new Error(`push failed ${token} ${encoded}`);
      },
    });

    const error = await transport
      .pushBranch({
        workspace: process.cwd(),
        remote: "https://github.com/ferueda/harness.git",
        branch: "codex/FER-286",
        commitSha: "a".repeat(40),
        token,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "git-failed" });
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(encoded);
    expect(String(error)).toContain("[REDACTED]");
  });

  it("does not load hostile configuration from the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-github-hostile-config-"));
    try {
      const workspace = join(root, "workspace");
      const remote = join(root, "remote.git");
      const marker = join(root, "leaked-token");
      git(root, ["init", "--bare", remote]);
      git(root, ["clone", remote, workspace]);
      git(workspace, ["config", `url.leak::${remote}.insteadOf`, remote]);
      await writeFile(
        join(root, "git-remote-leak"),
        `#!/bin/sh\nprintf '%s' "$HARNESS_GITHUB_TOKEN" > "${marker}"\nexit 1\n`,
        { encoding: "utf8", mode: 0o700 },
      );
      await chmod(join(root, "git-remote-leak"), 0o700);

      const transport = createAuthenticatedGitTransport({
        environment: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ""}`,
        },
      });
      await expect(
        transport.readRemoteBranch({
          workspace,
          remote,
          branch: "codex/FER-286",
          token: "must-not-leak",
        }),
      ).resolves.toBeNull();
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("pushes the exact commit through isolated object access", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-github-isolated-push-"));
    try {
      const workspace = join(root, "workspace");
      const remote = join(root, "remote.git");
      git(root, ["init", "--bare", remote]);
      git(root, ["clone", remote, workspace]);
      git(workspace, ["config", "user.name", "Fixture"]);
      git(workspace, ["config", "user.email", "fixture@example.com"]);
      await writeFile(join(workspace, "README.md"), "# Fixture\n", "utf8");
      git(workspace, ["add", "README.md"]);
      git(workspace, ["commit", "-m", "Initialize fixture"]);
      const commitSha = git(workspace, ["rev-parse", "HEAD"]);

      const transport = createAuthenticatedGitTransport();
      await transport.pushBranch({
        workspace,
        remote,
        branch: "codex/FER-286",
        commitSha,
        token: "unused-for-local-remote",
      });

      expect(git(remote, ["rev-parse", "refs/heads/codex/FER-286"])).toBe(commitSha);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
