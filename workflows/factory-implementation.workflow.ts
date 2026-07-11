import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunInput, AgentRunResult, AgentSessionRef } from "../lib/agents.ts";
import { DEFAULT_CODEX_REASONING_EFFORT } from "../lib/agents.ts";
import {
  type FactoryImplementationRunContext,
  type FactoryImplementationFailureEvidence,
  type FactoryImplementationRunMeta,
} from "../lib/factory-implementation-run-context.ts";
import {
  createFactoryReviewHead,
  createFactoryPartialEvidenceCandidate,
  deleteFactoryCandidateRefIfMatches,
  FactoryReviewHeadError,
  readFactoryCandidateTree,
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
  let workspaceLease: FactoryWorkspaceWriterLeaseHandle | undefined = ctx.writerLease;
  const ownsWorkspaceLease = !workspaceLease;
  let boundaryBefore: ReturnType<typeof captureFactoryWriterBoundary> | undefined;
  let boundaryAfter: ReturnType<typeof captureFactoryWriterBoundary> | undefined;

  try {
    const prompt = renderFactoryImplementationPrompt({
      implementationInput: ctx.implementationInput,
      implementerAgent: ctx.implementerAgent,
      linearApplyRequested: ctx.linearApplyRequested,
    });
    ctx.writePromptArtifact({ prompt });

    if (ctx.factoryStore && !workspaceLease) {
      workspaceLease = acquireFactoryWorkspaceWriterLease({
        workspace: ctx.workspace,
        factoryProjectId: ctx.factoryStore.projectId,
        storeRoot: ctx.factoryStore.storeRoot,
        workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
        runId: ctx.runId,
        operation: "implementation",
        ...(ctx.workspaceLeaseEnv ? { env: ctx.workspaceLeaseEnv } : {}),
      });
      ctx.writerLease = workspaceLease;
    }
    // Acquire the physical-workspace lease before the final clean/tree probe.
    // This closes the check-to-provider race with another Factory station.
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
    const logPath = join(ctx.runDir, "implementation/implementer.stream.jsonl");
    // Pre-create the provider log so a symlinked custom runs root has stable
    // boundary metadata before the provider starts appending to it.
    writeFileSync(logPath, "", "utf8");
    const role = ctx.implementerRole;
    const writerBoundary = ctx.factoryStore
      ? (boundaryBefore = captureFactoryWriterBoundary({
          workspace: ctx.workspace,
          lifecycleRoot: ctx.factoryStore.factoryStateRoot,
          factoryStoreRoot: ctx.factoryStore.storeRoot,
          durablePaths: [ctx.factoryStore.factoryRunsDir, ctx.factoryStore.reviewRunsDir],
          allowedPaths: [logPath],
        }))
      : undefined;
    providerInvoked = true;
    let result: AgentRunResult | undefined;
    let providerError: unknown;
    try {
      result = await ctx.implementerProvider().run({
        workspace: ctx.workspace,
        prompt,
        model: role.model,
        ...implementerPolicyOptions(role.agent, role),
        maxRuntimeMs: ctx.maxRuntimeMs,
        logPath,
        workspaceGuard: "record",
        signal: ctx.signal,
      });
    } catch (error) {
      providerError = error;
    }
    if (writerBoundary && ctx.factoryStore) {
      try {
        boundaryAfter = captureFactoryWriterBoundary({
          workspace: ctx.workspace,
          lifecycleRoot: ctx.factoryStore.factoryStateRoot,
          factoryStoreRoot: ctx.factoryStore.storeRoot,
          durablePaths: [ctx.factoryStore.factoryRunsDir, ctx.factoryStore.reviewRunsDir],
          allowedPaths: [logPath],
        });
        assertFactoryWriterBoundary(writerBoundary, boundaryAfter);
      } catch (boundaryError) {
        if (providerError) {
          throw new AggregateError(
            [providerError, boundaryError],
            `Factory provider failed and violated the writer boundary: ${errorMessage(boundaryError)}`,
          );
        }
        throw boundaryError;
      }
    }
    if (providerError) {
      throw providerError;
    }
    if (!result) {
      throw new Error("Factory provider returned no result.");
    }

    const after = captureFactoryWorkspaceChanges({ workspace: ctx.workspace });
    if (!result.ok) {
      const failureEvidence = tryPersistInitialFailureEvidence({
        ctx,
        before,
        after,
        reviewBase,
        boundaryBefore,
        boundaryAfter,
      });
      const meta = exportFailedLive({
        ctx,
        error: result.aborted
          ? "Agent was aborted: factory-implementation"
          : `factory-implementation failed: ${result.error}`,
        before,
        after,
        raw: rawAgentArtifact(result),
        reviewBase,
        failureEvidence,
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
      if (ctx.factoryStore && !boundaryAfter) {
        try {
          boundaryAfter = captureFactoryWriterBoundary({
            workspace: ctx.workspace,
            lifecycleRoot: ctx.factoryStore.factoryStateRoot,
            factoryStoreRoot: ctx.factoryStore.storeRoot,
            durablePaths: [ctx.factoryStore.factoryRunsDir, ctx.factoryStore.reviewRunsDir],
          });
        } catch {
          // Best-effort boundary evidence for failure artifacts.
        }
      }
      const failureEvidence =
        before && after
          ? tryPersistInitialFailureEvidence({
              ctx,
              before,
              after,
              reviewBase,
              boundaryBefore,
              boundaryAfter,
            })
          : undefined;
      const meta = exportFailedLive({
        ctx,
        error: errorMessage(error),
        before,
        after: after ?? before,
        dirtyBefore: before ? !isEmptyPorcelainStatus(before.porcelain) : false,
        reviewBase,
        failureEvidence,
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
    if (ownsWorkspaceLease && workspaceLease) {
      releaseFactoryWorkspaceWriterLease({ handle: workspaceLease });
    }
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
  failureEvidence?: FactoryImplementationFailureEvidence;
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
    ...(input.failureEvidence ? { failureEvidence: input.failureEvidence } : {}),
  });
}

function persistInitialFailureEvidence(input: {
  ctx: FactoryImplementationRunContext;
  before: FactoryWorkspacePatchCapture;
  after: FactoryWorkspacePatchCapture;
  reviewBase?: string;
  boundaryBefore?: ReturnType<typeof captureFactoryWriterBoundary>;
  boundaryAfter?: ReturnType<typeof captureFactoryWriterBoundary>;
}): FactoryImplementationFailureEvidence | undefined {
  const changed =
    input.before.porcelain !== input.after.porcelain ||
    input.before.patchSha256 !== input.after.patchSha256;
  if (!changed || !input.reviewBase) {
    if (input.boundaryBefore && input.boundaryAfter) {
      writeFileSync(
        join(input.ctx.runDir, "implementation/writer-boundary-before.json"),
        `${JSON.stringify(input.boundaryBefore, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(
        join(input.ctx.runDir, "implementation/writer-boundary-after.json"),
        `${JSON.stringify(input.boundaryAfter, null, 2)}\n`,
        "utf8",
      );
      return { boundary: true };
    }
    return undefined;
  }
  let partial: ReturnType<typeof createFactoryPartialEvidenceCandidate> | undefined;
  try {
    partial = createFactoryPartialEvidenceCandidate({
      workspace: input.ctx.workspace,
      runDir: input.ctx.runDir,
      implementationRunId: input.ctx.runId,
      attemptId: input.ctx.runId,
      reviewIndex: 0,
      parentCandidate: {
        ref: input.reviewBase,
        commit: input.reviewBase,
        tree: readFactoryCandidateTree(input.ctx.workspace, input.reviewBase),
      },
      originalReviewBase: input.reviewBase,
    });
    writeFileSync(
      join(input.ctx.runDir, "implementation/partial-candidate-ref.json"),
      `${JSON.stringify(partial, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(input.ctx.runDir, "implementation/recovery.json"),
      `${JSON.stringify({ before: input.before, after: input.after, partialCandidate: partial }, null, 2)}\n`,
      "utf8",
    );
    if (input.boundaryBefore && input.boundaryAfter) {
      writeFileSync(
        join(input.ctx.runDir, "implementation/writer-boundary-before.json"),
        `${JSON.stringify(input.boundaryBefore, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(
        join(input.ctx.runDir, "implementation/writer-boundary-after.json"),
        `${JSON.stringify(input.boundaryAfter, null, 2)}\n`,
        "utf8",
      );
    }
    return {
      partialCandidate: { ref: partial.ref, commit: partial.commit, tree: partial.tree },
      ...(input.boundaryBefore && input.boundaryAfter ? { boundary: true } : {}),
    };
  } catch (error) {
    if (partial) {
      try {
        deleteFactoryCandidateRefIfMatches({
          workspace: input.ctx.workspace,
          ref: partial.ref,
          commit: partial.commit,
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to persist implementation failure evidence and clean up ${partial.ref}: ${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`,
        );
      }
    }
    throw error;
  }
}

function tryPersistInitialFailureEvidence(
  input: Parameters<typeof persistInitialFailureEvidence>[0],
): FactoryImplementationFailureEvidence | undefined {
  try {
    return persistInitialFailureEvidence(input);
  } catch (error) {
    try {
      writeFileSync(
        join(input.ctx.runDir, "implementation/partial-capture-failure.json"),
        `${JSON.stringify({ error: errorMessage(error), before: input.before, after: input.after }, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // Preserve the provider/boundary failure when the durable store is also unavailable.
    }
    return input.boundaryBefore && input.boundaryAfter ? { boundary: true } : undefined;
  }
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
