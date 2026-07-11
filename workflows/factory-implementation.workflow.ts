import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunInput, AgentRunResult, AgentSessionRef } from "../lib/agents.ts";
import { DEFAULT_CODEX_REASONING_EFFORT } from "../lib/agents.ts";
import {
  type FactoryImplementationRunContext,
  type FactoryImplementationRunMeta,
} from "../lib/factory-implementation-run-context.ts";
import {
  createFactoryReviewHead,
  FactoryReviewHeadError,
  readFactoryReviewBase,
} from "../lib/factory-review-head.ts";
import {
  captureFactoryWorkspaceChanges,
  FactoryWorkspaceChangesError,
  isEmptyPorcelainStatus,
  type FactoryWorkspacePatchCapture,
} from "../lib/factory-workspace-changes.ts";
import {
  renderFactoryImplementationChangeReviewHandoff,
  renderFactoryImplementationPrompt,
} from "../lib/prompts/index.ts";
import {
  assertFactoryWriterBoundary,
  captureFactoryWriterBoundary,
} from "../lib/factory-writer-boundary.ts";
import {
  acquireFactoryWorkspaceWriterLease,
  releaseFactoryWorkspaceWriterLease,
  type FactoryWorkspaceWriterLeaseHandle,
} from "../lib/factory-locks.ts";
import { deriveFactoryWorkItemKey } from "../lib/factory-lifecycle.ts";

export const meta = { name: "factory-implementation" };

export async function run(
  ctx: FactoryImplementationRunContext,
): Promise<FactoryImplementationRunMeta> {
  if (ctx.dryRun) {
    return runDry(ctx);
  }
  return runLive(ctx);
}

function runDry(ctx: FactoryImplementationRunContext): FactoryImplementationRunMeta {
  const promptInput = {
    implementationInput: ctx.implementationInput,
    implementerAgent: ctx.implementerAgent,
    linearApplyRequested: ctx.linearApplyRequested,
  };
  ctx.writeDryRunArtifacts({
    prompt: renderFactoryImplementationPrompt(promptInput),
    changeReviewHandoff: renderFactoryImplementationChangeReviewHandoff({
      mode: "dry-run",
      ...promptInput,
    }),
  });
  return ctx.export({ status: "dry_run" });
}

