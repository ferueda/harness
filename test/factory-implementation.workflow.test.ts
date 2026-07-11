import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentRunInput, AgentSessionRef } from "../lib/agents.ts";
import {
  createFactoryImplementationRunContextForTest,
  type FactoryImplementationRunContext,
} from "../lib/factory-implementation-run-context.ts";
import type { FactoryImplementationInput } from "../lib/factory-implementation-input.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import {
  buildPatchCapture,
  FACTORY_UNTRACKED_PATCH_CAPS,
} from "../lib/factory-workspace-changes.ts";
import { renderFactoryImplementationChangeReviewHandoff } from "../lib/prompts/factory-implementation.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";
import {
  factoryStoreMetadata,
  resolveFactoryStore,
  type FactoryStoreMeta,
} from "../lib/factory-store.ts";
import { run as runFactoryImplementation } from "../workflows/factory-implementation.workflow.ts";

const WORK_ITEM = {
  id: "linear:FER-48",
  source: "linear",
  title: "Harden factory implementation",
  body: "Implement live factory implementation.",
  url: "https://linear.app/acme/issue/FER-48",
  labels: ["factory"],
  metadata: {
    tracker: { source: "linear", id: "FER-48", url: "https://linear.app/acme/issue/FER-48" },
    factoryStage: "ready-to-implement",
    factoryRoute: "ready-to-implement",
    factoryNextAction: "implement-directly",
  },
} satisfies FactoryWorkItem;

const SESSION = { provider: "cursor", id: "impl-session-1" } satisfies AgentSessionRef;

test("live provider receives workspaceGuard record and expected stream logPath", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const calls: AgentRunInput[] = [];
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run(input) {
          calls.push(input);
          writeFileSync(join(workspace, "tracked.txt"), "edited\n", "utf8");
          return okImplementer();
        },
      };
    },
  });

  await runFactoryImplementation(ctx);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.workspaceGuard).toBe("record");
  expect(calls[0]?.logPath).toBe(join(ctx.runDir, "implementation/implementer.stream.jsonl"));
  expect(calls[0]?.logPath?.endsWith("implementation/implementer.stream.jsonl")).toBe(true);
});

test("live tracked edit completes with artifacts, review refs, and matching diff", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const factoryStore = resolveFactoryStore({
    workspace,
    factoryStoreRoot: mkdtempSync(join(tmpdir(), "harness-factory-implementation-store-")),
    factoryStoreProjectId: "test-project",
    env: process.env,
  });
  const events: WorkflowEvent[] = [];
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    factoryStore: factoryStoreMetadata(factoryStore),
    eventSink(event) {
      events.push(event);
    },
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          writeFileSync(join(workspace, "tracked.txt"), "edited by implementer\n", "utf8");
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-complete");
  expect(meta.implementerSession).toEqual(SESSION);
  expect(meta.reviewBase).toMatch(/^[0-9a-f]{40}$/);
  expect(meta.reviewHead).toBe(`refs/harness/factory/${ctx.runId}/implementation`);
  expect(meta.reviewCommitSha).toMatch(/^[0-9a-f]{40}$/);
  expect(meta.eventsFile).toBe("events.jsonl");

  expect(existsSync(join(ctx.runDir, "implementation/implementer.raw.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/workspace-status.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/diff.patch"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/writer-boundary-before.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/writer-boundary-after.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/change-review-handoff.md"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "summary.md"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "meta.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "events.jsonl"))).toBe(true);

  const expectedDiff = git(workspace, [
    "diff",
    "--binary",
    `${meta.reviewBase}..${meta.reviewCommitSha}`,
  ]);
  expect(readFileSync(join(ctx.runDir, "implementation/diff.patch"), "utf8")).toBe(expectedDiff);
  expect(expectedDiff).toContain("edited by implementer");

  const status = readJson(join(ctx.runDir, "implementation/workspace-status.json")) as {
    changedFiles: string[];
    reviewBase: string;
    reviewHead: string;
    reviewCommitSha: string;
  };
  expect(status.changedFiles).toEqual(["tracked.txt"]);
  expect(status).toMatchObject({
    reviewBase: meta.reviewBase,
    reviewHead: meta.reviewHead,
    reviewCommitSha: meta.reviewCommitSha,
  });

  const handoff = readFileSync(join(ctx.runDir, "implementation/change-review-handoff.md"), "utf8");
  expectHandoffModel(handoff);
  expect(handoff).toContain("**Status:** complete");
  expect(handoff).toContain(`--base ${meta.reviewBase}`);
  expect(handoff).toContain(`--head ${meta.reviewHead}`);
  expect(handoff).toContain("Reviewer invocation: not run");

  expect(git(workspace, ["show-ref", "--verify", meta.reviewHead!])).toContain(
    meta.reviewCommitSha!,
  );
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(["run:start", "run:end"]),
  );
});

