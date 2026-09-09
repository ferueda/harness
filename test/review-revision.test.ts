import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect, test } from "vitest";
import type { AgentRunInput } from "../lib/agent/contract.ts";
import { createWorkflowContextForTest } from "../lib/review/runtime.ts";
import { run as runChangeReview } from "../workflows/change-review.workflow.ts";

const PASS = { verdict: "pass" as const, summary: "reviewed", findings: [] };

async function inRepository(run: (workspace: string, head: string) => Promise<void>) {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-binding-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Harness Test");
    git("config", "user.email", "harness@example.com");
    writeFileSync(join(workspace, "README.md"), "base\n");
    git("add", "README.md");
    git("commit", "-m", "base");
    git("switch", "-c", "topic");
    writeFileSync(join(workspace, "README.md"), "reviewed\n");
    git("commit", "-am", "reviewed");
    await run(workspace, git("rev-parse", "HEAD"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test.each(["codex", "cursor"] as const)("%s uses captured source", async (agentProvider) => {
  await inRepository(async (workspace, head) => {
    writeFileSync(join(workspace, "plan.md"), "accepted plan\n");
    writeFileSync(join(workspace, "README.md"), "uncommitted work\n");
    const invocations: AgentRunInput[] = [];
    const ctx = createWorkflowContextForTest({
      workspace,
      baseRef: "main",
      headRef: "HEAD",
      planPath: "plan.md",
      agentProvider,
      maxRuntimeMs: 1_000,
      agentProviderFactory({ provider }) {
        return {
          name: provider,
          async run(input) {
            invocations.push(input);
            expect(input.workspace).not.toBe(workspace);
            expect(readFileSync(join(input.workspace, "README.md"), "utf8")).toBe("reviewed\n");
            expect(
              execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: input.workspace,
                encoding: "utf8",
              }).trim(),
            ).toBe(head);
            const diff = input.prompt.match(/Diff file: `([^`]+)`/)?.[1];
            if (!diff) throw new Error("Missing diff reference");
            expect(isAbsolute(diff)).toBe(true);
            expect(readFileSync(diff, "utf8")).toContain("+reviewed");
            if (input.prompt.includes("implementation reviewer")) {
              const plan = input.prompt.match(/Plan file: `([^`]+)`/)?.[1];
              if (!plan) throw new Error("Missing plan reference");
              expect(isAbsolute(plan)).toBe(true);
              expect(readFileSync(plan, "utf8")).toBe("accepted plan\n");
            }
            return { ok: true, structuredOutput: PASS, raw: { structuredOutput: PASS } };
          },
        };
      },
    });
    writeFileSync(join(workspace, "README.md"), "later local work\n");
    writeFileSync(join(workspace, "plan.md"), "later plan\n");
    const result = await runChangeReview(ctx);
    expect(result.status).toBe("completed");
    expect(result.workspace).toBe(workspace);
    expect(result.scope.headSha).toBe(head);
    expect(new Set(invocations.map((input) => input.workspace)).size).toBe(2);
    for (const input of invocations) expect(existsSync(input.workspace)).toBe(false);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("later local work\n");
    expect(readFileSync(join(workspace, "plan.md"), "utf8")).toBe("later plan\n");
  });
});

const REVISION_FAILURES = ["contents", "head", "unreadable"] as const;

test.each(REVISION_FAILURES)("%s failure preserves raw evidence and a sibling", async (failure) => {
  await inRepository(async (workspace) => {
    const checkouts: string[] = [];
    const ctx = createWorkflowContextForTest({
      workspace,
      baseRef: "main",
      maxRuntimeMs: 1_000,
      agentProviderFactory({ provider }) {
        return {
          name: provider,
          async run(input) {
            checkouts.push(input.workspace);
            if (input.prompt.includes("implementation reviewer")) {
              if (failure === "contents") {
                writeFileSync(join(input.workspace, "README.md"), "wrong revision\n");
              } else if (failure === "head") {
                execFileSync("git", ["switch", "--detach", "main"], {
                  cwd: input.workspace,
                  stdio: "ignore",
                });
              } else {
                const index = execFileSync("git", ["rev-parse", "--git-path", "index"], {
                  cwd: input.workspace,
                  encoding: "utf8",
                }).trim();
                writeFileSync(index, "invalid index");
              }
            }
            return { ok: true, structuredOutput: PASS, raw: { structuredOutput: PASS } };
          },
        };
      },
    });
    const result = await runChangeReview(ctx);
    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("verdict");
    expect(result.reviewOutputs).toEqual({ quality: PASS });
    expect(result.reviewFailures).toHaveLength(1);
    expect(result.reviewFailures[0]?.stage).toBe("implementation");
    const raw = JSON.parse(
      readFileSync(join(result.runDir, "implementation-review.raw.json"), "utf8"),
    );
    expect(raw).toEqual({ structuredOutput: PASS });
    expect(existsSync(join(result.runDir, "implementation-review.json"))).toBe(false);
    for (const checkout of checkouts) expect(existsSync(checkout)).toBe(false);
  });
});