async function runLive(
  ctx: FactoryImplementationRunContext,
): Promise<FactoryImplementationRunMeta> {
  const startedAt = new Date();
  ctx.eventSink({
    type: "run:start",
    runId: ctx.runId,
    runDir: ctx.runDir,
    workspace: ctx.workspace,
    startedAt: startedAt.toISOString(),
    status: "running",
  });

  let reviewBase: string | undefined;
  let before: FactoryWorkspacePatchCapture | undefined;
  let providerInvoked = false;
  let workspaceLease: FactoryWorkspaceWriterLeaseHandle | undefined;

  try {
    const prompt = renderFactoryImplementationPrompt({
      implementationInput: ctx.implementationInput,
      implementerAgent: ctx.implementerAgent,
      linearApplyRequested: ctx.linearApplyRequested,
    });
    ctx.writePromptArtifact({ prompt });

    before = captureFactoryWorkspaceChanges({ workspace: ctx.workspace });
    if (!isEmptyPorcelainStatus(before.porcelain)) {
      const meta = exportFailedLive({
        ctx,
        error:
          "Live factory implementation requires a clean workspace (git status --porcelain excluding .harness/).",
        before,
        after: before,
        dirtyBefore: true,
        reviewBase,
      });
      emitRunEnd(ctx, startedAt, meta);
      return meta;
    }

    reviewBase = readFactoryReviewBase(ctx.workspace);
    if (ctx.factoryStore) {
      workspaceLease = acquireFactoryWorkspaceWriterLease({
        workspace: ctx.workspace,
        factoryProjectId: ctx.factoryStore.projectId,
        storeRoot: ctx.factoryStore.storeRoot,
        workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
        runId: ctx.runId,
        operation: "implementation",
      });
    }
    const logPath = join(ctx.runDir, "implementation/implementer.stream.jsonl");
    const role = ctx.implementerRole;
    const writerBoundary = ctx.factoryStore
      ? captureFactoryWriterBoundary({
          workspace: ctx.workspace,
          lifecycleRoot: ctx.factoryStore.factoryStateRoot,
          factoryStoreRoot: ctx.factoryStore.storeRoot,
          allowedPaths: [logPath],
        })
      : undefined;
    providerInvoked = true;
    const result = await ctx.implementerProvider().run({
      workspace: ctx.workspace,
      prompt,
      model: role.model,
      ...implementerPolicyOptions(role.agent, role),
      maxRuntimeMs: ctx.maxRuntimeMs,
      logPath,
      workspaceGuard: "record",
      signal: ctx.signal,
    });
    if (writerBoundary && ctx.factoryStore) {
      assertFactoryWriterBoundary(
        writerBoundary,
        captureFactoryWriterBoundary({
          workspace: ctx.workspace,
          lifecycleRoot: ctx.factoryStore.factoryStateRoot,
          factoryStoreRoot: ctx.factoryStore.storeRoot,
          allowedPaths: [logPath],
        }),
      );
    }

    const after = captureFactoryWorkspaceChanges({ workspace: ctx.workspace });
    if (!result.ok) {
      const meta = exportFailedLive({
        ctx,
        error: result.aborted
          ? "Agent was aborted: factory-implementation"
          : `factory-implementation failed: ${result.error}`,
        before,
        after,
        raw: rawAgentArtifact(result),
        reviewBase,
      });
      emitRunEnd(ctx, startedAt, meta);
      return meta;
    }

    if (after.porcelain === before.porcelain) {
      const meta = exportFailedLive({
        ctx,
        error: "Implementer completed without tracked workspace changes",
        before,
        after,
        raw: rawAgentArtifact(result),
        reviewBase,
        implementerSession: result.session,
      });
      emitRunEnd(ctx, startedAt, meta);
      return meta;
    }

    let reviewHead;
    try {
      reviewHead = createFactoryReviewHead({
        workspace: ctx.workspace,
        runDir: ctx.runDir,
        runId: ctx.runId,
        reviewBase,
      });
    } catch (error) {
      const meta = exportFailedLive({
        ctx,
        error: errorMessage(error),
        before,
        after,
        raw: rawAgentArtifact(result),
        reviewBase,
        implementerSession: result.session,
      });
      emitRunEnd(ctx, startedAt, meta);
      return meta;
    }

    const streamLogWritten = existsSync(logPath);
    const workspaceStatus = {
      before: before.porcelain,
      after: after.porcelain,
      beforePatchSha256: before.patchSha256,
      afterPatchSha256: after.patchSha256,
      changedFiles: after.changedFiles,
      patchTruncated: after.patchTruncated,
      ...(after.truncatedUntrackedFileCount !== undefined
        ? { truncatedUntrackedFileCount: after.truncatedUntrackedFileCount }
        : {}),
      reviewBase: reviewHead.reviewBase,
      reviewHead: reviewHead.reviewHead,
      reviewCommitSha: reviewHead.reviewCommitSha,
    };
    const emptyPatchWithStatusChange = reviewHead.diffPatch.length === 0;
    const changeReviewHandoff = renderFactoryImplementationChangeReviewHandoff({
      mode: "live",
      status: "implementation-complete",
      implementationInput: ctx.implementationInput,
      implementerAgent: ctx.implementerAgent,
      artifacts: {
        diff: "implementation/diff.patch",
        rawOutput: "implementation/implementer.raw.json",
        workspaceStatus: "implementation/workspace-status.json",
        changeReviewHandoff: "implementation/change-review-handoff.md",
        ...(streamLogWritten ? { streamLog: "implementation/implementer.stream.jsonl" } : {}),
      },
      changedFiles: after.changedFiles,
      provider: {
        session: result.session,
      },
      review: {
        reviewBase: reviewHead.reviewBase,
        reviewHead: reviewHead.reviewHead,
        reviewCommitSha: reviewHead.reviewCommitSha,
      },
      warnings: {
        dirtyBefore: false,
        emptyPatchWithStatusChange,
        patchTruncated: after.patchTruncated,
      },
    });

    ctx.writeLiveArtifacts({
      raw: rawAgentArtifact(result),
      workspaceStatus,
      diff: reviewHead.diffPatch,
      changeReviewHandoff,
    });

    const meta = ctx.export({
      status: "implementation-complete",
      implementerSession: result.session,
      reviewBase: reviewHead.reviewBase,
      reviewHead: reviewHead.reviewHead,
      reviewCommitSha: reviewHead.reviewCommitSha,
      reviewTree: reviewHead.treeSha,
      includeLiveArtifacts: true,
    });
    emitRunEnd(ctx, startedAt, meta);
    return meta;
  } catch (error) {
    if (
      error instanceof FactoryWorkspaceChangesError ||
      error instanceof FactoryReviewHeadError ||
      providerInvoked
    ) {
      let after = before;
      try {
        after = captureFactoryWorkspaceChanges({ workspace: ctx.workspace });
      } catch {
        // Best-effort after capture for failure artifacts.
      }
      const meta = exportFailedLive({
        ctx,
        error: errorMessage(error),
        before,
        after: after ?? before,
        dirtyBefore: before ? !isEmptyPorcelainStatus(before.porcelain) : false,
        reviewBase,
      });
      emitRunEnd(ctx, startedAt, meta);
      return meta;
    }
    ctx.eventSink({
      type: "run:end",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
      status: "failed",
      durationMs: Date.now() - startedAt.getTime(),
      error: errorMessage(error),
    });
    throw error;
  } finally {
    if (workspaceLease) releaseFactoryWorkspaceWriterLease({ handle: workspaceLease });
  }
}