test("live untracked file completes and lists the file", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          writeFileSync(join(workspace, "new-file.ts"), "export const x = 1;\n", "utf8");
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-complete");
  const status = readJson(join(ctx.runDir, "implementation/workspace-status.json")) as {
    changedFiles: string[];
  };
  expect(status.changedFiles).toEqual(["new-file.ts"]);
  expect(meta.reviewHead).toBe(`refs/harness/factory/${ctx.runId}/implementation`);
  const expectedDiff = git(workspace, [
    "diff",
    "--binary",
    `${meta.reviewBase}..${meta.reviewCommitSha}`,
  ]);
  expect(readFileSync(join(ctx.runDir, "implementation/diff.patch"), "utf8")).toBe(expectedDiff);
  expect(expectedDiff).toContain("new-file.ts");
});

test("live untracked directory with a file completes and lists the file", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          mkdirSync(join(workspace, "new-dir"), { recursive: true });
          writeFileSync(
            join(workspace, "new-dir/nested.ts"),
            "export const nested = true;\n",
            "utf8",
          );
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-complete");
  const status = readJson(join(ctx.runDir, "implementation/workspace-status.json")) as {
    changedFiles: string[];
  };
  expect(status.changedFiles).toEqual(["new-dir/nested.ts"]);
});

test("untracked directory patch capture truncates under file cap", async () => {
  const workspace = createGitWorkspace();
  mkdirSync(join(workspace, "bulk"), { recursive: true });
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(join(workspace, `bulk/file-${i}.txt`), `content-${i}\n`, "utf8");
  }
  const porcelain = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--", ".", ":!.harness"],
    { cwd: workspace, encoding: "utf8" },
  );
  const capture = buildPatchCapture({
    workspace,
    porcelain,
    caps: { fileCap: 2 },
  });
  expect(capture.changedFiles).toEqual([
    "bulk/file-0.txt",
    "bulk/file-1.txt",
    "bulk/file-2.txt",
    "bulk/file-3.txt",
    "bulk/file-4.txt",
  ]);
  expect(capture.patchTruncated).toBe(true);
  expect(capture.truncatedUntrackedFileCount).toBeGreaterThan(0);
  // With fileCap=2, later files must not appear in the truncated patch text.
  expect(capture.patch).not.toContain("file-4.txt");
  expect(capture.patch).toContain("file-0.txt");
});

test("untracked patch capture truncates a single file over byte cap", async () => {
  const workspace = createGitWorkspace();
  writeFileSync(join(workspace, "large.txt"), `${"x".repeat(128)}\n`, "utf8");
  const porcelain = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--", ".", ":!.harness"],
    { cwd: workspace, encoding: "utf8" },
  );
  const capture = buildPatchCapture({
    workspace,
    porcelain,
    caps: { byteCap: 32 },
  });
  expect(capture.changedFiles).toEqual(["large.txt"]);
  expect(capture.patchTruncated).toBe(true);
  expect(capture.truncatedUntrackedFileCount).toBe(1);
  expect(capture.patch).not.toContain("large.txt");
});

