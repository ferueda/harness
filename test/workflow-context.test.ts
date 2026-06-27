import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  cleanupOrphanedRunDir,
  createWorkflowContext,
  createWorkflowContextForTest,
} from "../lib/workflow-context.ts";
import type { AgentRunInput } from "../lib/agents.ts";
import type { AgentProviderOptions } from "../lib/agent-provider.ts";

function createGitWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: workspace });
  writeFileSync(join(workspace, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

test("cleanupOrphanedRunDir removes incomplete run directories", () => {
  const runDir = mkdtempSync(join(tmpdir(), "harness-orphaned-run-"));
  mkdirSync(join(runDir, "context"));
  expect(cleanupOrphanedRunDir(runDir)).toBe(true);
  expect(existsSync(runDir)).toBe(false);
});
test("cleanupOrphanedRunDir preserves runs with metadata", () => {
  const runDir = mkdtempSync(join(tmpdir(), "harness-run-"));
  writeFileSync(join(runDir, "meta.json"), "{}\n", "utf8");
  expect(cleanupOrphanedRunDir(runDir)).toBe(false);
  expect(existsSync(runDir)).toBe(true);
});
test("exportFailed writes metadata and summary with no successful reviews", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContext({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    maxRuntimeMs: 1_000,
  });

  const meta = ctx.exportFailed({
    title: "Change Review Summary",
    reviews: [],
    failedReviews: [
      { key: "implementation", stage: "implementation", error: "implementation failed" },
    ],
    steps: {
      workflow: "change-review",
      availableSteps: ["implementation", "quality", "simplify"],
      requestedSteps: ["implementation"],
      executedSteps: ["implementation"],
      omittedSteps: ["quality", "simplify"],
      partial: true,
    },
  });

  expect(meta.status).toBe("failed");
  expect(meta.workflow).toBe("change-review");
  expect(meta.partial).toBe(true);
  expect(meta.omittedSteps).toEqual(["quality", "simplify"]);
  expect("verdict" in meta).toBe(false);
  expect(meta.reviews).toEqual({});
  expect("failedReviews" in meta ? meta.failedReviews : undefined).toEqual([
    { key: "implementation", stage: "implementation", error: "implementation failed" },
  ]);
  expect(readFileSync(join(ctx.runDir, "meta.json"), "utf8")).toContain('"status": "failed"');
  const summary = readFileSync(join(ctx.runDir, "summary.md"), "utf8");
  expect(summary).toMatch(/## Steps/);
  expect(summary).toMatch(/## Failed reviewers/);
  expect(summary).toMatch(/implementation failed/);
});

test("dry-run export writes workflow step metadata", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContext({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    maxRuntimeMs: 1_000,
    dryRun: true,
  });

  const meta = ctx.export({
    title: "Change Review Summary",
    reviews: [],
    verdict: "pass",
    steps: {
      workflow: "change-review",
      availableSteps: ["implementation", "quality", "simplify"],
      requestedSteps: ["implementation"],
      executedSteps: ["implementation"],
      omittedSteps: ["quality", "simplify"],
      partial: true,
    },
  });

  expect(meta.status).toBe("dry_run");
  expect(meta.workflow).toBe("change-review");
  expect(meta.executedSteps).toEqual(["implementation"]);
  expect(meta.omittedSteps).toEqual(["quality", "simplify"]);
  expect("streamArtifacts" in meta).toBe(false);
});

test("workflow context passes Cursor provider to factory", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const calls: { providerOptions?: AgentProviderOptions } = {};
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProvider: "cursor",
    dryRun: true,
    agentProviderFactory(options) {
      calls.providerOptions = options;
      return {
        name: options.provider,
        async run() {
          throw new Error("dry-run should not call provider");
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  const meta = ctx.export({ title: "Change Review Summary", reviews: [], verdict: "pass" });

  expect(calls.providerOptions).toMatchObject({ provider: "cursor" });
  expect(ctx.reviewConcurrency).toBe("parallel");
  expect(meta.agent).toMatchObject({ name: "cursor", model: "composer-2.5" });
});

test("workflow context keeps Cursor reviews parallel by default", () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProvider: "cursor",
    dryRun: true,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          throw new Error("dry-run should not call provider");
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  expect(ctx.reviewConcurrency).toBe("parallel");
});

test("workflow context validates provider structured output as review output", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProvider: "cursor",
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return {
            ok: true,
            structuredOutput: { verdict: "pass", summary: "missing findings" },
            raw: {
              structuredOutput: { verdict: "pass", summary: "missing findings" },
            },
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  await expect(ctx.agent("review-implementation")).rejects.toThrow(
    /Invalid reviewer structured output: findings:/,
  );
  const raw = JSON.parse(readFileSync(join(ctx.runDir, "implementation-review.raw.json"), "utf8"));
  expect(raw.structuredOutput.summary).toBe("missing findings");
});

test("workflow context rejects Cursor findings without rationale", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProvider: "cursor",
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return {
            ok: true,
            structuredOutput: {
              verdict: "needs_changes",
              summary: "missing rationale",
              findings: [
                {
                  title: "Missing rationale",
                  severity: "Medium",
                  location: "lib/example.ts:1",
                  issue: "No rationale field",
                  recommendation: "Add rationale",
                  must_fix: true,
                },
              ],
            },
            raw: { ok: true },
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  await expect(ctx.agent("review-implementation")).rejects.toThrow(
    /Invalid reviewer structured output: findings\.0\.rationale:/,
  );
});

test("workflow context rejects Codex findings with extra properties", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProvider: "codex",
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return {
            ok: true,
            structuredOutput: {
              verdict: "needs_changes",
              summary: "extra property",
              findings: [
                {
                  title: "Extra property",
                  severity: "Medium",
                  location: "lib/example.ts:1",
                  issue: "Unexpected field",
                  recommendation: "Remove field",
                  rationale: "The workflow schema should reject unknown finding keys.",
                  must_fix: false,
                  extra: "nope",
                },
              ],
            },
            raw: { ok: true },
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  await expect(ctx.agent("review-implementation")).rejects.toThrow(
    /Invalid reviewer structured output: findings\.0: .*extra/i,
  );
});

test("workflow context rejects Codex findings without rationale", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProvider: "codex",
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return {
            ok: true,
            structuredOutput: {
              verdict: "needs_changes",
              summary: "missing rationale",
              findings: [
                {
                  title: "Missing rationale",
                  severity: "Medium",
                  location: "lib/example.ts:1",
                  issue: "No rationale field",
                  recommendation: "Add rationale",
                  must_fix: true,
                },
              ],
            },
            raw: { ok: true },
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  await expect(ctx.agent("review-implementation")).rejects.toThrow(
    /Invalid reviewer structured output: findings\.0\.rationale:/,
  );
});

test("workflow context passes Codex review sandbox and approval defaults", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const calls: {
    providerOptions?: AgentProviderOptions;
    input?: AgentRunInput;
  } = {};
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProvider: "codex",
    agentProviderFactory(options) {
      calls.providerOptions = options;
      return {
        name: options.provider,
        async run(input) {
          calls.input = input;
          return {
            ok: true,
            structuredOutput: {
              verdict: "pass",
              summary: "ok",
              findings: [],
            },
            raw: { ok: true },
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  const review = await ctx.agent("review-implementation");

  expect(review.verdict).toBe("pass");
  expect(calls.providerOptions).toMatchObject({ provider: "codex" });
  expect(calls.input).toMatchObject({
    model: "gpt-5.5",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
  });
});

test("workflow context passes reviewer stream log paths and exports metadata", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const calls: { input?: AgentRunInput } = {};
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProvider: "cursor",
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          calls.input = input;
          if (!input.logPath) throw new Error("missing logPath");
          writeFileSync(input.logPath, '{"event":"streamed"}\n', "utf8");
          return {
            ok: true,
            structuredOutput: {
              verdict: "pass",
              summary: "ok",
              findings: [],
            },
            raw: {
              streamLog: {
                path: input.logPath,
                status: "written",
                provider: "cursor",
                format: "cursor-sdk-message",
              },
            },
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  const review = await ctx.agent("review-implementation");
  const meta = ctx.export({
    title: "Change Review Summary",
    reviews: [{ key: "implementation", title: "Implementation review", review }],
    verdict: "pass",
  });

  const expectedPath = join(ctx.runDir, "implementation-review.stream.jsonl");
  expect(calls.input?.logPath).toBe(expectedPath);
  expect((meta as { streamArtifacts?: unknown }).streamArtifacts).toMatchObject({
    implementation: {
      path: expectedPath,
      status: "written",
      provider: "cursor",
      format: "cursor-sdk-message",
      bytes: 21,
    },
  });
});

test("workflow context includes stream artifacts for failed reviewers", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProvider: "codex",
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          if (!input.logPath) throw new Error("missing logPath");
          writeFileSync(input.logPath, '{"event":"partial"}\n', "utf8");
          return {
            ok: false,
            error: "review failed",
            exitCode: 1,
            raw: {
              streamLog: {
                path: input.logPath,
                status: "written",
                provider: "codex",
                format: "codex-thread-event",
              },
            },
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  await expect(ctx.agent("review-implementation")).rejects.toThrow(/review failed/);
  const meta = ctx.exportFailed({
    title: "Change Review Summary",
    reviews: [],
    failedReviews: [{ key: "implementation", stage: "implementation", error: "review failed" }],
  });

  expect((meta as { streamArtifacts?: unknown }).streamArtifacts).toMatchObject({
    implementation: {
      status: "written",
      provider: "codex",
      format: "codex-thread-event",
    },
  });
});

test("workflow context surfaces aborted provider results distinctly", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return {
            ok: false,
            aborted: true,
            error: "Agent was aborted",
            exitCode: 130,
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  await expect(ctx.agent("review-implementation")).rejects.toThrow(
    "Agent was aborted: implementation reviewer",
  );
});

test("workflow context passes explicit Codex sandbox and approval overrides", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const calls: { input?: AgentRunInput } = {};
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProvider: "codex",
    model: "gpt-test",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelReasoningEffort: "medium",
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          calls.input = input;
          return {
            ok: true,
            structuredOutput: {
              verdict: "pass",
              summary: "ok",
              findings: [],
            },
            raw: { ok: true },
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  await ctx.agent("review-implementation");

  expect(calls.input).toMatchObject({
    model: "gpt-test",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelReasoningEffort: "medium",
  });
});
