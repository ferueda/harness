import type { Context, FailureEventArgs, Inngest, InngestFunction } from "inngest";
import { z } from "zod";
import { AGENT_REASONING_EFFORTS, type Agent } from "../agent/contract.ts";
import { errorMessage } from "../agent/invocation.ts";
import type { GitHubPublicationService, GitHubRepositoryIdentity } from "../github/types.ts";
import type { LinearService } from "../linear/client.ts";
import type {
  RepositoryCheckpoint,
  RepositoryRun,
  RepositoryService,
} from "../repository/types.ts";
import { reviewSpec, type SpecReviewResult } from "../spec-review/review.ts";
import type { SpecReviewArtifact } from "../spec-review/schema.ts";
import {
  renderSpecOutcomeComment,
  renderSpecRevisionNeedsInputComment,
  SpecPresentationError,
  validateSpecRevisionWorkspaceChanges,
  validateSpecWorkspaceChanges,
} from "../spec/presentation.ts";
import { reviseSpec, type SpecRevisionResult } from "../spec/revise.ts";
import { SpecIssueReferenceSchema, type SpecDecision } from "../spec/schema.ts";
import { specIssue, type SpecExecution, type SpecIssueResult } from "../spec/spec.ts";
import {
  createInitialSpecCheckpointIdentity,
  createSpecCycleRoundIdentity,
  SPEC_CYCLE_MAX_REVISIONS,
  SPEC_CYCLE_REVIEW_ROUNDS,
  toSpecRevisionAuthorSession,
  toSpecRevisionReview,
} from "./spec-cycle.ts";
import { cleanupRepositoryRun, SpecCleanupDiagnosticError } from "./spec-cleanup.ts";
import {
  SpecWorkRequestedEvent,
  WORK_REQUEST_EVENT_ID_PREFIX,
  WorkRequestDataSchema,
  workRequestEventId,
  type WorkRequestData,
} from "./events/work-events.ts";
import { LinearReadinessConfigSchema, type LinearReadinessConfig } from "./readiness.ts";
import {
  confirmClaimedSpec,
  loadClaimedWorkItem,
  loadEligibleSpec,
  type SpecAuthority,
} from "./spec-authority.ts";
import {
  beginSpecRecovery,
  claimSpecState,
  consumeSpecAgentReady,
  ensureSpecFailureComment,
  finishSpecRecovery,
  projectSpecOutcome,
  reopenSpecClaim,
  specCommentMarker,
  specCycleCommentMarker,
} from "./spec-projection.ts";
import { publishReviewedSpecCheckpoint } from "./spec-publication.ts";

export { ensureSpecFailureComment, specCommentMarker } from "./spec-projection.ts";

export const LINEAR_SPEC_FUNCTION_ID = "spec-linear-issue-v1";
export const LINEAR_SPEC_RETRIES = 3;
export const LINEAR_SPEC_LOAD_STEP_ID = "load-linear-spec-v2";
export const LINEAR_SPEC_CLAIM_STATE_STEP_ID = "claim-linear-spec-state-v1";
export const LINEAR_SPEC_CONSUME_AGENT_READY_STEP_ID = "consume-linear-spec-agent-ready-v1";
export const LINEAR_SPEC_BASE_STEP_ID = "resolve-linear-spec-base-v1";
export const LINEAR_SPEC_PREPARE_STEP_ID = "prepare-linear-spec-run-v1";
export const LINEAR_SPEC_AGENT_STEP_ID = "run-linear-spec-author-v2";
export const LINEAR_SPEC_CONFIRM_STEP_ID = "confirm-linear-spec-authority-v2";
export const LINEAR_SPEC_INSPECT_STEP_ID = "inspect-linear-spec-changes-v2";
export const LINEAR_SPEC_FAILURE_COMMENT_STEP_ID = "project-linear-spec-failure-v2";
export const LINEAR_SPEC_RECOVERY_STATE_STEP_ID = "reopen-linear-spec-claim-v1";
export const LINEAR_SPEC_RECOVERY_LABEL_STEP_ID = "finish-linear-spec-recovery-v1";
export const LINEAR_SPEC_PROJECT_STEP_ID = "project-linear-spec-outcome-v2";
export const LINEAR_SPEC_CLEANUP_STEP_ID = "cleanup-linear-spec-run-v2";
export const LINEAR_SPEC_CLEANUP_FAILURE_COMMENT_STEP_ID = "project-linear-spec-cleanup-failure-v1";

