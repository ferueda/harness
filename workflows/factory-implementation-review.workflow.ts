import { existsSync, lstatSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendImplementationReviewCheckpointedEvent,
  appendImplementationReviewCompletedEvent,
  appendImplementationReviewFailedEvent,
  appendImplementationReviewStartedEvent,
  appendImplementationReviewUnresolvedEvent,
} from "../lib/factory-implementation-review-lifecycle-writes.ts";
import {
  CandidateTupleSchema,
  parseFactoryImplementationRemediationOutput,
  type FactoryImplementationRemediationOutput,
} from "../lib/factory-implementation-review-schemas.ts";
import {
  normalizeFactoryImplementationReviewFindings,
  type NormalizedFactoryImplementationReview,
  type FactoryImplementationReviewFinding,
} from "../lib/factory-implementation-review-findings.ts";
import type {
  FactoryImplementationReviewRunContext,
  FactoryImplementationReviewRunMeta,
} from "../lib/factory-implementation-review-run-context.ts";
import {
  validateFactoryCandidateTuple,
  createFactoryPartialEvidenceCandidate,
  createFactoryRemediationCandidate,
  FactoryReviewHeadError,
} from "../lib/factory-review-head.ts";
import { resolveFactoryArtifactPointer } from "../lib/factory-implementation-review-input.ts";
import {
  captureFactoryWorkspaceChanges,
  FactoryWorkspaceChangesError,
  type FactoryWorkspacePatchCapture,
} from "../lib/factory-workspace-changes.ts";
import {
  factoryExecutionProvenance,
  factoryLifecycleExecutionProvenance,
} from "../lib/factory-store.ts";
import { createWorkflowContext } from "../lib/workflow-context.ts";
import { run as runChangeReview } from "./change-review.workflow.ts";
import {
  renderFactoryImplementationPrReadyHandoff,
  renderFactoryImplementationRemediationPrompt,
} from "../lib/prompts/factory-implementation-review.ts";
import { errorMessage } from "../lib/agent-invoke.ts";
import type { AgentRunResult } from "../lib/agents.ts";
import {
  acquireFactoryWorkspaceWriterLease,
  releaseFactoryWorkspaceWriterLease,
  type FactoryWorkspaceWriterLeaseHandle,
} from "../lib/factory-locks.ts";
import {
  deriveFactoryWorkItemKey,
  loadFactoryLifecycleState,
  readFactoryLifecycleEvents,
} from "../lib/factory-lifecycle.ts";
import {
  assertFactoryWriterBoundary,
  captureFactoryWriterBoundary,
  FactoryWriterBoundaryError,
} from "../lib/factory-writer-boundary.ts";

export const meta = { name: "factory-implementation-review" };

export const REMEDIATION_SCHEMA_PATH = resolveRemediationSchemaPath();

function resolveRemediationSchemaPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "../schemas/factory-implementation-remediation-output.schema.json"),
    join(moduleDir, "../../schemas/factory-implementation-remediation-output.schema.json"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Factory remediation output schema is not installed.");
  return path;
}

type ReviewState = FactoryImplementationReviewRunContext["checkpoint"];
type ReviewFailureClassification = "provider" | "git" | "artifact" | "protocol" | "workspace";

export async function run(
  ctx: FactoryImplementationReviewRunContext,
): Promise<FactoryImplementationReviewRunMeta> {
  try {
    return await runReviewLoop(ctx);
  } catch (error) {
    return failUnexpectedReview(ctx, error);
  }
}