test("changedFiles is stable-sorted across multiple edits", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          writeFileSync(join(workspace, "z-last.ts"), "z\n", "utf8");
          writeFileSync(join(workspace, "a-first.ts"), "a\n", "utf8");
          writeFileSync(join(workspace, "m-mid.ts"), "m\n", "utf8");
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-complete");
  const status = readJson(join(ctx.runDir, "implementation/workspace-status.json")) as {
    changedFiles: string[];
  };
  expect(status.changedFiles).toEqual(["a-first.ts", "m-mid.ts", "z-last.ts"]);
});

test("clean live run creates harness factory review ref", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          writeFileSync(join(workspace, "tracked.txt"), "ref check\n", "utf8");
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-complete");
  expect(meta.reviewHead).toBe(`refs/harness/factory/${ctx.runId}/implementation`);
  expect(() => git(workspace, ["show-ref", "--verify", meta.reviewHead!])).not.toThrow();
});

test("pre-existing dirty tracked edit fails before provider and creates no review ref", async () => {
  const workspace = createGitWorkspace();
  writeFileSync(join(workspace, "tracked.txt"), "dirty before run\n", "utf8");
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  let providerCalls = 0;
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          providerCalls += 1;
          throw new Error("provider should not run");
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-failed");
  expect(meta.error).toContain("clean workspace");
  expect(providerCalls).toBe(0);
  expect(meta.reviewHead).toBeUndefined();
  expect(reviewRefs(workspace)).toHaveLength(0);
  expect(readFileSync(join(ctx.runDir, "implementation/diff.patch"), "utf8")).toBe("");
  const handoff = readFileSync(join(ctx.runDir, "implementation/change-review-handoff.md"), "utf8");
  expect(handoff).toContain("_No changed files recorded._");
  expect(handoff).toContain("Pre-run porcelain status was non-empty");
});

test("pre-existing untracked file fails before provider", async () => {
  const workspace = createGitWorkspace();
  writeFileSync(join(workspace, "stray.txt"), "untracked\n", "utf8");
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  let providerCalls = 0;
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          providerCalls += 1;
          throw new Error("provider should not run");
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-failed");
  expect(meta.error).toContain("clean workspace");
  expect(providerCalls).toBe(0);
});

test("provider deletes tracked file and review ref shows deletion", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          unlinkSync(join(workspace, "tracked.txt"));
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-complete");
  const status = readJson(join(ctx.runDir, "implementation/workspace-status.json")) as {
    changedFiles: string[];
  };
  expect(status.changedFiles).toEqual(["tracked.txt"]);
  const diff = readFileSync(join(ctx.runDir, "implementation/diff.patch"), "utf8");
  expect(diff).toMatch(/deleted file mode|diff --git a\/tracked\.txt/);
  expect(diff).toContain("tracked content");
});

test("provider renames tracked file and changedFiles/diff agree", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          renameSync(join(workspace, "tracked.txt"), join(workspace, "renamed.txt"));
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-complete");
  const status = readJson(join(ctx.runDir, "implementation/workspace-status.json")) as {
    changedFiles: string[];
  };
  // Unstaged rename appears as delete + untracked in porcelain (not git R).
  expect(status.changedFiles).toEqual(["renamed.txt", "tracked.txt"]);
  const diff = readFileSync(join(ctx.runDir, "implementation/diff.patch"), "utf8");
  expect(diff).toContain("renamed.txt");
  expect(diff).toContain("tracked.txt");
  expect(status.changedFiles.every((file) => diff.includes(file))).toBe(true);
});

test("review-ref works with no ambient git user config", async () => {
  const workspace = createGitWorkspaceWithoutUserConfig();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const saved = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
  };
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;

  try {
    const ctx = createLiveCtx({
      workspace,
      runsDir,
      agentProviderFactory() {
        return {
          name: "cursor",
          async run() {
            writeFileSync(join(workspace, "tracked.txt"), "no ambient identity\n", "utf8");
            return okImplementer();
          },
        };
      },
    });

    const meta = await runFactoryImplementation(ctx);

    expect(meta.status).toBe("implementation-complete");
    expect(meta.reviewCommitSha).toMatch(/^[0-9a-f]{40}$/);
    const author = git(workspace, ["log", "-1", "--format=%an <%ae>", meta.reviewCommitSha!]);
    expect(author).toContain("Harness Factory");
    expect(author).toContain("factory@harness.local");
  } finally {
    restoreEnv(saved);
  }
});

