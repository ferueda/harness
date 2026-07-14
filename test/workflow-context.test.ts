import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  cleanupOrphanedRunDir,
  createWorkflowContext,
  createWorkflowContextForTest,
} from "../lib/workflow-context.ts";
import type { AgentProviderOptions, AgentRunInput } from "../lib/agents.ts";
import { SPEC_REVIEW_PROMPT } from "../lib/prompts/index.ts";
import { createAgentProvider } from "../providers/registry.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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

function createPlainWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  writeFileSync(join(workspace, "plan.md"), "# Plan\n\nImplement a thing.\n", "utf8");
  return workspace;
}

function reviewFinding(must_fix: boolean) {
  return {
    title: "Review finding",
    severity: "Medium" as const,
    location: "Plan",
    issue: "The review found an issue.",
    recommendation: "Update the plan.",
    rationale: "The test needs a complete finding shape.",
    must_fix,
  };
}

test("spec review prompt stays aligned with review-spec dimensions and schema verdicts", () => {
  for (const keyword of [
    "Architecture",
    "Feasibility",
    "Simplicity",
    "Project Alignment",
    "intent source",
    "docs/project-intent.md",
    "VISION.md",
    "Reliability",
    "Performance",
    "Security",
    "Edge Cases",
    "Testing",
    "pass",
    "needs_changes",
    "blocked",
    "must_fix",
    "one-call-site abstractions",
  ]) {
    expect(SPEC_REVIEW_PROMPT).toContain(keyword);
  }
  expect(SPEC_REVIEW_PROMPT).toContain("Intent source gate");
  expect(SPEC_REVIEW_PROMPT).toContain("docs-architecture");
  expect(SPEC_REVIEW_PROMPT).toContain("minimum sufficient executable plan");
  expect(SPEC_REVIEW_PROMPT).toContain("Unsupported work already proposed by the plan");
  expect(SPEC_REVIEW_PROMPT).toContain("Review content, not template completeness");
  expect(SPEC_REVIEW_PROMPT).toContain("highest existing stable seam proving acceptance");
  expect(SPEC_REVIEW_PROMPT).toContain("A finding may use `must_fix: true` only for");
  expect(SPEC_REVIEW_PROMPT).toContain("Reviewer-proposed optional hardening");
  expect(SPEC_REVIEW_PROMPT).toContain("smallest exact missing evidence or human question");
  expect(SPEC_REVIEW_PROMPT).toContain('verdict: "needs_changes"` only when at least one finding');
  expect(SPEC_REVIEW_PROMPT).toContain("Blocked is exempt");

  const reviewSpecSkill = readFileSync(join(REPO_ROOT, "skills/review-spec/SKILL.md"), "utf8");
  expect(reviewSpecSkill).toContain("Project Alignment");
  expect(reviewSpecSkill).toContain("Intent Source Gate");
  expect(reviewSpecSkill).toContain("Narrow bug fixes");
  expect(reviewSpecSkill).toContain("docs-architecture");
  expect(reviewSpecSkill).toContain("Unsupported work already proposed by the plan");
  expect(reviewSpecSkill).toContain("Plan Contract");
  expect(reviewSpecSkill).toContain("highest existing stable seam proving acceptance");
  expect(reviewSpecSkill).toContain("Finding Contract");
  expect(reviewSpecSkill).toContain("work-item authority");
  expect(reviewSpecSkill).toContain("unmarked proposals, comments, and metadata");
  expect(reviewSpecSkill).toContain("post-change owner, exact removals and cutover order");
  expect(reviewSpecSkill).toContain("failure handling, state or data flow, privacy, or security");
  expect(reviewSpecSkill).toContain("Reviewer-proposed optional hardening");
  expect(reviewSpecSkill).toContain("original source request and accepted task decisions");
  expect(reviewSpecSkill).toContain("smallest exact missing");
  expect(reviewSpecSkill).toContain("`title`, `severity`, `location`");
  expect(reviewSpecSkill).toContain("**Must fix**: Yes | No");
  expect(reviewSpecSkill).toContain("**Verdict**: Pass | Needs changes | Blocked");
  expect(reviewSpecSkill).not.toContain("**Category**");
});

test("cleanupOrphanedRunDir removes incomplete run directories", () => {
  const runDir = mkdtempSync(join(tmpdir(), "harness-orphaned-run-"));
  mkdirSync(join(runDir, "context"));
  expect(cleanupOrphanedRunDir(runDir)).toBe(true);
  expect(existsSync(runDir)).toBe(false);
});

test("workflow context supports spec review dry-runs without git scope", async () => {
  const workspace = createPlainWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    planPath: "plan.md",
    runsDir,
    includeGitScope: false,
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

  await expect(ctx.agent("review-spec")).resolves.toMatchObject({ verdict: "pass" });
  expect(readFileSync(join(ctx.runDir, "context/plan.md"), "utf8")).toBe(
    "# Plan\n\nImplement a thing.\n",
  );
  expect(existsSync(join(ctx.runDir, "context/diff.patch"))).toBe(false);
  expect(existsSync(join(ctx.runDir, "spec-review.json"))).toBe(true);

  const prompt = readFileSync(join(ctx.runDir, "spec-review.prompt.md"), "utf8");
  expect(prompt).toContain("Plan file:");
  expect(prompt).toContain("context/plan.md");
  expect(prompt).not.toContain("Diff file:");
  expect(prompt).not.toContain("{{DIFF_REF}}");
});