async function runReviewLoop(
  ctx: FactoryImplementationReviewRunContext,
): Promise<FactoryImplementationReviewRunMeta> {
  let checkpoint = startAttempt(ctx);
  // Claim lifecycle ownership before writing the full attempt context. The
  // reservation remains the durable evidence for a rejected claim.
  ctx.writeIdentityContext();
  let candidate = checkpoint.approvedCandidate;
  let completedReviewCount = checkpoint.completedReviewCount;
  let candidateVersion = checkpoint.candidateVersion;
  let recoveryFindings: RestoredPartialRecovery | undefined;
  try {
    recoveryFindings = restorePartialRecovery(ctx, checkpoint);
  } catch (error) {
    return failedArtifact(
      ctx,
      checkpoint,
      completedReviewCount,
      candidateVersion,
      errorMessage(error),
    );
  }
  const restoredHistory = restoreReviewHistory(ctx);
  const attempts: Array<{
    attemptId: string;
    reviewIndex: number;
    nestedReviewRefs: string[];
    decisions: Array<{ findingId: string; decision: string; rationale: string }>;
  }> = [];
  attempts.push(...restoredHistory.attempts);
  const acceptedDebt: AcceptedDebt[] = [...restoredHistory.acceptedDebt];

  while (true) {
    let normalized: NormalizedFactoryImplementationReview;
    let reviewIndex: number;
    let nestedReviewRefs: string[] = [];
    const partialRecovery = recoveryFindings;
    if (partialRecovery) {
      reviewIndex = partialRecovery.reviewIndex;
      normalized = partialRecovery.normalized;
      recoveryFindings = undefined;
      validateFactoryCandidateTuple({
        workspace: ctx.workspace,
        candidate: checkpoint.approvedCandidate,
        expectedOriginalBase: checkpoint.originalReviewBase,
        expectedWorkspaceTree: false,
        expectedImplementationRunId: ctx.implementationRunId,
        expectedCandidateVersion: checkpoint.candidateVersion,
      });
      validateFactoryCandidateTuple({
        workspace: ctx.workspace,
        candidate: checkpoint.partialRecovery!.tuple,
        expectedOriginalBase: checkpoint.originalReviewBase,
        expectedWorkspaceTree: true,
        expectedParentCommit: checkpoint.approvedCandidate.commit,
        expectedImplementationRunId: ctx.implementationRunId,
        expectedPartialAttemptId: checkpoint.partialRecovery!.attemptId,
        expectedPartialReviewIndex: checkpoint.partialRecovery!.reviewIndex,
      });
    } else {
      validateFactoryCandidateTuple({
        workspace: ctx.workspace,
        candidate,
        expectedOriginalBase: checkpoint.originalReviewBase,
        expectedWorkspaceTree: true,
        expectedImplementationRunId: ctx.implementationRunId,
        expectedCandidateVersion: candidateVersion,
      });
      reviewIndex = completedReviewCount + 1;
      const nested = await runNestedReview(ctx, candidate);
      if (nested.status === "failed") {
        const recovery = nested.runId
          ? ctx.writeArtifact(`iterations/${reviewIndex}/nested-review-failure.json`, {
              nestedRunId: nested.runId,
              nestedRunDir: nested.runDir,
              error: nested.error,
            })
          : undefined;
        ctx.writeSummary(
          `# Factory Implementation Review\n\n- Status: review-failed\n- Classification: reviewer\n- Error: ${nested.error}\n`,
        );
        appendImplementationReviewFailedEvent({
          factoryStateRoot: ctx.factoryStore.factoryStateRoot,
          workItem: ctx.workItem,
          runId: ctx.runId,
          owningImplementationRunId: ctx.implementationRunId,
          activeReviewAttemptId: ctx.runId,
          latestCheckpointId: checkpoint.latestCheckpointId,
          classification: "reviewer",
          retryable: true,
          error: nested.error,
          summary: pointer(ctx.runId, "summary.md"),
          ...(recovery
            ? {
                recovery: pointer(
                  ctx.runId,
                  `iterations/${reviewIndex}/nested-review-failure.json`,
                ),
              }
            : {}),
          execution: reviewExecution(ctx),
        });
        return ctx.export({
          status: "review-failed",
          completedReviewCount,
          candidateVersion,
          approvedCandidate: candidate,
          error: nested.error,
        });
      }

      normalized = normalizeFactoryImplementationReviewFindings(nested.reviews);
      nestedReviewRefs = [nested.runDir];
      ctx.writeArtifact(`iterations/${reviewIndex}/review-findings.json`, normalized.findings);
      ctx.writeArtifact(`iterations/${reviewIndex}/change-review-ref.json`, {
        runId: nested.runId,
        runDir: nested.runDir,
        baseRef: checkpoint.originalReviewBase,
        headRef: candidate.ref,
      });
      completedReviewCount += 1;
      const reviewCheckpointId = `implementation.review.checkpointed:${ctx.runId}:${reviewIndex}:review`;
      appendImplementationReviewCheckpointedEvent({
        factoryStateRoot: ctx.factoryStore.factoryStateRoot,
        workItem: ctx.workItem,
        checkpointId: reviewCheckpointId,
        expectedCheckpointId: checkpoint.latestCheckpointId,
        owningImplementationRunId: ctx.implementationRunId,
        activeReviewAttemptId: ctx.runId,
        phase: "review",
        completedReviewCount,
        candidateVersion,
        originalReviewBase: checkpoint.originalReviewBase,
        approvedCandidate: candidate,
        implementerSession: checkpoint.implementerSession,
        workspace: checkpoint.workspace,
        runRoots: checkpoint.runRoots,
        activeReviewIndex: reviewIndex,
        review: pointer(nested.runId, "implementation-review.json", "review"),
        candidate: pointer(ctx.runId, `iterations/${reviewIndex}/change-review-ref.json`),
        effectiveReviewLimit: checkpoint.effectiveReviewLimit,
        execution: reviewExecution(ctx),
      });
      checkpoint = {
        ...checkpoint,
        checkpointId: reviewCheckpointId,
        latestCheckpointId: reviewCheckpointId,
        completedReviewCount,
        activeReviewAttemptId: ctx.runId,
        activeReviewIndex: reviewIndex,
        latestReview: pointer(nested.runId, "meta.json", "review"),
      };
    }
    const attempt = {
      attemptId: ctx.runId,
      reviewIndex,
      nestedReviewRefs,
      decisions: [] as Array<{ findingId: string; decision: string; rationale: string }>,
    };
    const attemptRecord = upsertAttempt(attempts, attempt);

    if (normalized.verdict === "blocked") {
      return unresolved(
        ctx,
        checkpoint,
        candidate,
        completedReviewCount,
        candidateVersion,
        "blocked",
      );
    }
    if (normalized.findings.length === 0) {
      return complete(
        ctx,
        checkpoint,
        candidate,
        completedReviewCount,
        candidateVersion,
        attempts,
        acceptedDebt,
      );
    }
    if (!partialRecovery && completedReviewCount >= checkpoint.effectiveReviewLimit.value) {
      return unresolved(
        ctx,
        checkpoint,
        candidate,
        completedReviewCount,
        candidateVersion,
        "max-iterations",
      );
    }

    const result = await remediate(ctx, checkpoint, candidate, normalized.findings, reviewIndex);
    try {
      if (result.kind === "failed") {
        const changed = workspaceCaptureChanged(result.before, result.after);
        return result.unresolvedReason && !changed
          ? unresolved(
              ctx,
              checkpoint,
              candidate,
              completedReviewCount,
              candidateVersion,
              result.unresolvedReason,
            )
          : failedAfterRemediation(
              ctx,
              checkpoint,
              candidate,
              completedReviewCount,
              candidateVersion,
              reviewIndex,
              result,
              normalized.findings,
              normalized.roles,
            );
      }
      attemptRecord.decisions.push(...result.output.findingDecisions);
      addAcceptedDebt(
        acceptedDebt,
        normalized.findings,
        result.output.findingDecisions,
        ctx.runId,
        reviewIndex,
      );
      const declinedMustFix = normalized.findings.filter(
        (finding) => finding.must_fix && result.decisions.get(finding.id)?.decision === "decline",
      );
      const changed = workspaceCaptureChanged(result.before, result.after);
      if (declinedMustFix.length > 0) {
        if (changed) {
          const partial = capturePartial(
            ctx,
            candidate,
            reviewIndex,
            result.before,
            result.after,
            "declined-must-fix",
            normalized.findings,
            normalized.roles,
          );
          if (partial.recovery) {
            const checkpointId = `implementation.review.checkpointed:${ctx.runId}:${reviewIndex}:partial`;
            appendImplementationReviewCheckpointedEvent({
              factoryStateRoot: ctx.factoryStore.factoryStateRoot,
              workItem: ctx.workItem,
              checkpointId,
              expectedCheckpointId: checkpoint.latestCheckpointId,
              owningImplementationRunId: ctx.implementationRunId,
              activeReviewAttemptId: ctx.runId,
              phase: "remediation",
              completedReviewCount,
              candidateVersion,
              originalReviewBase: checkpoint.originalReviewBase,
              approvedCandidate: candidate,
              implementerSession: checkpoint.implementerSession,
              workspace: checkpoint.workspace,
              runRoots: checkpoint.runRoots,
              activeReviewIndex: reviewIndex,
              decision: pointer(ctx.runId, `iterations/${reviewIndex}/remediation.json`),
              partialRecovery: partial.recovery,
              effectiveReviewLimit: checkpoint.effectiveReviewLimit,
              execution: reviewExecution(ctx),
            });
            checkpoint = { ...checkpoint, checkpointId, latestCheckpointId: checkpointId };
          } else if (partial.failure) {
            return failedAfterRemediation(
              ctx,
              checkpoint,
              candidate,
              completedReviewCount,
              candidateVersion,
              reviewIndex,
              {
                kind: "failed",
                error: `Unable to persist declined-must-fix partial evidence: ${partial.failure}`,
                before: result.before,
                after: result.after,
                lease: result.lease,
                classification: "artifact",
              },
              normalized.findings,
              normalized.roles,
            );
          }
        }
        return unresolved(
          ctx,
          checkpoint,
          candidate,
          completedReviewCount,
          candidateVersion,
          "declined-must-fix",
        );
      }
      if (
        !changed &&
        result.output.findingDecisions.some((decision) => decision.decision !== "decline")
      ) {
        return failedProtocol(
          ctx,
          checkpoint,
          candidate,
          completedReviewCount,
          candidateVersion,
          "Implement/adapt decision returned without workspace changes.",
        );
      }
      if (
        partialRecovery &&
        result.output.findingDecisions.every((decision) => decision.decision === "decline")
      ) {
        return failedProtocol(
          ctx,
          checkpoint,
          candidate,
          completedReviewCount,
          candidateVersion,
          "Partial recovery requires an implement/adapt decision; declined recovery cannot complete with an unapproved workspace.",
        );
      }
      if (
        !changed &&
        result.output.findingDecisions.every((decision) => decision.decision === "decline")
      ) {
        return complete(
          ctx,
          checkpoint,
          candidate,
          completedReviewCount,
          candidateVersion,
          attempts,
          acceptedDebt,
        );
      }
      if (changed) {
        try {
          const nextCandidateHead = createFactoryRemediationCandidate({
            workspace: ctx.workspace,
            runDir: ctx.runDir,
            implementationRunId: ctx.implementationRunId,
            candidateVersion: candidateVersion + 1,
            priorCandidate: checkpoint.approvedCandidate,
            originalReviewBase: checkpoint.originalReviewBase,
          });
          const nextCandidate = candidateTuple(nextCandidateHead);
          const nextCandidateVersion = candidateVersion + 1;
          validateFactoryCandidateTuple({
            workspace: ctx.workspace,
            candidate: nextCandidate,
            expectedOriginalBase: checkpoint.originalReviewBase,
            expectedParentCommit: checkpoint.approvedCandidate.commit,
            expectedImplementationRunId: ctx.implementationRunId,
            expectedCandidateVersion: nextCandidateVersion,
          });
          const checkpointId = `implementation.review.checkpointed:${ctx.runId}:${reviewIndex}:candidate`;
          ctx.writeArtifact(`iterations/${reviewIndex}/candidate-ref.json`, nextCandidateHead);
          appendImplementationReviewCheckpointedEvent({
            factoryStateRoot: ctx.factoryStore.factoryStateRoot,
            workItem: ctx.workItem,
            checkpointId,
            expectedCheckpointId: checkpoint.latestCheckpointId,
            owningImplementationRunId: ctx.implementationRunId,
            activeReviewAttemptId: ctx.runId,
            phase: "remediation",
            completedReviewCount,
            candidateVersion: nextCandidateVersion,
            originalReviewBase: checkpoint.originalReviewBase,
            approvedCandidate: nextCandidate,
            implementerSession: checkpoint.implementerSession,
            workspace: checkpoint.workspace,
            runRoots: checkpoint.runRoots,
            activeReviewIndex: reviewIndex,
            decision: pointer(ctx.runId, `iterations/${reviewIndex}/remediation.json`),
            candidate: pointer(ctx.runId, `iterations/${reviewIndex}/candidate-ref.json`),
            effectiveReviewLimit: checkpoint.effectiveReviewLimit,
            execution: reviewExecution(ctx),
          });
          checkpoint = {
            ...checkpoint,
            checkpointId,
            latestCheckpointId: checkpointId,
            approvedCandidate: nextCandidate,
            candidateVersion: nextCandidateVersion,
            partialRecovery: undefined,
          };
          candidateVersion = nextCandidateVersion;
          candidate = nextCandidate;
        } catch (error) {
          return failedAfterRemediation(
            ctx,
            checkpoint,
            candidate,
            completedReviewCount,
            candidateVersion,
            reviewIndex,
            {
              kind: "failed",
              error: errorMessage(error),
              before: result.before,
              after: result.after,
              lease: result.lease,
              classification: classifyUnexpectedReviewError(error),
            },
            normalized.findings,
            normalized.roles,
          );
        }
      }
    } finally {
      if (result.lease) releaseFactoryWorkspaceWriterLease({ handle: result.lease });
    }
  }
}