export type LinearSpecService = Pick<
  LinearService,
  "getIssueContext" | "ensureComment" | "updateIssueLabels" | "updateIssueState"
>;

export type LinearSpecFunctionConfig = Readonly<{
  readiness: LinearReadinessConfig;
  baseRef: string;
  execution: SpecExecution;
  githubRepository: GitHubRepositoryIdentity;
}>;

type StepTools = Context<Inngest.Any>["step"];

const SpecExecutionSchema = z
  .object({
    model: z.string().trim().min(1),
    modelReasoningEffort: z.enum(AGENT_REASONING_EFFORTS),
    maxRuntimeMs: z.number().int().positive(),
    logPath: z.string().trim().min(1).optional(),
    signal: z
      .custom<AbortSignal>((value) => value instanceof AbortSignal, {
        message: "signal must be an AbortSignal",
      })
      .optional(),
  })
  .strict();

const LinearSpecFunctionConfigSchema = z
  .object({
    readiness: LinearReadinessConfigSchema,
    baseRef: z.string().trim().min(1),
    execution: SpecExecutionSchema,
    githubRepository: z
      .object({
        owner: z.string().trim().min(1),
        repository: z.string().trim().min(1),
        httpsRemote: z.string().trim().url(),
      })
      .strict(),
  })
  .strict();

export function createLinearSpecFunction(input: {
  client: Inngest.Any;
  linear: LinearSpecService;
  authorAgent: Agent;
  reviewAgent: Agent;
  repository: RepositoryService;
  github: GitHubPublicationService;
  config: LinearSpecFunctionConfig;
}): InngestFunction.Any {
  const config = LinearSpecFunctionConfigSchema.parse(input.config);
  const onFailure = async ({ event, error, step }: Context<Inngest.Any, FailureEventArgs>) => {
    const original = WorkRequestDataSchema.safeParse(event.data.event.data);
    if (!original.success) return;
    await step.run(LINEAR_SPEC_FAILURE_COMMENT_STEP_ID, () =>
      ensureSpecFailureComment({
        linear: input.linear,
        event: original.data,
        error: errorMessage(error),
        bestEffort: true,
      }),
    );
  };

  return input.client.createFunction(
    {
      id: LINEAR_SPEC_FUNCTION_ID,
      concurrency: { key: "event.data.issueId", limit: 1 },
      retries: LINEAR_SPEC_RETRIES,
      triggers: [SpecWorkRequestedEvent],
      onFailure,
    },
    async ({ event, step }) => {
      const loaded = await step.run(LINEAR_SPEC_LOAD_STEP_ID, () =>
        loadEligibleSpec(input.linear, event.data, config.readiness),
      );
      if (loaded.kind === "ineligible") {
        return { outcome: "ignored" as const, reason: loaded.reason };
      }

      let run: RepositoryRun | undefined;
      let claimStateSucceeded = false;
      let agentReadyConsumed = false;
      try {
        await step.run(LINEAR_SPEC_CLAIM_STATE_STEP_ID, () =>
          claimSpecState(input.linear, event.data.issueId, config.readiness),
        );
        claimStateSucceeded = true;
        await step.run(LINEAR_SPEC_CONSUME_AGENT_READY_STEP_ID, () =>
          consumeSpecAgentReady(input.linear, event.data.issueId, config.readiness),
        );
        agentReadyConsumed = true;

        const identity = specWorkIdentity(event.data);
        const base = await step.run(LINEAR_SPEC_BASE_STEP_ID, () =>
          input.repository.resolveBase({ baseRef: config.baseRef }),
        );
        const preparedRun = await step.run(LINEAR_SPEC_PREPARE_STEP_ID, () =>
          input.repository.prepareRun({
            id: identity.workId,
            base,
            branch: identity.branch,
          }),
        );
        run = preparedRun;

        return await executeSpecCycle({
          step,
          event: event.data,
          authority: loaded.authority,
          run: preparedRun,
          workId: identity.workId,
          linear: input.linear,
          authorAgent: input.authorAgent,
          reviewAgent: input.reviewAgent,
          repository: input.repository,
          github: input.github,
          config,
        });
      } catch (error) {
        // A cleanup diagnostic has already exhausted its own durable retries.
        // Rethrow it so onFailure runs instead of starting a second cleanup.
        if (error instanceof SpecCleanupDiagnosticError) throw error;
        return recoverSpecFailure({
          step,
          event: event.data,
          authority: loaded.authority,
          run,
          linear: input.linear,
          repository: input.repository,
          readiness: config.readiness,
          reason: errorMessage(error),
          failureKind: "operational-failure",
          allowAgentReadyClaim: claimStateSucceeded && !agentReadyConsumed,
        });
      }
    },
  );
}

