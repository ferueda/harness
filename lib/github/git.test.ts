import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createAuthenticatedGitTransport, type AuthenticatedGitExecutor } from "./git.ts";

describe("authenticated Git transport", () => {
  it("keeps credentials out of arguments and static askpass content", async () => {
    const token = "github-secret+/=";
    let captured:
      | Readonly<{
          args: readonly string[];
          environment: Readonly<Record<string, string>>;
          helper: string;
          mode: number;
        }>
      | undefined;
    const executor: AuthenticatedGitExecutor = async (input) => {
      const helperPath = input.environment.GIT_ASKPASS ?? "";
      captured = {
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
      token,
    });

    expect(captured).toBeDefined();
    expect(captured?.args.join(" ")).not.toContain(token);
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
        token,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "git-failed" });
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(encoded);
    expect(String(error)).toContain("[REDACTED]");
  });
});