function startAttempt(ctx: FactoryImplementationReviewRunContext): ReviewState {
  const priorAttempt = ctx.checkpoint.activeReviewAttemptId ?? ctx.checkpoint.priorReviewAttemptId;
  const expectedActiveAttempt = ctx.checkpoint.activeReviewAttemptId ?? null;
  const priorAttemptCount = readFactoryLifecycleEvents({
    factoryStateRoot: ctx.factoryStore.factoryStateRoot,
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
  }).filter(
    (event) =>
      event.type === "implementation.review.started" &&
      event.data.owningImplementationRunId === ctx.implementationRunId,
  ).length;
  const activeReviewIndex =
    ctx.checkpoint.activeReviewIndex ?? ctx.checkpoint.completedReviewCount + 1;
  const event = appendImplementationReviewStartedEvent({
    factoryStateRoot: ctx.factoryStore.factoryStateRoot,
    workItem: ctx.workItem,
    owningImplementationRunId: ctx.implementationRunId,
    activeReviewAttemptId: ctx.runId,
    attemptIndex: priorAttemptCount + 1,
    activeReviewIndex,
    ...(priorAttempt ? { priorReviewAttemptId: priorAttempt } : {}),
    resume: priorAttempt !== undefined,
    expectedCheckpointId: ctx.checkpoint.latestCheckpointId,
    expectedActiveReviewAttemptId: expectedActiveAttempt,
    originalReviewBase: ctx.checkpoint.originalReviewBase,
    approvedCandidate: ctx.checkpoint.approvedCandidate,
    implementerSession: ctx.checkpoint.implementerSession,
    workspace: ctx.checkpoint.workspace,
    runRoots: ctx.checkpoint.runRoots,
    effectiveReviewLimit: ctx.checkpoint.effectiveReviewLimit,
    candidateVersion: ctx.checkpoint.candidateVersion,
    completedReviewCount: ctx.checkpoint.completedReviewCount,
    execution: reviewExecution(ctx),
  });
  return {
    ...ctx.checkpoint,
    checkpointId: event.id,
    latestCheckpointId: event.id,
    activeReviewAttemptId: ctx.runId,
    priorReviewAttemptId: priorAttempt,
    activeReviewIndex,
  };
}

type RestoredPartialRecovery = {
  reviewIndex: number;
  normalized: NormalizedFactoryImplementationReview;
};

type ReviewAttemptRecord = {
  attemptId: string;
  reviewIndex: number;
  nestedReviewRefs: string[];
  decisions: Array<{ findingId: string; decision: string; rationale: string }>;
};

function upsertAttempt(
  attempts: ReviewAttemptRecord[],
  incoming: ReviewAttemptRecord,
): ReviewAttemptRecord {
  const existing = attempts.find(
    (attempt) =>
      attempt.attemptId === incoming.attemptId && attempt.reviewIndex === incoming.reviewIndex,
  );
  if (!existing) {
    attempts.push(incoming);
    return incoming;
  }
  existing.nestedReviewRefs = [
    ...new Set([...existing.nestedReviewRefs, ...incoming.nestedReviewRefs]),
  ];
  for (const decision of incoming.decisions) {
    if (!existing.decisions.some((item) => item.findingId === decision.findingId)) {
      existing.decisions.push(decision);
    }
  }
  return existing;
}