test("provider success with review-ref creation failure maps to implementation-failed", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  let runDir = "";
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          writeFileSync(join(workspace, "tracked.txt"), "edit before review-ref fail\n", "utf8");
          // Block mkdirSync(join(runDir, "tmp")) inside createFactoryReviewHead.
          writeFileSync(join(runDir, "tmp"), "not-a-directory", "utf8");
          return okImplementer();
        },
      };
    },
  });
  runDir = ctx.runDir;

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-failed");
  expect(meta.error).toMatch(
    /Failed to materialize factory review head|ENOTDIR|EEXIST|not a directory/i,
  );
  expect(meta.reviewHead).toBeUndefined();
  expect(existsSync(join(ctx.runDir, "implementation/change-review-handoff.md"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/implementer.raw.json"))).toBe(true);
  expect(reviewRefs(workspace)).toHaveLength(0);
});

test("live run creates durable events.jsonl", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          writeFileSync(join(workspace, "tracked.txt"), "events\n", "utf8");
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-complete");
  expect(meta.eventsFile).toBe("events.jsonl");
  const eventsPath = join(ctx.runDir, "events.jsonl");
  expect(existsSync(eventsPath)).toBe(true);
  const lines = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as WorkflowEvent);
  expect(lines.map((event) => event.type)).toEqual(["run:start", "run:end"]);
});

test("provider ok:false maps to implementation-failed with artifacts", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          return { ok: false, error: "implementer crashed", exitCode: 1, raw: { error: "boom" } };
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-failed");
  expect(meta.error).toContain("implementer crashed");
  expect(existsSync(join(ctx.runDir, "implementation/implementer.raw.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/workspace-status.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/diff.patch"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/change-review-handoff.md"))).toBe(true);
  const handoff = readFileSync(join(ctx.runDir, "implementation/change-review-handoff.md"), "utf8");
  expectHandoffModel(handoff);
  expect(handoff).toContain("**Status:** blocked");
});

test("failed provider results still enforce the protected writer boundary", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const factoryStore = resolveFactoryStore({
    workspace,
    factoryStoreRoot: mkdtempSync(join(tmpdir(), "harness-factory-implementation-store-")),
    factoryStoreProjectId: "test-project",
    env: process.env,
  });
  const siblingReviewRun = join(factoryStore.reviewRunsDir, "sibling-review");
  mkdirSync(siblingReviewRun, { recursive: true });
  writeFileSync(join(siblingReviewRun, "meta.json"), "review evidence\n", "utf8");
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    factoryStore: factoryStoreMetadata(factoryStore),
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          writeFileSync(join(workspace, "tracked.txt"), "protected ref violation\n", "utf8");
          writeFileSync(join(siblingReviewRun, "meta.json"), "tampered review evidence\n", "utf8");
          execFileSync("git", ["update-ref", "refs/harness/test-protected", "HEAD"], {
            cwd: workspace,
            stdio: "ignore",
          });
          return { ok: false, error: "provider failed", exitCode: 1, raw: {} };
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-failed");
  expect(meta.error).toContain("writer boundary");
  expect(meta.failureEvidence?.boundaryViolation).toBe(true);
  expect(meta.artifacts).toHaveProperty("writerBoundaryBefore");
  expect(meta.artifacts).toHaveProperty("writerBoundaryAfter");
  expect(existsSync(join(ctx.runDir, "implementation/writer-boundary-before.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/writer-boundary-after.json"))).toBe(true);
});

test("failed evidence does not publish boundary pointers when boundary persistence fails", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const factoryStore = resolveFactoryStore({
    workspace,
    factoryStoreRoot: mkdtempSync(join(tmpdir(), "harness-factory-implementation-store-")),
    factoryStoreProjectId: "test-project",
    env: process.env,
  });
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    factoryStore: factoryStoreMetadata(factoryStore),
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          return { ok: false, error: "provider failed", exitCode: 1, raw: {} };
        },
      };
    },
  });
  mkdirSync(join(ctx.runDir, "implementation"), { recursive: true });
  mkdirSync(join(ctx.runDir, "implementation/writer-boundary-before.json"));

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-failed");
  expect(meta.failureEvidence).toBeUndefined();
  expect(meta.artifacts).not.toHaveProperty("writerBoundaryBefore");
  expect(meta.artifacts).not.toHaveProperty("writerBoundaryAfter");
  expect(existsSync(join(ctx.runDir, "implementation/partial-capture-failure.json"))).toBe(true);
});