async function executeSpecCycle(input: {
  step: StepTools;
  event: WorkRequestData;
  authority: SpecAuthority;
  run: RepositoryRun;
  workId: string;
  linear: LinearSpecService;
  authorAgent: Agent;
  reviewAgent: Agent;
  repository: RepositoryService;
  github: GitHubPublicationService;
  config: LinearSpecFunctionConfig;
}) {
  let run = input.run;
  const authored = await input.step.run(LINEAR_SPEC_AGENT_STEP_ID, async () => {
    const claimed = await loadClaimedWorkItem(
      input.linear,
      input.authority,
      input.config.readiness,
    );
    if (claimed.kind === "stale") return claimed;
    const existingChanges = await input.repository.inspectChanges(run);
    if (existingChanges.length > 0) {
      return {
        kind: "failed" as const,
        error: "Spec author retry found workspace changes from an earlier failed attempt.",
        failureKind: "invalid-workspace",
      };
    }
    const result = await specIssue({
      workItem: claimed.workItem,
      agent: input.authorAgent,
      workspace: run.workspace,
      execution: input.config.execution,
    });
    if (!result.ok && isRetryableSpecFailure(result)) throw new Error(result.error);
    if (!result.ok) {
      return {
        kind: "failed" as const,
        error: result.error,
        failureKind: result.failureKind,
      };
    }
    return { kind: "succeeded" as const, result };
  });
  if (authored.kind === "stale") {
    return recoverStaleAuthority(input, run, authored.reason);
  }
  if (authored.kind === "failed") {
    return recoverSpecFailure({
      ...recoveryInput(input, run),
      reason: authored.error,
      failureKind: authored.failureKind,
    });
  }

  const confirmedAuthor = await input.step.run(LINEAR_SPEC_CONFIRM_STEP_ID, () =>
    confirmClaimedSpec(input.linear, input.authority, input.config.readiness),
  );
  if (confirmedAuthor.kind === "stale") {
    return recoverStaleAuthority(input, run, confirmedAuthor.reason);
  }

  if (authored.result.decision.outcome === "needs-input") {
    const initial = await input.step.run(LINEAR_SPEC_INSPECT_STEP_ID, async () => {
      try {
        const changes = validateSpecWorkspaceChanges({
          reference: input.event.issueIdentifier,
          decision: authored.result.decision,
          changes: await input.repository.inspectChanges(run),
        });
        const marker = specCommentMarker(input.event, "needs-input");
        return {
          ok: true as const,
          changes,
          marker,
          comment: renderSpecOutcomeComment({
            marker,
            decision: authored.result.decision,
            provenance: authored.result.provenance,
          }),
        };
      } catch (error) {
        return { ok: false as const, error: errorMessage(error) };
      }
    });
    if (!initial.ok) {
      return recoverSpecFailure({
        ...recoveryInput(input, run),
        reason: initial.error,
        failureKind: "invalid-workspace",
      });
    }
    await input.step.run(LINEAR_SPEC_PROJECT_STEP_ID, () =>
      projectSpecOutcome({
        linear: input.linear,
        issueId: input.event.issueId,
        marker: initial.marker,
        comment: initial.comment,
        specLabelId: input.config.readiness.agentActionLabelIds.spec,
        inProgressStateId: input.config.readiness.stateIds.inProgress,
        targetStateId: input.config.readiness.stateIds.needsInput,
      }),
    );
    const cleanup = await cleanupSpecRun(input, run, "needs-input");
    return {
      outcome: "needs-input" as const,
      issueId: input.event.issueId,
      cleanup,
    };
  }

  const initial = await input.step.run(LINEAR_SPEC_INSPECT_STEP_ID, async () => {
    try {
      return {
        ok: true as const,
        changes: validateSpecWorkspaceChanges({
          reference: input.event.issueIdentifier,
          decision: authored.result.decision,
          changes: await input.repository.inspectChanges(run),
        }),
      };
    } catch (error) {
      return { ok: false as const, error: errorMessage(error) };
    }
  });
  if (!initial.ok) {
    return recoverSpecFailure({
      ...recoveryInput(input, run),
      reason: initial.error,
      failureKind: "invalid-workspace",
    });
  }

  const checkpointIdentity = createInitialSpecCheckpointIdentity({
    workRequestId: input.workId,
    parentRevision: run.baseSha,
  });
  let checkpoint = await input.step.run(checkpointIdentity.stepId, () =>
    input.repository.checkpointRun({
      id: checkpointIdentity.checkpointId,
      run,
      expectedParentRevision: run.baseSha,
      expectedChanges: initial.changes,
      message: `docs: add ${input.event.issueIdentifier} spec`,
    }),
  );
  const artifactPath = authored.result.decision.artifactPath;
  let authorSession = toSpecRevisionAuthorSession(authored.result.provenance.session);
  let finalReview: Extract<SpecReviewResult, { ok: true }> | undefined;
  let finalReviewRound: (typeof SPEC_CYCLE_REVIEW_ROUNDS)[number] = 0;
  let approved = false;

  for (const reviewRound of SPEC_CYCLE_REVIEW_ROUNDS) {
    const round = createSpecCycleRoundIdentity({
      workRequestId: input.workId,
      reviewRound,
      checkpointRevision: checkpoint.revision,
    });
    run = await input.step.run(round.openBeforeReviewStepId, () =>
      input.repository.openCheckpoint({
        checkpoint,
        baseRef: input.config.baseRef,
      }),
    );

    const reviewed = await input.step.run(round.reviewStepId, async () => {
      const claimed = await loadClaimedWorkItem(
        input.linear,
        input.authority,
        input.config.readiness,
      );
      if (claimed.kind === "stale") return claimed;
      const result = await reviewSpec({
        workItem: claimed.workItem,
        artifact: reviewArtifact(artifactPath, checkpoint),
        workspace: run.workspace,
        agent: input.reviewAgent,
        execution: input.config.execution,
      });
      if (!result.ok && isRetryableReviewFailure(result)) throw new Error(result.error);
      if (!result.ok) {
        return {
          kind: "failed" as const,
          error: result.error,
          failureKind: result.failureKind,
        };
      }
      return { kind: "succeeded" as const, result };
    });

    run = await input.step.run(round.openAfterReviewStepId, () =>
      input.repository.openCheckpoint({
        checkpoint,
        baseRef: input.config.baseRef,
      }),
    );
    if (reviewed.kind === "stale") {
      return recoverStaleAuthority(input, run, reviewed.reason);
    }
    if (reviewed.kind === "failed") {
      return recoverSpecFailure({
        ...recoveryInput(input, run),
        reason: reviewed.error,
        failureKind: reviewed.failureKind,
      });
    }

    const confirmedReview = await input.step.run(round.authorityAfterReviewStepId, () =>
      confirmClaimedSpec(input.linear, input.authority, input.config.readiness),
    );
    if (confirmedReview.kind === "stale") {
      return recoverStaleAuthority(input, run, confirmedReview.reason);
    }

    finalReview = reviewed.result;
    finalReviewRound = reviewRound;
    const reviewDecision = reviewed.result.decision;
    if (reviewDecision.outcome === "approved") {
      approved = true;
      break;
    }
    if (reviewRound === SPEC_CYCLE_MAX_REVISIONS) break;
    const requestedArtifact = reviewed.result.artifact;
    const requestedProvenance = reviewed.result.provenance;

    const confirmedBeforeRevision = await input.step.run(round.authorityBeforeRevisionStepId, () =>
      confirmClaimedSpec(input.linear, input.authority, input.config.readiness),
    );
    if (confirmedBeforeRevision.kind === "stale") {
      return recoverStaleAuthority(input, run, confirmedBeforeRevision.reason);
    }
    const currentAuthorSession = authorSession;
    if (!currentAuthorSession) {
      return recoverSpecFailure({
        ...recoveryInput(input, run),
        reason: "Spec author did not return a resumable continuation session.",
        failureKind: "invalid-session",
      });
    }

    const revised = await input.step.run(round.revisionStepId, async () => {
      const claimed = await loadClaimedWorkItem(
        input.linear,
        input.authority,
        input.config.readiness,
      );
      if (claimed.kind === "stale") return claimed;
      // A prior failed attempt may have changed the local workspace even though
      // Inngest rolled back its step result. Re-verify the exact clean checkpoint
      // before every retry so partial output can never feed a later revision.
      const revisionRun = await input.repository.openCheckpoint({
        checkpoint,
        baseRef: input.config.baseRef,
      });
      const result = await reviseSpec({
        workItem: claimed.workItem,
        artifact: requestedArtifact,
        review: toSpecRevisionReview({
          artifact: requestedArtifact,
          decision: reviewDecision,
          provenance: requestedProvenance,
        }),
        authorSession: currentAuthorSession,
        workspace: revisionRun.workspace,
        agent: input.authorAgent,
        execution: input.config.execution,
      });
      if (!result.ok && isRetryableRevisionFailure(result)) throw new Error(result.error);
      if (!result.ok) {
        return {
          kind: "failed" as const,
          error: result.error,
          failureKind: result.failureKind,
        };
      }
      return { kind: "succeeded" as const, result };
    });
    if (revised.kind === "stale") {
      return recoverStaleAuthority(input, run, revised.reason);
    }
    if (revised.kind === "failed") {
      return recoverSpecFailure({
        ...recoveryInput(input, run),
        reason: revised.error,
        failureKind: revised.failureKind,
      });
    }

    const confirmedRevision = await input.step.run(round.authorityAfterRevisionStepId, () =>
      confirmClaimedSpec(input.linear, input.authority, input.config.readiness),
    );
    if (confirmedRevision.kind === "stale") {
      return recoverStaleAuthority(input, run, confirmedRevision.reason);
    }

    const inspected = await input.step.run(round.inspectRevisionStepId, async () => {
      try {
        return {
          ok: true as const,
          changes: validateSpecRevisionWorkspaceChanges({
            reference: input.event.issueIdentifier,
            outcome: revised.result.decision.outcome,
            changes: await input.repository.inspectChanges(run),
          }),
        };
      } catch (error) {
        return { ok: false as const, error: errorMessage(error) };
      }
    });
    if (!inspected.ok) {
      return recoverSpecFailure({
        ...recoveryInput(input, run),
        reason: inspected.error,
        failureKind: "invalid-workspace",
      });
    }

    authorSession = revised.result.authorSession;
    if (revised.result.decision.outcome === "needs-input") {
      const marker = specCycleCommentMarker(round.commentIdentity, "needs-input");
      let comment: string;
      try {
        comment = renderSpecRevisionNeedsInputComment({
          marker,
          decision: revised.result.decision,
          provenance: revised.result.provenance,
        });
      } catch (error) {
        if (!(error instanceof SpecPresentationError)) throw error;
        return recoverSpecFailure({
          ...recoveryInput(input, run),
          reason: error.message,
          failureKind: "invalid-presentation",
        });
      }
      await input.step.run(round.projectStepId, () =>
        projectSpecOutcome({
          linear: input.linear,
          issueId: input.event.issueId,
          marker,
          comment,
          specLabelId: input.config.readiness.agentActionLabelIds.spec,
          inProgressStateId: input.config.readiness.stateIds.inProgress,
          targetStateId: input.config.readiness.stateIds.needsInput,
        }),
      );
      const cleanup = await cleanupSpecRun(input, run, round.key);
      return {
        outcome: "needs-input" as const,
        issueId: input.event.issueId,
        cleanup,
      };
    }
    if (revised.result.decision.outcome === "unchanged") continue;

    checkpoint = await input.step.run(round.childCheckpointStepId, () =>
      input.repository.checkpointRun({
        id: round.childCheckpointId,
        run,
        expectedParentRevision: checkpoint.revision,
        expectedChanges: inspected.changes,
        message: `docs: revise ${input.event.issueIdentifier} spec`,
      }),
    );
  }

  if (!finalReview) {
    throw new Error("Spec cycle completed without a review result.");
  }
  return publishReviewedSpec({
    ...input,
    run,
    checkpoint,
    specDecision: authored.result.decision,
    specProvenance: authored.result.provenance,
    reviewDecision: finalReview.decision,
    reviewProvenance: finalReview.provenance,
    reviewRound: finalReviewRound,
    approved,
  });
}