function addAcceptedDebt(
  acceptedDebt: Array<AcceptedDebt>,
  findings: readonly FactoryImplementationReviewFinding[],
  decisions: readonly FactoryImplementationRemediationOutput["findingDecisions"][number][],
  attemptId: string,
  reviewIndex: number,
): void {
  const nonBlockingIds = new Set(
    findings.filter((finding) => !finding.must_fix).map((finding) => finding.id),
  );
  for (const decision of decisions) {
    if (decision.decision !== "decline" || !nonBlockingIds.has(decision.findingId)) continue;
    if (
      !acceptedDebt.some(
        (item) =>
          item.attemptId === attemptId &&
          item.reviewIndex === reviewIndex &&
          item.findingId === decision.findingId,
      )
    ) {
      acceptedDebt.push({
        findingId: decision.findingId,
        rationale: decision.rationale,
        attemptId,
        reviewIndex,
      });
    }
  }
}

type AcceptedDebt = {
  findingId: string;
  rationale: string;
  attemptId: string;
  reviewIndex: number;
};

function restoreReviewHistory(ctx: FactoryImplementationReviewRunContext): {
  attempts: ReviewAttemptRecord[];
  acceptedDebt: AcceptedDebt[];
} {
  const events = readFactoryLifecycleEvents({
    factoryStateRoot: ctx.factoryStore.factoryStateRoot,
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
  });
  const attempts: ReviewAttemptRecord[] = [];
  const acceptedDebt: AcceptedDebt[] = [];
  const findingsByAttempt = new Map<string, FactoryImplementationReviewFinding[]>();
  for (const event of events) {
    if (event.type !== "implementation.review.checkpointed") continue;
    const index = event.data.activeReviewIndex;
    if (index === undefined) continue;
    const attempt = upsertAttempt(attempts, {
      attemptId: event.data.activeReviewAttemptId,
      reviewIndex: index,
      nestedReviewRefs: [],
      decisions: [],
    });
    if (event.data.review) {
      const nestedMetaPath = resolveFactoryArtifactPointer({
        pointer: event.data.review,
        runRoots: event.data.runRoots,
      });
      const nestedRunDir = dirname(nestedMetaPath);
      attempt.nestedReviewRefs = [...new Set([...attempt.nestedReviewRefs, nestedRunDir])];
      const normalized = normalizeFactoryImplementationReviewFindings({
        implementation: readNestedReview(nestedRunDir, "implementation-review.json"),
        quality: readNestedReview(nestedRunDir, "quality-review.json"),
        simplify: readNestedReview(nestedRunDir, "simplify-review.json"),
      });
      findingsByAttempt.set(
        reviewHistoryKey(event.data.activeReviewAttemptId, index),
        normalized.findings,
      );
      const decisionPointer = event.data.decision;
      if (decisionPointer) {
        const decisionPath = resolveFactoryArtifactPointer({
          pointer: decisionPointer,
          runRoots: event.data.runRoots,
        });
        const output = parseFactoryImplementationRemediationOutput(
          JSON.parse(readFileSync(decisionPath, "utf8")) as unknown,
        );
        attempt.decisions.push(...output.findingDecisions);
        addAcceptedDebt(
          acceptedDebt,
          normalized.findings,
          output.findingDecisions,
          event.data.activeReviewAttemptId,
          index,
        );
      }
    } else if (event.data.decision) {
      const decisionPath = resolveFactoryArtifactPointer({
        pointer: event.data.decision,
        runRoots: event.data.runRoots,
      });
      const output = parseFactoryImplementationRemediationOutput(
        JSON.parse(readFileSync(decisionPath, "utf8")) as unknown,
      );
      attempt.decisions.push(...output.findingDecisions);
      const findings = findingsByAttempt.get(
        reviewHistoryKey(event.data.activeReviewAttemptId, index),
      );
      if (findings) {
        addAcceptedDebt(
          acceptedDebt,
          findings,
          output.findingDecisions,
          event.data.activeReviewAttemptId,
          index,
        );
      }
    }
  }
  return { attempts, acceptedDebt };
}

function reviewHistoryKey(attemptId: string, reviewIndex: number): string {
  return `${attemptId}:${reviewIndex}`;
}

function restorePartialRecovery(
  ctx: FactoryImplementationReviewRunContext,
  checkpoint: ReviewState,
): RestoredPartialRecovery | undefined {
  const partial = checkpoint.partialRecovery;
  if (!partial) return undefined;
  if (partial.recovery.runId !== partial.attemptId) {
    throw new Error("Partial recovery pointer must reference its owning review attempt.");
  }
  if (partial.reviewIndex !== Number(partial.reviewIndex)) {
    throw new Error("Partial recovery review index is invalid.");
  }
  for (const artifact of [partial.status, partial.patch, partial.recovery]) {
    if (
      artifact.runId !== partial.attemptId ||
      artifact.root !== "review" ||
      !artifact.path.startsWith(`iterations/${partial.reviewIndex}/`)
    ) {
      throw new Error("Partial recovery artifacts do not match its owning attempt/index.");
    }
  }
  const recoveryPath = resolveFactoryArtifactPointer({
    pointer: partial.recovery,
    runRoots: checkpoint.runRoots,
  });
  const manifest = JSON.parse(readFileSync(recoveryPath, "utf8")) as unknown;
  if (!isRecord(manifest) || !isRecord(manifest.reviews)) {
    throw new Error("Partial recovery manifest is missing immutable reviewer outputs.");
  }
  const manifestApprovedCandidate = readCandidateTuple(manifest.approvedCandidate);
  const manifestPartialCandidate = readCandidateTuple(manifest.partialCandidate);
  if (!sameCandidateTuple(manifestApprovedCandidate, checkpoint.approvedCandidate)) {
    throw new Error("Partial recovery approved candidate does not match canonical state.");
  }
  if (!sameCandidateTuple(manifestPartialCandidate, partial.tuple)) {
    throw new Error("Partial recovery tuple does not match its immutable recovery manifest.");
  }
  const reviews = manifest.reviews;
  const normalized = normalizeFactoryImplementationReviewFindings({
    implementation: reviews.implementation,
    quality: reviews.quality,
    simplify: reviews.simplify,
  });
  if (!Array.isArray(manifest.findings)) {
    throw new Error("Partial recovery manifest is missing its immutable finding index.");
  }
  const indexedIds = manifest.findings.map((finding) =>
    isRecord(finding) && typeof finding.id === "string" ? finding.id : undefined,
  );
  if (
    indexedIds.length !== normalized.findings.length ||
    indexedIds.some((id, index) => id !== normalized.findings[index]?.id)
  ) {
    throw new Error("Partial recovery finding index does not match reviewer outputs.");
  }
  return { reviewIndex: partial.reviewIndex, normalized };
}

async function runNestedReview(
  ctx: FactoryImplementationReviewRunContext,
  candidate: ReviewState["approvedCandidate"],
): Promise<
  | {
      status: "completed";
      runId: string;
      runDir: string;
      reviews: { implementation: unknown; quality: unknown; simplify: unknown };
    }
  | { status: "failed"; error: string; runId?: string; runDir?: string }