test("provider run rejection maps to implementation-failed with artifacts", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          throw new Error("provider rejected");
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-failed");
  expect(meta.error).toContain("provider rejected");
  expect(existsSync(join(ctx.runDir, "implementation/implementer.raw.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/workspace-status.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/diff.patch"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "implementation/change-review-handoff.md"))).toBe(true);
  const handoff = readFileSync(join(ctx.runDir, "implementation/change-review-handoff.md"), "utf8");
  expect(handoff).toContain("**Status:** blocked");
  expect(handoff).toContain("provider rejected");
});

test("provider aborted result maps to implementation-failed with blocked handoff", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          return {
            ok: false,
            error: "Agent was aborted",
            exitCode: 130,
            aborted: true,
            raw: { aborted: true },
          };
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-failed");
  expect(meta.error).toContain("Agent was aborted: factory-implementation");
  const handoff = readFileSync(join(ctx.runDir, "implementation/change-review-handoff.md"), "utf8");
  expect(handoff).toContain("**Status:** blocked");
  expect(handoff).toContain("Agent was aborted");
});

test("provider ok:true without porcelain changes maps to implementation-failed", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-failed");
  expect(meta.error).toContain("without tracked workspace changes");
  expect(existsSync(join(ctx.runDir, "implementation/change-review-handoff.md"))).toBe(true);
  expect(meta.reviewHead).toBeUndefined();
});

test("completed run warns when best-effort patch capture truncates", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    agentProviderFactory() {
      return {
        name: "cursor",
        async run() {
          mkdirSync(join(workspace, "bulk"), { recursive: true });
          for (let i = 0; i <= FACTORY_UNTRACKED_PATCH_CAPS.fileCap; i += 1) {
            writeFileSync(join(workspace, `bulk/file-${i}.txt`), `content-${i}\n`, "utf8");
          }
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-complete");
  const status = readJson(join(ctx.runDir, "implementation/workspace-status.json")) as {
    patchTruncated: boolean;
    truncatedUntrackedFileCount?: number;
  };
  expect(status.patchTruncated).toBe(true);
  expect(status.truncatedUntrackedFileCount).toBeGreaterThan(0);
  const handoff = readFileSync(join(ctx.runDir, "implementation/change-review-handoff.md"), "utf8");
  expect(handoff).toContain("Best-effort workspace patch capture truncated");
  expect(handoff).toContain("review-ref diff remains authoritative");
  const diff = readFileSync(join(ctx.runDir, "implementation/diff.patch"), "utf8");
  expect(diff).toContain(`bulk/file-${FACTORY_UNTRACKED_PATCH_CAPS.fileCap}.txt`);
});

test("workflow forwards Codex implementer policy fields", async () => {
  const workspace = createGitWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-implementation-runs-"));
  const calls: AgentRunInput[] = [];
  const ctx = createLiveCtx({
    workspace,
    runsDir,
    implementerRole: {
      agent: "codex",
      model: "gpt-5.6-sol",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      modelReasoningEffort: "xhigh",
    },
    agentProviderFactory() {
      return {
        name: "codex",
        async run(input) {
          calls.push(input);
          writeFileSync(join(workspace, "tracked.txt"), "codex policy\n", "utf8");
          return okImplementer();
        },
      };
    },
  });

  const meta = await runFactoryImplementation(ctx);

  expect(meta.status).toBe("implementation-complete");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelReasoningEffort: "xhigh",
  });
});