test("workflow context rejects contradictory reviewer verdicts after preserving raw evidence", async () => {
  const invalidReviews = [
    {
      verdict: "needs_changes",
      summary: "Only advice remains.",
      findings: [reviewFinding(false)],
      expectedError: "needs_changes requires at least one must_fix finding",
    },
    {
      verdict: "pass",
      summary: "A blocker remains.",
      findings: [reviewFinding(true)],
      expectedError: "pass cannot include must_fix findings",
    },
  ] as const;

  for (const invalidReview of invalidReviews) {
    const { expectedError, ...structuredOutput } = invalidReview;
    const workspace = createPlainWorkspace();
    const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
    const ctx = createWorkflowContextForTest({
      workspace,
      planPath: "plan.md",
      runsDir,
      includeGitScope: false,
      agentProviderFactory(options) {
        return {
          name: options.provider,
          async run() {
            return {
              ok: true,
              structuredOutput,
              raw: { structuredOutput },
            };
          },
        };
      },
      maxRuntimeMs: 1_000,
    });

    await expect(ctx.agent("review-spec")).rejects.toThrow(expectedError);
    expect(existsSync(join(ctx.runDir, "spec-review.raw.json"))).toBe(true);
    expect(existsSync(join(ctx.runDir, "spec-review.json"))).toBe(false);
  }
});

test("verdict checks exempt blocked reviews", async () => {
  const blockedWorkspace = createPlainWorkspace();
  const blockedCtx = createWorkflowContextForTest({
    workspace: blockedWorkspace,
    planPath: "plan.md",
    runsDir: mkdtempSync(join(tmpdir(), "harness-runs-")),
    includeGitScope: false,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return {
            ok: true,
            structuredOutput: { verdict: "blocked", summary: "Need a decision.", findings: [] },
            raw: { ok: true },
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });
  await expect(blockedCtx.agent("review-spec")).resolves.toMatchObject({ verdict: "blocked" });
});

test("change reviewers enforce the verdict contract", async () => {
  const implementationWorkspace = createGitWorkspace();
  const implementationCtx = createWorkflowContextForTest({
    workspace: implementationWorkspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir: mkdtempSync(join(tmpdir(), "harness-runs-")),
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return {
            ok: true,
            structuredOutput: {
              verdict: "needs_changes",
              summary: "Only advice remains.",
              findings: [reviewFinding(false)],
            },
            raw: { ok: true },
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });
  await expect(implementationCtx.agent("review-implementation")).rejects.toThrow(
    "needs_changes requires at least one must_fix finding",
  );
  expect(existsSync(join(implementationCtx.runDir, "implementation-review.raw.json"))).toBe(true);
  expect(existsSync(join(implementationCtx.runDir, "implementation-review.json"))).toBe(false);
});

test("workflow context exports spec review summaries without git scope", () => {
  const workspace = createPlainWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    planPath: "plan.md",
    runsDir,
    includeGitScope: false,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          throw new Error("not used");
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  const meta = ctx.export({
    title: "Plan Review Summary",
    reviews: [
      {
        key: "spec",
        title: "Spec review",
        review: { verdict: "pass", summary: "ok", findings: [] },
      },
    ],
    verdict: "pass",
  });

  expect("scope" in meta).toBe(false);

  const summary = readFileSync(join(ctx.runDir, "summary.md"), "utf8");
  expect(summary).toContain("# Plan Review Summary");
  expect(summary).not.toContain("**Scope**");
  expect(summary).not.toContain("**Head SHA**");
  const metadata = JSON.parse(readFileSync(join(ctx.runDir, "meta.json"), "utf8"));
  expect(metadata.scope).toBeUndefined();
  expect(metadata.reviews).toMatchObject({ spec: { verdict: "pass", findingCount: 0 } });
  expect(metadata.specReview).toMatchObject({ verdict: "pass", findingCount: 0 });
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
    agentProviderFactory: createAgentProvider,
  });

  const meta = ctx.exportFailed({
    title: "Change Review Summary",
    reviews: [],
    failedReviews: [
      { key: "implementation", stage: "implementation", error: "implementation failed" },
    ],
    steps: {
      workflow: "change-review",
      availableSteps: ["implementation", "quality"],
      requestedSteps: ["implementation"],
      executedSteps: ["implementation"],
      omittedSteps: ["quality"],
      partial: true,
    },
  });

  expect(meta.status).toBe("failed");
  expect(meta.workflow).toBe("change-review");
  expect(meta.partial).toBe(true);
  expect(meta.omittedSteps).toEqual(["quality"]);
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
    agentProviderFactory: createAgentProvider,
  });

  const meta = ctx.export({
    title: "Change Review Summary",
    reviews: [],
    verdict: "pass",
    steps: {
      workflow: "change-review",
      availableSteps: ["implementation", "quality"],
      requestedSteps: ["implementation"],
      executedSteps: ["implementation"],
      omittedSteps: ["quality"],
      partial: true,
    },
  });

  expect(meta.status).toBe("dry_run");
  expect(meta.workflow).toBe("change-review");
  expect(meta.executedSteps).toEqual(["implementation"]);
  expect(meta.omittedSteps).toEqual(["quality"]);
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
  expect(meta.agent).toMatchObject({ name: "cursor", model: "grok-4.5" });
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
    model: "gpt-5.6-sol",
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
                agentMessageCount: 2,
                finalAgentMessageId: "message-final",
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
      agentMessageCount: 2,
      finalAgentMessageId: "message-final",
    },
  });
});

test("workflow context forwards run signal to provider", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const controller = new AbortController();
  const calls: { signal?: AbortSignal } = {};
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    signal: controller.signal,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          calls.signal = input.signal;
          controller.abort();
          return {
            ok: false,
            error: "Agent was aborted",
            exitCode: 130,
            aborted: true,
          };
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  await expect(ctx.agent("review-implementation")).rejects.toThrow(
    "Agent was aborted: implementation reviewer",
  );
  expect(calls.signal).toBe(controller.signal);
  expect(calls.signal?.aborted).toBe(true);
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