function exportFailedLive(input: {
  ctx: FactoryImplementationRunContext;
  error: string;
  before?: FactoryWorkspacePatchCapture;
  after?: FactoryWorkspacePatchCapture;
  raw?: unknown;
  dirtyBefore?: boolean;
  reviewBase?: string;
  implementerSession?: AgentSessionRef;
}): FactoryImplementationRunMeta {
  const before = input.before ?? emptyCapture();
  const after = input.after ?? before;
  const streamLogWritten = existsSync(
    join(input.ctx.runDir, "implementation/implementer.stream.jsonl"),
  );
  const workspaceStatus = {
    before: before.porcelain,
    after: after.porcelain,
    beforePatchSha256: before.patchSha256,
    afterPatchSha256: after.patchSha256,
    changedFiles: after.changedFiles,
    patchTruncated: after.patchTruncated,
    ...(after.truncatedUntrackedFileCount !== undefined
      ? { truncatedUntrackedFileCount: after.truncatedUntrackedFileCount }
      : {}),
    ...(input.reviewBase ? { reviewBase: input.reviewBase } : {}),
  };
  const emptyPatchWithStatusChange =
    !input.dirtyBefore && after.porcelain !== before.porcelain && after.patch.length === 0;
  const diff = input.dirtyBefore ? "" : after.patch;
  const changeReviewHandoff = renderFactoryImplementationChangeReviewHandoff({
    mode: "live",
    status: "implementation-failed",
    implementationInput: input.ctx.implementationInput,
    implementerAgent: input.ctx.implementerAgent,
    artifacts: {
      diff: "implementation/diff.patch",
      rawOutput: "implementation/implementer.raw.json",
      workspaceStatus: "implementation/workspace-status.json",
      changeReviewHandoff: "implementation/change-review-handoff.md",
      ...(streamLogWritten ? { streamLog: "implementation/implementer.stream.jsonl" } : {}),
    },
    changedFiles: input.dirtyBefore ? [] : after.changedFiles,
    provider: {
      session: input.implementerSession,
      error: input.error,
    },
    warnings: {
      dirtyBefore: input.dirtyBefore ?? false,
      emptyPatchWithStatusChange,
      patchTruncated: input.dirtyBefore ? false : after.patchTruncated,
    },
  });

  input.ctx.writeLiveArtifacts({
    raw: input.raw ?? { error: input.error },
    workspaceStatus,
    diff,
    changeReviewHandoff,
  });

  return input.ctx.export({
    status: "implementation-failed",
    error: input.error,
    implementerSession: input.implementerSession,
    reviewBase: input.reviewBase,
    includeLiveArtifacts: true,
  });
}

function emitRunEnd(
  ctx: FactoryImplementationRunContext,
  startedAt: Date,
  meta: FactoryImplementationRunMeta,
): void {
  ctx.eventSink({
    type: "run:end",
    runId: ctx.runId,
    runDir: ctx.runDir,
    workspace: ctx.workspace,
    status: meta.status === "implementation-complete" ? "completed" : "failed",
    durationMs: Date.now() - startedAt.getTime(),
    ...(meta.error ? { error: meta.error } : {}),
  });
}

function implementerPolicyOptions(
  providerName: string,
  role: FactoryImplementationRunContext["implementerRole"],
): Pick<AgentRunInput, "sandboxMode" | "approvalPolicy" | "modelReasoningEffort"> {
  if (providerName !== "codex") return {};
  return {
    sandboxMode: role.sandboxMode,
    approvalPolicy: role.approvalPolicy,
    modelReasoningEffort: role.modelReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
  };
}

function rawAgentArtifact(result: AgentRunResult): unknown {
  if (result.ok || result.raw !== undefined) return result.raw;
  return { error: result.error };
}

function emptyCapture(): FactoryWorkspacePatchCapture {
  return {
    porcelain: "",
    patch: "",
    patchSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    changedFiles: [],
    patchTruncated: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