test("handoff warning text covers truncation and empty patch warnings", () => {
  const handoff = renderFactoryImplementationChangeReviewHandoff({
    mode: "live",
    status: "implementation-failed",
    implementationInput: directInput(),
    implementerAgent: { name: "cursor", model: "composer-2.5" },
    artifacts: {
      diff: "implementation/diff.patch",
      rawOutput: "implementation/implementer.raw.json",
      workspaceStatus: "implementation/workspace-status.json",
      changeReviewHandoff: "implementation/change-review-handoff.md",
    },
    changedFiles: ["large.txt"],
    provider: { error: "failed after status changed" },
    warnings: {
      dirtyBefore: false,
      emptyPatchWithStatusChange: true,
      patchTruncated: true,
    },
  });

  expect(handoff).toContain("Warnings:");
  expect(handoff).toContain("`implementation/diff.patch` is empty while porcelain status changed");
  expect(handoff).toContain("Best-effort workspace patch capture truncated");
});

function createLiveCtx(input: {
  workspace: string;
  runsDir: string;
  factoryStore?: FactoryStoreMeta;
  eventSink?: (event: WorkflowEvent) => void;
  implementerRole?: Parameters<
    typeof createFactoryImplementationRunContextForTest
  >[0]["implementerRole"];
  agentProviderFactory: NonNullable<
    Parameters<typeof createFactoryImplementationRunContextForTest>[0]["agentProviderFactory"]
  >;
}): FactoryImplementationRunContext {
  return createFactoryImplementationRunContextForTest({
    workspace: input.workspace,
    runsDir: input.runsDir,
    workItem: WORK_ITEM,
    implementationInput: directInput(),
    implementerRole: input.implementerRole ?? { agent: "cursor", model: "composer-2.5" },
    dryRun: false,
    maxRuntimeMs: 5_000,
    ...(input.eventSink ? { eventSink: input.eventSink } : {}),
    ...(input.factoryStore ? { factoryStore: input.factoryStore } : {}),
    agentProviderFactory: input.agentProviderFactory,
  });
}

function createGitWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-implementation-ws-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspace,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "tracked.txt"), "tracked content\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

function createGitWorkspaceWithoutUserConfig(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-implementation-ws-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "tracked.txt"), "tracked content\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
    { cwd: workspace, stdio: "ignore" },
  );
  return workspace;
}

function directInput(): FactoryImplementationInput {
  return {
    mode: "direct",
    source: "linear",
    workItem: WORK_ITEM,
    metadata: {
      tracker: { source: "linear", id: "FER-48", url: "https://linear.app/acme/issue/FER-48" },
      factoryStage: "ready-to-implement",
      factoryRoute: "ready-to-implement",
      factoryNextAction: "implement-directly",
    },
    sourceMaterial: {
      title: WORK_ITEM.title,
      body: WORK_ITEM.body,
      labels: WORK_ITEM.labels,
      url: WORK_ITEM.url,
      tracker: { source: "linear", id: "FER-48", url: "https://linear.app/acme/issue/FER-48" },
    },
  };
}

function okImplementer() {
  return {
    ok: true as const,
    raw: { finalResponse: "done" },
    session: SESSION,
  };
}

function expectHandoffModel(handoff: string): void {
  expect(handoff).toContain("## Review Handoff");
  expect(handoff).toMatch(/\*\*Status:\*\*/);
  expect(handoff).toContain("### Goal");
  expect(handoff).toContain("### Scope");
  expect(handoff).toContain("### Files changed");
  expect(handoff).toContain("### Implementation notes");
  expect(handoff).toContain("### Verification");
  expect(handoff).toContain("### Risks to scrutinize");
  expect(handoff).toContain("### Open items");
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function reviewRefs(workspace: string): string[] {
  try {
    return git(workspace, ["for-each-ref", "--format=%(refname)", "refs/harness/factory"])
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