> {
  try {
    const nested = createWorkflowContext({
      workspace: ctx.workspace,
      runsDir: ctx.factoryStore.reviewRunsDir,
      baseRef: ctx.checkpoint.originalReviewBase,
      headRef: candidate.ref,
      ...(ctx.approvedPlanPath ? { planPath: ctx.approvedPlanPath } : {}),
      handoffText: readImplementationHandoff(ctx),
      agentProvider: "codex",
      model: ctx.reviewerRole.model,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      modelReasoningEffort: ctx.reviewerRole.modelReasoningEffort,
      maxRuntimeMs: ctx.maxRuntimeMs,
      ...(ctx.eventSink ? { eventSink: ctx.eventSink } : {}),
      signal: ctx.signal,
      agentProviderFactory: () => ctx.reviewerProvider(),
    });
    const result = await runChangeReview(nested);
    if (result.status === "failed") {
      return {
        status: "failed",
        error: "Nested change-review failed; inspect its durable artifacts.",
        runId: nested.runId,
        runDir: nested.runDir,
      };
    }
    return {
      status: "completed",
      runId: nested.runId,
      runDir: nested.runDir,
      reviews: {
        implementation: readNestedReview(nested.runDir, "implementation-review.json"),
        quality: readNestedReview(nested.runDir, "quality-review.json"),
        simplify: readNestedReview(nested.runDir, "simplify-review.json"),
      },
    };
  } catch (error) {
    return { status: "failed", error: errorMessage(error) };
  }
}

async function remediate(
  ctx: FactoryImplementationReviewRunContext,
  checkpoint: ReviewState,
  candidate: ReviewState["approvedCandidate"],
  findings: readonly FactoryImplementationReviewFinding[],
  reviewIndex: number,
): Promise<
  | {
      kind: "success";
      output: FactoryImplementationRemediationOutput;
      decisions: Map<string, FactoryImplementationRemediationOutput["findingDecisions"][number]>;
      before: FactoryWorkspacePatchCapture;
      after: FactoryWorkspacePatchCapture;
      lease: FactoryWorkspaceWriterLeaseHandle;
    }
  | {
      kind: "failed";
      error: string;
      before: FactoryWorkspacePatchCapture;
      after: FactoryWorkspacePatchCapture;
      lease?: FactoryWorkspaceWriterLeaseHandle;
      classification: ReviewFailureClassification;
      unresolvedReason?: "missing-session" | "incompatible-session";
    }
> {
  const session = checkpoint.implementerSession;
  if (!session || session.provider !== ctx.implementerRole.agent) {
    const before = captureWorkspaceChangesOrFallback(ctx.workspace, undefined);
    return {
      kind: "failed",
      error: session
        ? `Cannot resume ${ctx.implementerRole.agent} remediation from ${session.provider} session.`
        : "Factory implementation remediation is missing the implementer session.",
      before,
      after: before,
      classification: "workspace",
      unresolvedReason: session ? "incompatible-session" : "missing-session",
    };
  }
  const prompt = renderFactoryImplementationRemediationPrompt({
    workItem: ctx.workItem,
    originalReviewBase: checkpoint.originalReviewBase,
    approvedCandidate: candidate,
    findings,
    implementerAgent: { name: ctx.implementerRole.agent, model: ctx.implementerRole.model },
  });
  const logPath = ctx.writeText(`iterations/${reviewIndex}/remediation.stream.jsonl`, "");
  ctx.writePrompt(prompt, `iterations/${reviewIndex}/remediation.prompt.md`);
  let lease: FactoryWorkspaceWriterLeaseHandle;
  try {
    lease = acquireFactoryWorkspaceWriterLease({
      workspace: ctx.workspace,
      factoryProjectId: ctx.factoryStore.projectId,
      storeRoot: ctx.factoryStore.storeRoot,
      workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
      runId: ctx.implementationRunId,
      attemptId: ctx.runId,
      operation: "remediation",
    });
  } catch (error) {
    const before = captureFactoryWorkspaceChanges({ workspace: ctx.workspace });
    return {
      kind: "failed",
      error: errorMessage(error),
      before,
      after: before,
      classification: "workspace",
    };
  }
  let boundaryBefore: ReturnType<typeof captureFactoryWriterBoundary> | undefined;
  let before: FactoryWorkspacePatchCapture | undefined;
  try {
    validateFactoryCandidateTuple({
      workspace: ctx.workspace,
      candidate: checkpoint.partialRecovery?.tuple ?? candidate,
      expectedOriginalBase: checkpoint.originalReviewBase,
      expectedWorkspaceTree: true,
      ...(checkpoint.partialRecovery
        ? {
            expectedParentCommit: candidate.commit,
            expectedImplementationRunId: ctx.implementationRunId,
            expectedPartialAttemptId: checkpoint.partialRecovery.attemptId,
            expectedPartialReviewIndex: checkpoint.partialRecovery.reviewIndex,
          }
        : {}),
    });
    // Git status may refresh the index stat cache; establish the boundary after
    // capturing the pre-run workspace so Harness probes do not trip their own guard.
    before = captureFactoryWorkspaceChanges({ workspace: ctx.workspace });
    boundaryBefore = captureFactoryWriterBoundary({
      workspace: ctx.workspace,
      lifecycleRoot: ctx.factoryStore.factoryStateRoot,
      factoryStoreRoot: ctx.factoryStore.storeRoot,
      durablePaths: [ctx.factoryStore.factoryRunsDir, ctx.factoryStore.reviewRunsDir],
      allowedPaths: [logPath],
    });
    let result: AgentRunResult | undefined;
    let providerError: unknown;
    try {
      result = await ctx.implementerProvider().run({
        workspace: ctx.workspace,
        prompt,
        schemaPath: REMEDIATION_SCHEMA_PATH,
        model: ctx.implementerRole.model,
        sandboxMode: ctx.implementerRole.sandboxMode,
        approvalPolicy: ctx.implementerRole.approvalPolicy,
        modelReasoningEffort: ctx.implementerRole.modelReasoningEffort,
        session,
        workspaceGuard: "record",
        maxRuntimeMs: ctx.maxRuntimeMs,
        logPath,
        signal: ctx.signal,
      });
    } catch (error) {
      providerError = error;
    }
    const after = captureFactoryWorkspaceChanges({ workspace: ctx.workspace });
    const boundaryAfter = captureFactoryWriterBoundary({
      workspace: ctx.workspace,
      lifecycleRoot: ctx.factoryStore.factoryStateRoot,
      factoryStoreRoot: ctx.factoryStore.storeRoot,
      durablePaths: [ctx.factoryStore.factoryRunsDir, ctx.factoryStore.reviewRunsDir],
      allowedPaths: [logPath],
    });
    try {
      assertFactoryWriterBoundary(boundaryBefore, boundaryAfter);
    } catch (error) {
      return {
        kind: "failed",
        error: providerError
          ? `Provider failed and violated the writer boundary: ${errorMessage(error)}`
          : errorMessage(error),
        before,
        after,
        lease,
        classification: "workspace",
      };
    }
    if (providerError) {
      const providerErrorText = errorMessage(providerError);
      return {
        kind: "failed",
        error: providerErrorText,
        before,
        after,
        lease,
        classification: "provider",
        ...(isSessionCompatibilityError(providerErrorText)
          ? { unresolvedReason: "incompatible-session" as const }
          : {}),
      };
    }
    if (!result) {
      return {
        kind: "failed",
        error: "Factory provider returned no result.",
        before,
        after,
        lease,
        classification: "provider",
      };
    }
    ctx.writeArtifact(`iterations/${reviewIndex}/workspace-status.json`, { before, after });
    ctx.writeText(`iterations/${reviewIndex}/diff.patch`, after.patch);
    ctx.writeArtifact(
      `iterations/${reviewIndex}/remediation.raw.json`,
      result.ok ? result.raw : result,
    );
    if (!result.ok) {
      return {
        kind: "failed",
        error: result.aborted ? "Agent was aborted." : result.error,
        before,
        after,
        lease,
        classification: "provider",
        ...(isSessionCompatibilityError(result.error)
          ? { unresolvedReason: "incompatible-session" as const }
          : {}),
      };
    }
    try {
      validateFactoryCandidateTuple({
        workspace: ctx.workspace,
        candidate: checkpoint.partialRecovery?.tuple ?? candidate,
        expectedOriginalBase: checkpoint.originalReviewBase,
        expectedWorkspaceTree: false,
        ...(checkpoint.partialRecovery
          ? {
              expectedParentCommit: candidate.commit,
              expectedImplementationRunId: ctx.implementationRunId,
              expectedPartialAttemptId: checkpoint.partialRecovery.attemptId,
              expectedPartialReviewIndex: checkpoint.partialRecovery.reviewIndex,
            }
          : {}),
      });
      const output = parseFactoryImplementationRemediationOutput(result.structuredOutput);
      ctx.writeArtifact(`iterations/${reviewIndex}/remediation.json`, output);
      const decisions = new Map(
        output.findingDecisions.map((decision) => [decision.findingId, decision]),
      );
      if (decisions.size !== output.findingDecisions.length)
        throw new Error("Duplicate remediation finding decision IDs.");
      const expected = new Set(findings.map((finding) => finding.id));
      if (
        decisions.size !== expected.size ||
        [...decisions.keys()].some((id) => !expected.has(id))
      ) {
        throw new Error("Remediation decisions must contain exactly the current finding IDs.");
      }
      return { kind: "success", output, decisions, before, after, lease };
    } catch (error) {
      return {
        kind: "failed",
        error: errorMessage(error),
        before,
        after,
        lease,
        classification: "protocol",
      };
    }
  } catch (error) {
    const after = captureWorkspaceChangesOrFallback(ctx.workspace, before);
    const errorText = errorMessage(error);
    return {
      kind: "failed",
      error: errorText,
      before: before ?? emptyWorkspaceCapture(),
      after,
      lease,
      classification: classifyRemediationError(error),
      ...(isSessionCompatibilityError(errorText)
        ? { unresolvedReason: "incompatible-session" as const }
        : {}),
    };
  }
}