async function publishReviewedSpec(input: {
  step: StepTools;
  event: WorkRequestData;
  authority: SpecAuthority;
  run: RepositoryRun;
  workId: string;
  linear: LinearSpecService;
  repository: RepositoryService;
  github: GitHubPublicationService;
  config: LinearSpecFunctionConfig;
  checkpoint: RepositoryCheckpoint;
  specDecision: Extract<SpecDecision, { outcome: "ready-for-review" }>;
  specProvenance: Extract<SpecIssueResult, { ok: true }>["provenance"];
  reviewDecision: Extract<SpecReviewResult, { ok: true }>["decision"];
  reviewProvenance: Extract<SpecReviewResult, { ok: true }>["provenance"];
  reviewRound: (typeof SPEC_CYCLE_REVIEW_ROUNDS)[number];
  approved: boolean;
}) {
  const identity = createSpecCycleRoundIdentity({
    workRequestId: input.workId,
    reviewRound: input.reviewRound,
    checkpointRevision: input.checkpoint.revision,
  });

  const confirmedPublication = await input.step.run(
    `${identity.key}:authority-before-publication`,
    () => confirmClaimedSpec(input.linear, input.authority, input.config.readiness),
  );
  if (confirmedPublication.kind === "stale") {
    return recoverStaleAuthority(input, input.run, confirmedPublication.reason);
  }
  const run = await input.step.run(`${identity.key}:open-before-publication`, () =>
    input.repository.openCheckpoint({
      checkpoint: input.checkpoint,
      baseRef: input.config.baseRef,
    }),
  );

  const published = await input.step.run(identity.publishStepId, async () => {
    return publishReviewedSpecCheckpoint({
      linear: input.linear,
      authority: input.authority,
      readiness: input.config.readiness,
      github: input.github,
      repository: input.config.githubRepository,
      run,
      checkpoint: input.checkpoint,
      baseRef: input.config.baseRef,
      commentIdentity: identity.commentIdentity,
      specDecision: input.specDecision,
      specProvenance: input.specProvenance,
      reviewDecision: input.reviewDecision,
      reviewProvenance: input.reviewProvenance,
      approved: input.approved,
    });
  });
  if (published.kind === "stale") {
    return recoverStaleAuthority(input, run, published.reason);
  }
  if (published.kind === "invalid") {
    return recoverSpecFailure({
      ...recoveryInput(input, run),
      reason: published.error,
      failureKind: "invalid-publication",
    });
  }

  const confirmedProjection = await input.step.run(
    `${identity.key}:authority-before-projection`,
    () => confirmClaimedSpec(input.linear, input.authority, input.config.readiness),
  );
  if (confirmedProjection.kind === "stale") {
    return recoverStaleAuthority(input, run, confirmedProjection.reason);
  }
  await input.step.run(identity.projectStepId, () =>
    projectSpecOutcome({
      linear: input.linear,
      issueId: input.event.issueId,
      marker: published.marker,
      comment: published.comment,
      specLabelId: input.config.readiness.agentActionLabelIds.spec,
      inProgressStateId: input.config.readiness.stateIds.inProgress,
      targetStateId: input.config.readiness.stateIds.needsReview,
    }),
  );
  const cleanup = await cleanupSpecRun(input, run, identity.key);
  return {
    outcome: "ready-for-review" as const,
    reviewOutcome: input.approved ? ("approved" as const) : ("exhausted" as const),
    issueId: input.event.issueId,
    pullRequestUrl: published.pullRequest.url,
    cleanup,
  };
}