type PartialCaptureResult = {
  recovery?: NonNullable<ReviewState["partialRecovery"]>;
  failure?: string;
  failurePointer?: ReturnType<typeof pointer>;
};

function capturePartial(
  ctx: FactoryImplementationReviewRunContext,
  candidate: ReviewState["approvedCandidate"],
  reviewIndex: number,
  before: FactoryWorkspacePatchCapture,
  after: FactoryWorkspacePatchCapture,
  reason: string,
  findings: readonly FactoryImplementationReviewFinding[],
  reviews: NormalizedFactoryImplementationReview["roles"],
): PartialCaptureResult {
  let partial: ReturnType<typeof createFactoryPartialEvidenceCandidate> | undefined;
  try {
    partial = createFactoryPartialEvidenceCandidate({
      workspace: ctx.workspace,
      runDir: ctx.runDir,
      implementationRunId: ctx.implementationRunId,
      attemptId: ctx.runId,
      reviewIndex,
      parentCandidate: candidate,
      originalReviewBase: ctx.checkpoint.originalReviewBase,
    });
    ctx.writeArtifact(`iterations/${reviewIndex}/partial-candidate-ref.json`, partial);
    ctx.writeArtifact(`iterations/${reviewIndex}/workspace-status.json`, { before, after, reason });
    ctx.writeText(`iterations/${reviewIndex}/diff.patch`, after.patch);
    ctx.writeArtifact(`iterations/${reviewIndex}/recovery.json`, {
      reason,
      approvedCandidate: candidate,
      partialCandidate: partial,
      findings,
      reviews,
    });
    return {
      recovery: {
        tuple: { ref: partial.ref, commit: partial.commit, tree: partial.tree },
        attemptId: ctx.runId,
        reviewIndex,
        status: pointer(ctx.runId, `iterations/${reviewIndex}/workspace-status.json`),
        patch: pointer(ctx.runId, `iterations/${reviewIndex}/diff.patch`),
        recovery: pointer(ctx.runId, `iterations/${reviewIndex}/recovery.json`),
      },
    };
  } catch (error) {
    const failure = errorMessage(error);
    let failurePointer: ReturnType<typeof pointer> | undefined;
    try {
      ctx.writeArtifact(`iterations/${reviewIndex}/partial-capture-failure.json`, {
        error: failure,
        reason,
        ...(partial ? { partialCandidate: candidateTuple(partial) } : {}),
        findings,
        reviews,
      });
      failurePointer = pointer(ctx.runId, `iterations/${reviewIndex}/partial-capture-failure.json`);
    } catch {
      // Preserve the original capture error when the store itself is unavailable.
    }
    return { failure, ...(failurePointer ? { failurePointer } : {}) };
  }
}

function failedAfterRemediation(
  ctx: FactoryImplementationReviewRunContext,
  checkpoint: ReviewState,
  candidate: ReviewState["approvedCandidate"],
  completedReviewCount: number,
  candidateVersion: number,
  reviewIndex: number,
  result: {
    kind: "failed";
    error: string;
    before: FactoryWorkspacePatchCapture;
    after: FactoryWorkspacePatchCapture;
    lease?: FactoryWorkspaceWriterLeaseHandle;
    classification: ReviewFailureClassification;
    unresolvedReason?: "missing-session" | "incompatible-session";
  },
  findings: readonly FactoryImplementationReviewFinding[],
  reviews: NormalizedFactoryImplementationReview["roles"],
): FactoryImplementationReviewRunMeta {
  const partial = workspaceCaptureChanged(result.before, result.after)
    ? capturePartial(
        ctx,
        candidate,
        reviewIndex,
        result.before,
        result.after,
        result.error,
        findings,
        reviews,
      )
    : {};
  const captureError = partial.failure ? `; partial capture failed: ${partial.failure}` : "";
  ctx.writeSummary(
    `# Factory Implementation Review\n\n- Status: review-failed\n- Classification: ${result.classification}\n- Error: ${result.error}\n`,
  );
  appendImplementationReviewFailedEvent({
    factoryStateRoot: ctx.factoryStore.factoryStateRoot,
    workItem: ctx.workItem,
    runId: ctx.runId,
    owningImplementationRunId: ctx.implementationRunId,
    activeReviewAttemptId: ctx.runId,
    latestCheckpointId: checkpoint.latestCheckpointId,
    classification: result.classification,
    retryable: result.classification !== "protocol",
    error: `${result.error}${captureError}`,
    summary: pointer(ctx.runId, "summary.md"),
    ...(partial.recovery ? { partialRecovery: partial.recovery } : {}),
    ...(partial.failurePointer ? { recovery: partial.failurePointer } : {}),
    execution: reviewExecution(ctx),
  });
  return ctx.export({
    status: "review-failed",
    completedReviewCount,
    candidateVersion,
    approvedCandidate: candidate,
    error: `${result.error}${captureError}`,
  });
}

function workspaceCaptureChanged(
  before: FactoryWorkspacePatchCapture,
  after: FactoryWorkspacePatchCapture,
): boolean {
  return before.porcelain !== after.porcelain || before.patchSha256 !== after.patchSha256;
}

function captureWorkspaceChangesOrFallback(
  workspace: string,
  fallback: FactoryWorkspacePatchCapture | undefined,
): FactoryWorkspacePatchCapture {
  try {
    return captureFactoryWorkspaceChanges({ workspace });
  } catch {
    return fallback ?? emptyWorkspaceCapture();
  }
}

function emptyWorkspaceCapture(): FactoryWorkspacePatchCapture {
  return {
    porcelain: "",
    patch: "",
    patchSha256: "",
    changedFiles: [],
    patchTruncated: false,
  };
}

function candidateTuple(candidate: {
  ref: string;
  commit: string;
  tree: string;
}): ReviewState["approvedCandidate"] {
  return { ref: candidate.ref, commit: candidate.commit, tree: candidate.tree };
}

function readCandidateTuple(value: unknown): ReviewState["approvedCandidate"] {
  if (!isRecord(value)) throw new Error("Partial recovery manifest candidate is invalid.");
  return CandidateTupleSchema.parse({
    ref: value.ref,
    commit: value.commit,
    tree: value.tree,
  });
}

function sameCandidateTuple(
  left: ReviewState["approvedCandidate"],
  right: ReviewState["approvedCandidate"],
): boolean {
  return left.ref === right.ref && left.commit === right.commit && left.tree === right.tree;
}

function failedArtifact(
  ctx: FactoryImplementationReviewRunContext,
  checkpoint: ReviewState,
  completedReviewCount: number,
  candidateVersion: number,
  error: string,
): FactoryImplementationReviewRunMeta {
  ctx.writeSummary(
    `# Factory Implementation Review\n\n- Status: review-failed\n- Classification: artifact\n- Error: ${error}\n`,
  );
  appendImplementationReviewFailedEvent({
    factoryStateRoot: ctx.factoryStore.factoryStateRoot,
    workItem: ctx.workItem,
    runId: ctx.runId,
    owningImplementationRunId: ctx.implementationRunId,
    activeReviewAttemptId: ctx.runId,
    latestCheckpointId: checkpoint.latestCheckpointId,
    classification: "artifact",
    retryable: false,
    error,
    summary: pointer(ctx.runId, "summary.md"),
    execution: reviewExecution(ctx),
  });
  return ctx.export({
    status: "review-failed",
    completedReviewCount,
    candidateVersion,
    approvedCandidate: checkpoint.approvedCandidate,
    error,
  });
}

function failedProtocol(
  ctx: FactoryImplementationReviewRunContext,
  checkpoint: ReviewState,
  _candidate: ReviewState["approvedCandidate"],
  completedReviewCount: number,
  candidateVersion: number,
  error: string,
): FactoryImplementationReviewRunMeta {
  ctx.writeSummary(
    `# Factory Implementation Review\n\n- Status: review-failed\n- Classification: protocol\n- Error: ${error}\n`,
  );
  appendImplementationReviewFailedEvent({
    factoryStateRoot: ctx.factoryStore.factoryStateRoot,
    workItem: ctx.workItem,
    runId: ctx.runId,
    owningImplementationRunId: ctx.implementationRunId,
    activeReviewAttemptId: ctx.runId,
    latestCheckpointId: checkpoint.latestCheckpointId,
    classification: "protocol",
    retryable: false,
    error,
    summary: pointer(ctx.runId, "summary.md"),
    execution: reviewExecution(ctx),
  });
  return ctx.export({
    status: "review-failed",
    completedReviewCount,
    candidateVersion,
    approvedCandidate: _candidate,
    error,
  });
}

function unresolved(
  ctx: FactoryImplementationReviewRunContext,
  checkpoint: ReviewState,
  candidate: ReviewState["approvedCandidate"],
  completedReviewCount: number,
  candidateVersion: number,
  reason:
    | "blocked"
    | "missing-session"
    | "incompatible-session"
    | "legacy-incomplete"
    | "declined-must-fix"
    | "max-iterations"
    | "stale-owner",
): FactoryImplementationReviewRunMeta {
  ctx.writeSummary(
    `# Factory Implementation Review\n\n- Status: ready-for-human\n- Reason: ${reason}\n`,
  );
  appendImplementationReviewUnresolvedEvent({
    factoryStateRoot: ctx.factoryStore.factoryStateRoot,
    workItem: ctx.workItem,
    runId: ctx.runId,
    owningImplementationRunId: ctx.implementationRunId,
    activeReviewAttemptId: ctx.runId,
    latestCheckpointId: checkpoint.latestCheckpointId,
    reason,
    summary: pointer(ctx.runId, "summary.md"),
    execution: reviewExecution(ctx),
  });
  return ctx.export({
    status: "ready-for-human",
    completedReviewCount,
    candidateVersion,
    approvedCandidate: candidate,
  });
}

function complete(
  ctx: FactoryImplementationReviewRunContext,
  checkpoint: ReviewState,
  candidate: ReviewState["approvedCandidate"],
  completedReviewCount: number,
  candidateVersion: number,
  attempts: ReadonlyArray<{
    attemptId: string;
    reviewIndex: number;
    nestedReviewRefs: readonly string[];
    decisions: ReadonlyArray<{ findingId: string; decision: string; rationale: string }>;
  }>,
  acceptedDebt: ReadonlyArray<AcceptedDebt>,
): FactoryImplementationReviewRunMeta {
  ctx.writeArtifact("accepted-debt.json", acceptedDebt);
  const handoff = renderFactoryImplementationPrReadyHandoff({
    workItem: ctx.workItem,
    implementationRunId: ctx.implementationRunId,
    attempts,
    originalReviewBase: checkpoint.originalReviewBase,
    finalCandidate: candidate,
    cumulativeDiff: gitDiff(ctx.workspace, checkpoint.originalReviewBase, candidate.commit),
    implementerSession: checkpoint.implementerSession,
    workspace: checkpoint.workspace,
    acceptedDebt,
  });
  const handoffPath = ctx.writeHandoff(handoff);
  ctx.writeSummary(
    `# Factory Implementation Review\n\n- Status: review-complete\n- Candidate: ${candidate.ref}\n`,
  );
  appendImplementationReviewCompletedEvent({
    factoryStateRoot: ctx.factoryStore.factoryStateRoot,
    workItem: ctx.workItem,
    runId: ctx.runId,
    owningImplementationRunId: ctx.implementationRunId,
    activeReviewAttemptId: ctx.runId,
    latestCheckpointId: checkpoint.latestCheckpointId,
    finalCandidate: candidate,
    handoff: pointer(ctx.runId, "implementation-review/pr-ready-handoff.md"),
    acceptedDebt: pointer(ctx.runId, "accepted-debt.json"),
    acceptedDebtCount: acceptedDebt.length,
    execution: reviewExecution(ctx),
  });
  return ctx.export({
    status: "review-complete",
    completedReviewCount,
    candidateVersion,
    approvedCandidate: candidate,
    handoffPath,
  });
}