async function recoverStaleAuthority(
  input: {
    step: StepTools;
    event: WorkRequestData;
    authority: SpecAuthority;
    linear: LinearSpecService;
    repository: RepositoryService;
    config: LinearSpecFunctionConfig;
  },
  run: RepositoryRun | undefined,
  reason: string,
) {
  return recoverSpecFailure({
    step: input.step,
    event: input.event,
    authority: input.authority,
    run,
    linear: input.linear,
    repository: input.repository,
    readiness: input.config.readiness,
    reason: `Spec authority changed during execution: ${reason}`,
    failureKind: "stale-authority",
  });
}

function recoveryInput(
  input: {
    step: StepTools;
    event: WorkRequestData;
    authority: SpecAuthority;
    linear: LinearSpecService;
    repository: RepositoryService;
    config: LinearSpecFunctionConfig;
  },
  run: RepositoryRun | undefined,
) {
  return {
    step: input.step,
    event: input.event,
    authority: input.authority,
    run,
    linear: input.linear,
    repository: input.repository,
    readiness: input.config.readiness,
  };
}

async function recoverSpecFailure(input: {
  step: StepTools;
  event: WorkRequestData;
  authority: SpecAuthority;
  run: RepositoryRun | undefined;
  linear: LinearSpecService;
  repository: RepositoryService;
  readiness: LinearReadinessConfig;
  reason: string;
  failureKind: string;
  allowAgentReadyClaim?: boolean;
}) {
  let projectionError: unknown;
  try {
    const recovery = await input.step.run(LINEAR_SPEC_FAILURE_COMMENT_STEP_ID, () =>
      beginSpecRecovery({
        linear: input.linear,
        event: input.event,
        authority: input.authority,
        readiness: input.readiness,
        error: input.reason,
        allowAgentReadyClaim: input.allowAgentReadyClaim,
      }),
    );
    if (recovery.currentClaim) {
      await input.step.run(LINEAR_SPEC_RECOVERY_STATE_STEP_ID, () =>
        reopenSpecClaim({
          linear: input.linear,
          issueId: input.event.issueId,
          readiness: input.readiness,
        }),
      );
      await input.step.run(LINEAR_SPEC_RECOVERY_LABEL_STEP_ID, () =>
        finishSpecRecovery({
          linear: input.linear,
          issueId: input.event.issueId,
          readiness: input.readiness,
        }),
      );
    }
  } catch (error) {
    projectionError = error;
  }

  const cleanup = input.run
    ? await cleanupSpecRun(
        {
          step: input.step,
          event: input.event,
          linear: input.linear,
          repository: input.repository,
        },
        input.run,
        "recovery",
      )
    : ("not-prepared" as const);
  if (projectionError !== undefined) throw projectionError;
  return {
    ...failedResult(input.event, input.failureKind),
    cleanup,
  };
}