function pointer(runId: string, path: string, root: "factory" | "review" = "review") {
  return { runId, root, path } as const;
}

function failUnexpectedReview(
  ctx: FactoryImplementationReviewRunContext,
  error: unknown,
): FactoryImplementationReviewRunMeta {
  const state = loadFactoryLifecycleState({
    factoryStateRoot: ctx.factoryStore.factoryStateRoot,
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    workspace: ctx.workspace,
  });
  const checkpoint = state?.implementationReviewCheckpoint;
  if (
    state?.factoryStage !== "review-running" ||
    !checkpoint ||
    checkpoint.activeReviewAttemptId !== ctx.runId
  ) {
    throw error;
  }

  const errorText = errorMessage(error);
  const classification = classifyUnexpectedReviewError(error);
  const partial = captureUnexpectedPartialRecovery(ctx, checkpoint, errorText);
  const recoveryError = partial.failure ? `; partial capture failed: ${partial.failure}` : "";
  ctx.writeSummary(
    `# Factory Implementation Review\n\n- Status: review-failed\n- Classification: ${classification}\n- Error: ${errorText}${recoveryError}\n`,
  );
  appendImplementationReviewFailedEvent({
    factoryStateRoot: ctx.factoryStore.factoryStateRoot,
    workItem: ctx.workItem,
    runId: ctx.runId,
    owningImplementationRunId: ctx.implementationRunId,
    activeReviewAttemptId: ctx.runId,
    latestCheckpointId: checkpoint.latestCheckpointId,
    classification,
    retryable: classification !== "protocol",
    error: `${errorText}${recoveryError}`,
    summary: pointer(ctx.runId, "summary.md"),
    ...(partial.recovery ? { partialRecovery: partial.recovery } : {}),
    ...(partial.failurePointer ? { recovery: partial.failurePointer } : {}),
    execution: reviewExecution(ctx),
  });
  return ctx.export({
    status: "review-failed",
    completedReviewCount: checkpoint.completedReviewCount,
    candidateVersion: checkpoint.candidateVersion,
    approvedCandidate: checkpoint.approvedCandidate,
    error: `${errorText}${recoveryError}`,
  });
}

function captureUnexpectedPartialRecovery(
  ctx: FactoryImplementationReviewRunContext,
  checkpoint: ReviewState,
  reason: string,
): PartialCaptureResult {
  let lease: FactoryWorkspaceWriterLeaseHandle | undefined;
  try {
    lease = acquireFactoryWorkspaceWriterLease({
      workspace: ctx.workspace,
      factoryProjectId: ctx.factoryStore.projectId,
      storeRoot: ctx.factoryStore.storeRoot,
      workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
      runId: ctx.implementationRunId,
      attemptId: ctx.runId,
      operation: "remediation",
    });
    const after = captureFactoryWorkspaceChanges({ workspace: ctx.workspace });
    if (!after.porcelain && !after.patch && after.changedFiles.length === 0) return {};
    const review = checkpoint.latestReview
      ? resolveFactoryArtifactPointer({
          pointer: checkpoint.latestReview,
          runRoots: checkpoint.runRoots,
        })
      : undefined;
    const reviewDir = review ? dirname(review) : undefined;
    const normalized = reviewDir
      ? normalizeFactoryImplementationReviewFindings({
          implementation: readNestedReview(reviewDir, "implementation-review.json"),
          quality: readNestedReview(reviewDir, "quality-review.json"),
          simplify: readNestedReview(reviewDir, "simplify-review.json"),
        })
      : undefined;
    return capturePartial(
      ctx,
      checkpoint.approvedCandidate,
      checkpoint.activeReviewIndex ?? checkpoint.completedReviewCount + 1,
      emptyWorkspaceCapture(),
      after,
      reason,
      normalized?.findings ?? [],
      normalized?.roles ?? emptyReviewRoles(),
    );
  } catch (error) {
    return { failure: errorMessage(error) };
  } finally {
    if (lease) releaseFactoryWorkspaceWriterLease({ handle: lease });
  }
}

function emptyReviewRoles(): NormalizedFactoryImplementationReview["roles"] {
  return {
    implementation: { verdict: "blocked", summary: "Unavailable", findings: [] },
    quality: { verdict: "blocked", summary: "Unavailable", findings: [] },
    simplify: { verdict: "blocked", summary: "Unavailable", findings: [] },
  };
}

function classifyUnexpectedReviewError(error: unknown): ReviewFailureClassification {
  if (error instanceof FactoryWriterBoundaryError) return "workspace";
  if (error instanceof FactoryWorkspaceChangesError || error instanceof FactoryReviewHeadError) {
    return "git";
  }
  return "artifact";
}

function reviewExecution(ctx: FactoryImplementationReviewRunContext) {
  return factoryLifecycleExecutionProvenance(
    factoryExecutionProvenance(ctx.workspace, ctx.runDir),
    ctx.factoryStore,
  );
}

function readNestedReview(runDir: string, name: string): unknown {
  const path = join(runDir, name);
  const stat = existsSync(path) ? lstatSync(path) : undefined;
  if (!stat || !stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Nested review did not write a regular ${name}`);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionCompatibilityError(error: string): boolean {
  return /cannot resume .* session|session (?:mismatch|incompatible)|blank session id/i.test(error);
}

function classifyRemediationError(error: unknown): ReviewFailureClassification {
  if (error instanceof FactoryWriterBoundaryError) return "workspace";
  if (error instanceof FactoryWorkspaceChangesError || error instanceof FactoryReviewHeadError) {
    return "git";
  }
  return "provider";
}

function readImplementationHandoff(ctx: FactoryImplementationReviewRunContext): string | undefined {
  const path = resolveFactoryArtifactPointer({
    pointer: pointer(ctx.implementationRunId, "implementation/change-review-handoff.md", "factory"),
    runRoots: ctx.checkpoint.runRoots,
  });
  return readFileSync(path, "utf8");
}

function gitDiff(workspace: string, base: string, head: string): string {
  return execFileSync("git", ["diff", "--binary", `${base}..${head}`], {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