async function cleanupSpecRun(
  input: {
    step: StepTools;
    event: WorkRequestData;
    linear: LinearSpecService;
    repository: RepositoryService;
  },
  run: RepositoryRun,
  identity: string,
): Promise<"cleaned" | "failed"> {
  return cleanupRepositoryRun({
    runStep: (stepId, handler) => input.step.run(stepId, handler),
    cleanupStepId: `${LINEAR_SPEC_CLEANUP_STEP_ID}:${identity}`,
    diagnosticStepId: `${LINEAR_SPEC_CLEANUP_FAILURE_COMMENT_STEP_ID}:${identity}`,
    repository: input.repository,
    run,
    reportFailure: (error) =>
      ensureSpecFailureComment({
        linear: input.linear,
        event: input.event,
        error: `Repository cleanup failed and requires operator attention: ${error}`,
        markerKind: "cleanup-failure",
      }),
  });
}

export function specWorkIdentity(event: WorkRequestData): Readonly<{
  workId: string;
  branch: string;
}> {
  const workId = workRequestEventId("spec", event);
  const digest = workId.slice(WORK_REQUEST_EVENT_ID_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new SpecPresentationError("Spec work request ID has no stable digest.");
  }
  const reference = SpecIssueReferenceSchema.parse(event.issueIdentifier);
  return Object.freeze({
    workId,
    branch: `harness/spec/${reference}-${digest.slice(0, 12)}`,
  });
}

function reviewArtifact(path: string, checkpoint: RepositoryCheckpoint): SpecReviewArtifact {
  return {
    path,
    revision: checkpoint.revision,
  };
}

function isRetryableSpecFailure(result: Extract<SpecIssueResult, { ok: false }>): boolean {
  return ["provider", "timeout", "cancelled"].includes(result.failureKind);
}

function isRetryableReviewFailure(result: Extract<SpecReviewResult, { ok: false }>): boolean {
  return ["provider", "timeout", "cancelled"].includes(result.failureKind);
}

function isRetryableRevisionFailure(result: Extract<SpecRevisionResult, { ok: false }>): boolean {
  return ["provider", "timeout", "cancelled"].includes(result.failureKind);
}

function failedResult(event: WorkRequestData, reason: string) {
  return {
    outcome: "failed" as const,
    reason,
    issueId: event.issueId,
  };
}
