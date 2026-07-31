import type { Context, FailureEventArgs, Inngest, InngestFunction } from "inngest";
import { z } from "zod";
import { AGENT_REASONING_EFFORTS, type Agent } from "../agent/contract.ts";
import { errorMessage } from "../agent/invocation.ts";
import {
  implementWorkItem,
  type ImplementationExecution,
  type ImplementationResult,
} from "../implementation/implementation.ts";
import { reviseImplementation } from "../implementation/revise.ts";
import type { ImplementationRevisionAuthorSession } from "../implementation/revise-schema.ts";
import { createImplementationRevisionReview } from "../../workflows/implementation-review-findings.ts";
import type { ChangeReviewResult } from "../../workflows/change-review.workflow.ts";
import {
  resolveImplementationSource,
  type ImplementationSource,
} from "../implementation/source.ts";
import type { GitHubPublicationService, GitHubRepositoryIdentity } from "../github/types.ts";
import type { LinearService } from "../linear/client.ts";
import type {
  RepositoryCheckpoint,
  RepositoryRun,
  RepositoryService,
} from "../repository/types.ts";
import type { ImplementationWorkRequestData } from "./events/work-events.ts";
import {
  ImplementationWorkRequestedEvent,
  ImplementationWorkRequestDataSchema,
} from "./events/work-events.ts";
import { LinearReadinessConfigSchema, type LinearReadinessConfig } from "./readiness.ts";
import type { WorkItemContext } from "../work-item/schema.ts";
import {
  confirmClaimedImplementation,
  loadClaimedImplementation,
  loadEligibleImplementation,
  type ImplementationAuthority,
} from "./implementation-authority.ts";
import {
  implementationCommentMarker,
  implementationCycleCommentMarker,
  implementationCycleIdentity,
  implementationWorkIdentity,
} from "./implementation-cycle.ts";
import {
  beginImplementationFailureRecovery,
  claimImplementationState,
  consumeImplementationAgentReady,
  ensureImplementationCleanupFailureComment,
  ensureImplementationFailureComment,
  finishImplementationRecovery,
  projectImplementationOutcome,
  reopenImplementationClaim,
} from "./implementation-projection.ts";
import { cleanupRepositoryRun, isRepositoryCleanupDiagnosticError } from "./repository-cleanup.ts";
import {
  renderImplementationNeedsInputComment,
  renderImplementationOutcomeComment,
  renderImplementationPullRequest,
  renderImplementationRevisionNeedsInputComment,
  reservedImplementationPullRequestUrl,
} from "./implementation-presentation.ts";

export const LINEAR_IMPLEMENTATION_FUNCTION_ID = "implementation-linear-issue-v1";
export const LINEAR_IMPLEMENTATION_RETRIES = 3;
export const LINEAR_IMPLEMENTATION_LOAD_STEP_ID = "load-linear-implementation-v1";
export const LINEAR_IMPLEMENTATION_CLAIM_STEP_ID = "claim-linear-implementation-v1";
export const LINEAR_IMPLEMENTATION_CONSUME_STEP_ID = "consume-linear-implementation-agent-ready-v1";
export const LINEAR_IMPLEMENTATION_BASE_STEP_ID = "resolve-linear-implementation-base-v1";
export const LINEAR_IMPLEMENTATION_PREPARE_STEP_ID = "prepare-linear-implementation-run-v1";
export const LINEAR_IMPLEMENTATION_SOURCE_STEP_ID = "resolve-linear-implementation-source-v1";
export const LINEAR_IMPLEMENTATION_AGENT_STEP_ID = "run-linear-implementation-agent-v1";
export const LINEAR_IMPLEMENTATION_INSPECT_STEP_ID = "inspect-linear-implementation-changes-v1";
export const LINEAR_IMPLEMENTATION_CHECKPOINT_STEP_ID = "checkpoint-linear-implementation-v1";
export const LINEAR_IMPLEMENTATION_REVIEW_STEP_ID = "review-linear-implementation-v1";
export const LINEAR_IMPLEMENTATION_REVISION_STEP_ID = "revise-linear-implementation-v1";
export const LINEAR_IMPLEMENTATION_PUBLISH_STEP_ID = "publish-linear-implementation-v1";
export const LINEAR_IMPLEMENTATION_PROJECT_STEP_ID = "project-linear-implementation-v1";
export const LINEAR_IMPLEMENTATION_CLEANUP_STEP_ID = "cleanup-linear-implementation-v1";
export const LINEAR_IMPLEMENTATION_FAILURE_STEP_ID = "project-linear-implementation-failure-v1";

export type LinearImplementationService = Pick<
  LinearService,
  "getIssueContext" | "ensureComment" | "updateIssueLabels" | "updateIssueState"
>;

export type ImplementationReviewRunner = (input: {
  workspace: string;
  baseSha: string;
  revision: string;
  source: ImplementationSource;
}) => Promise<ChangeReviewResult>;

export type LinearImplementationFunctionConfig = Readonly<{
  readiness: LinearReadinessConfig;
  baseRef: string;
  execution: ImplementationExecution;
  githubRepository: GitHubRepositoryIdentity;
}>;

type StepTools = Context<Inngest.Any>["step"];

const ExecutionSchema = z
  .object({
    model: z.string().trim().min(1),
    modelReasoningEffort: z.enum(AGENT_REASONING_EFFORTS),
    maxRuntimeMs: z.number().int().positive(),
    logPath: z.string().trim().min(1).optional(),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
  })
  .strict();

const FunctionConfigSchema = z
  .object({
    readiness: LinearReadinessConfigSchema,
    baseRef: z.string().trim().min(1),
    execution: ExecutionSchema,
    githubRepository: z
      .object({
        owner: z.string().trim().min(1),
        repository: z.string().trim().min(1),
        httpsRemote: z.string().url(),
      })
      .strict(),
  })
  .strict();

export function createLinearImplementationFunction(input: {
  client: Inngest.Any;
  linear: LinearImplementationService;
  implementerAgent: Agent;
  review: ImplementationReviewRunner;
  repository: RepositoryService;
  github: GitHubPublicationService;
  config: LinearImplementationFunctionConfig;
}): InngestFunction.Any {
  const config = FunctionConfigSchema.parse(input.config);
  const onFailure = async ({ event, error, step }: Context<Inngest.Any, FailureEventArgs>) => {
    const original = ImplementationWorkRequestDataSchema.safeParse(event.data.event.data);
    if (!original.success) return;
    const reason = errorMessage(error);
    const cleanupFailure = isRepositoryCleanupDiagnosticError(error);
    const authority = original.data.sourceFingerprint
      ? {
          issueId: original.data.issueId,
          issueIdentifier: original.data.issueIdentifier,
          sourceFingerprint: original.data.sourceFingerprint,
        }
      : null;
    const recovery = authority
      ? await step.run(`${LINEAR_IMPLEMENTATION_FAILURE_STEP_ID}:inspect`, () =>
          beginImplementationFailureRecovery({
            linear: input.linear,
            issueId: original.data.issueId,
            readiness: config.readiness,
            authority,
          }),
        )
      : { reopen: false, removeAgentReady: false };
    await step.run(`${LINEAR_IMPLEMENTATION_FAILURE_STEP_ID}:comment`, () =>
      cleanupFailure
        ? ensureImplementationCleanupFailureComment({
            linear: input.linear,
            event: original.data,
            error: reason,
            bestEffort: true,
          })
        : ensureImplementationFailureComment({
            linear: input.linear,
            event: original.data,
            error: reason,
            bestEffort: true,
          }),
    );
    if (recovery.reopen) {
      await step.run(`${LINEAR_IMPLEMENTATION_FAILURE_STEP_ID}:reopen`, () =>
        reopenImplementationClaim({
          linear: input.linear,
          issueId: original.data.issueId,
          readiness: config.readiness,
        }),
      );
    }
    if (recovery.removeAgentReady) {
      await step.run(`${LINEAR_IMPLEMENTATION_FAILURE_STEP_ID}:labels`, () =>
        finishImplementationRecovery({
          linear: input.linear,
          issueId: original.data.issueId,
          readiness: config.readiness,
        }),
      );
    }
    // Failure events do not carry prior step output, so reacquire the deterministic
    // run identity and release any Grove lease left by a failed attempt.
    const identity = implementationWorkIdentity(original.data);
    const run = await step.run(`${LINEAR_IMPLEMENTATION_FAILURE_STEP_ID}:recover-run`, () =>
      input.repository.recoverRun({ id: identity.workId }),
    );
    if (run) {
      await cleanupRepositoryRun({
        runStep: (id, handler) =>
          step.run(`${LINEAR_IMPLEMENTATION_FAILURE_STEP_ID}:cleanup:${id}`, handler),
        cleanupStepId: "run",
        diagnosticStepId: "diagnostic",
        repository: input.repository,
        run,
        reportFailure: (cleanupError) =>
          ensureImplementationCleanupFailureComment({
            linear: input.linear,
            event: original.data,
            error: cleanupError,
          }),
      });
    }
  };

  return input.client.createFunction(
    {
      id: LINEAR_IMPLEMENTATION_FUNCTION_ID,
      concurrency: { key: "event.data.issueId", limit: 1 },
      retries: LINEAR_IMPLEMENTATION_RETRIES,
      triggers: [ImplementationWorkRequestedEvent],
      onFailure,
    },
    async ({ event, step }) => {
      const loaded = await step.run(LINEAR_IMPLEMENTATION_LOAD_STEP_ID, () =>
        loadEligibleImplementation(input.linear, event.data, config.readiness),
      );
      if (loaded.kind === "ineligible")
        return { outcome: "ignored" as const, reason: loaded.reason };

      let run: RepositoryRun | undefined;
      const authority = loaded.authority;
      try {
        await step.run(LINEAR_IMPLEMENTATION_CLAIM_STEP_ID, () =>
          claimImplementationState(input.linear, event.data.issueId, config.readiness),
        );
        await step.run(LINEAR_IMPLEMENTATION_CONSUME_STEP_ID, () =>
          consumeImplementationAgentReady(input.linear, event.data.issueId, config.readiness),
        );

        const identity = implementationWorkIdentity(event.data);
        const base = await step.run(LINEAR_IMPLEMENTATION_BASE_STEP_ID, () =>
          input.repository.resolveBase({ baseRef: config.baseRef }),
        );
        run = await step.run(LINEAR_IMPLEMENTATION_PREPARE_STEP_ID, () =>
          input.repository.prepareRun({ id: identity.workId, base, branch: identity.branch }),
        );

        const selected = await step.run(LINEAR_IMPLEMENTATION_SOURCE_STEP_ID, async () => {
          const claimed = await loadClaimedImplementation(
            input.linear,
            authority,
            config.readiness,
          );
          if (claimed.kind === "stale" || !claimed.workItem) return claimed;
          const source = resolveImplementationSource({
            workspace: run!.workspace,
            workItem: claimed.workItem,
          });
          if (!source.ok) throw new Error(source.error);
          return { kind: "confirmed" as const, workItem: claimed.workItem, source: source.value };
        });
        if (selected.kind === "stale")
          return staleResult(
            event.data,
            authority,
            config.readiness,
            selected.reason,
            run,
            input.repository,
            step,
            input.linear,
          );

        const authored = await step.run(LINEAR_IMPLEMENTATION_AGENT_STEP_ID, async () => {
          const existing = await input.repository.inspectChanges(run!);
          if (existing.length > 0)
            throw new Error(
              "Implementation retry found workspace changes from an earlier failed attempt.",
            );
          const result = await implementWorkItem({
            source: selected.source,
            workspace: run!.workspace,
            agent: input.implementerAgent,
            execution: config.execution,
          });
          if (!result.ok) throw new Error(result.error);
          return result;
        });
        const confirmedAfterAgent = await step.run(
          `${LINEAR_IMPLEMENTATION_AGENT_STEP_ID}:confirm`,
          () => confirmClaimedImplementation(input.linear, authority, config.readiness),
        );
        if (confirmedAfterAgent.kind === "stale")
          return staleResult(
            event.data,
            authority,
            config.readiness,
            confirmedAfterAgent.reason,
            run,
            input.repository,
            step,
            input.linear,
          );
        if (authored.decision.outcome === "needs-input") {
          const result = await projectNeedsInput({
            event: event.data,
            decision: authored.decision,
            authority,
            linear: input.linear,
            readiness: config.readiness,
            step,
          });
          if (result.outcome === "stale")
            return staleResult(
              event.data,
              authority,
              config.readiness,
              result.reason,
              run,
              input.repository,
              step,
              input.linear,
            );
          return finishWithCleanup(
            input.repository,
            run!,
            step,
            result,
            "needs-input",
            input.linear,
            event.data,
          );
        }

        let changes = await step.run(LINEAR_IMPLEMENTATION_INSPECT_STEP_ID, () =>
          input.repository.inspectChanges(run!),
        );
        if (changes.length === 0) {
          const result = await projectZeroChange({
            event: event.data,
            workItem: selected.workItem,
            decision: authored.decision,
            source: selected.source,
            authority,
            linear: input.linear,
            readiness: config.readiness,
            step,
          });
          if (result.outcome === "stale")
            return staleResult(
              event.data,
              authority,
              config.readiness,
              result.reason,
              run,
              input.repository,
              step,
              input.linear,
            );
          return finishWithCleanup(
            input.repository,
            run!,
            step,
            result,
            "zero-change",
            input.linear,
            event.data,
          );
        }

        let checkpoint = await step.run(LINEAR_IMPLEMENTATION_CHECKPOINT_STEP_ID, () =>
          input.repository.checkpointRun({
            id: `implementation-cycle-v1:initial:${identity.workId}`,
            run: run!,
            expectedParentRevision: run!.baseSha,
            expectedChanges: changes,
            message: `feat: implement ${event.data.issueIdentifier}`,
          }),
        );
        const implementationDecision = authored.decision;
        run = await openReviewRun({
          repository: input.repository,
          step,
          baseRef: config.baseRef,
          workRequestId: identity.workId,
          checkpoint,
          round: 0,
        });
        let review = await runReview(
          input.review,
          step,
          identity.workId,
          checkpoint,
          run!,
          selected.source,
          0,
        );
        let reviewRound: 0 | 1 = 0;
        let exhausted = false;
        const authorSession = authored.provenance.session;
        const confirmedAfterReview = await step.run(
          `${LINEAR_IMPLEMENTATION_REVIEW_STEP_ID}:confirm`,
          () => confirmClaimedImplementation(input.linear, authority, config.readiness),
        );
        if (confirmedAfterReview.kind === "stale")
          return staleResult(
            event.data,
            authority,
            config.readiness,
            confirmedAfterReview.reason,
            run,
            input.repository,
            step,
            input.linear,
          );

        if (review.verdict !== "pass") {
          const revisionReview = createImplementationRevisionReview({
            reviewedRevision: checkpoint.revision,
            reviews: requireReviewerOutputs(review),
          });
          if (!revisionReview.ok) throw new Error(revisionReview.error);
          if (!authorSession)
            throw new Error("Implementation agent did not return a resumable author session.");
          const revised = await step.run(LINEAR_IMPLEMENTATION_REVISION_STEP_ID, async () => {
            const revisionRun = await input.repository.openCheckpoint({
              checkpoint,
              baseRef: config.baseRef,
            });
            const result = await reviseImplementation({
              source: selected.source,
              review: revisionReview.review,
              authorSession: toRevisionSession(authorSession),
              workspace: revisionRun.workspace,
              agent: input.implementerAgent,
              execution: config.execution,
            });
            if (!result.ok) throw new Error(result.error);
            return { result, run: revisionRun };
          });
          const revisionDecision = revised.result.decision;
          const confirmedAfterRevision = await step.run(
            `${LINEAR_IMPLEMENTATION_REVISION_STEP_ID}:confirm`,
            () => confirmClaimedImplementation(input.linear, authority, config.readiness),
          );
          if (confirmedAfterRevision.kind === "stale")
            return staleResult(
              event.data,
              authority,
              config.readiness,
              confirmedAfterRevision.reason,
              revised.run,
              input.repository,
              step,
              input.linear,
            );
          if (revisionDecision.outcome === "needs-input") {
            const marker = implementationCycleCommentMarker(
              implementationCycleIdentity({
                workRequestId: identity.workId,
                reviewRound: 0,
                checkpointRevision: checkpoint.revision,
              }).commentIdentity,
              "needs-input",
            );
            const comment = renderImplementationRevisionNeedsInputComment({
              marker,
              decision: revisionDecision,
            });
            const projected = await step.run(
              `${LINEAR_IMPLEMENTATION_PROJECT_STEP_ID}:revision-needs-input`,
              () =>
                projectClaimedImplementationOutcome({
                  linear: input.linear,
                  authority,
                  issueId: event.data.issueId,
                  marker,
                  comment,
                  readiness: config.readiness,
                  targetStateId: config.readiness.stateIds.needsInput,
                }),
            );
            if (projected.kind === "stale")
              return staleResult(
                event.data,
                authority,
                config.readiness,
                projected.reason,
                revised.run,
                input.repository,
                step,
                input.linear,
              );
            const result = { outcome: "needs-input" as const, issueId: event.data.issueId };
            return finishWithCleanup(
              input.repository,
              revised.run,
              step,
              result,
              "needs-input",
              input.linear,
              event.data,
            );
          }
          changes = await step.run(`${LINEAR_IMPLEMENTATION_INSPECT_STEP_ID}:revision`, () =>
            input.repository.inspectChanges(revised.run),
          );
          if (revisionDecision.outcome === "unchanged" && changes.length > 0) {
            throw new Error(
              "Implementation revision reported unchanged but modified the workspace.",
            );
          }
          if (revisionDecision.outcome === "updated" && changes.length === 0) {
            throw new Error(
              "Implementation revision reported updated but made no workspace changes.",
            );
          }
          if (revisionDecision.outcome === "updated") {
            const round = implementationCycleIdentity({
              workRequestId: identity.workId,
              reviewRound: 1,
              checkpointRevision: checkpoint.revision,
            });
            checkpoint = await step.run(round.checkpointStepId, () =>
              input.repository.checkpointRun({
                id: round.checkpointId,
                run: revised.run,
                expectedParentRevision: checkpoint.revision,
                expectedChanges: changes,
                message: `fix: revise ${event.data.issueIdentifier} implementation`,
              }),
            );
          }
          reviewRound = 1;
          run = await openReviewRun({
            repository: input.repository,
            step,
            baseRef: config.baseRef,
            workRequestId: identity.workId,
            checkpoint,
            round: reviewRound,
          });
          review = await runReview(
            input.review,
            step,
            identity.workId,
            checkpoint,
            run!,
            selected.source,
            1,
          );
          exhausted = review.verdict !== "pass";
          const confirmedAfterRevisionReview = await step.run(
            `${LINEAR_IMPLEMENTATION_REVIEW_STEP_ID}:revision-confirm`,
            () => confirmClaimedImplementation(input.linear, authority, config.readiness),
          );
          if (confirmedAfterRevisionReview.kind === "stale")
            return staleResult(
              event.data,
              authority,
              config.readiness,
              confirmedAfterRevisionReview.reason,
              run,
              input.repository,
              step,
              input.linear,
            );
        }

        const published = await publish(
          input,
          config,
          step,
          authority,
          identity.workId,
          selected.workItem,
          implementationDecision,
          selected.source,
          checkpoint,
          review,
          reviewRound,
          exhausted,
        );
        if (published.kind === "stale")
          return staleResult(
            event.data,
            authority,
            config.readiness,
            published.reason,
            run,
            input.repository,
            step,
            input.linear,
          );
        run = published.run;
        const projected = await step.run(LINEAR_IMPLEMENTATION_PROJECT_STEP_ID, () =>
          projectClaimedImplementationOutcome({
            linear: input.linear,
            authority,
            issueId: event.data.issueId,
            marker: published.marker,
            comment: published.comment,
            readiness: config.readiness,
            targetStateId: config.readiness.stateIds.needsReview,
          }),
        );
        if (projected.kind === "stale")
          return staleResult(
            event.data,
            authority,
            config.readiness,
            projected.reason,
            run,
            input.repository,
            step,
            input.linear,
          );
        return finishWithCleanup(
          input.repository,
          run!,
          step,
          {
            outcome: "published" as const,
            issueId: event.data.issueId,
            pullRequestUrl: published.pullRequestUrl,
            review: exhausted ? ("exhausted" as const) : ("passed" as const),
          },
          "published",
          input.linear,
          event.data,
        );
      } catch (error) {
        if (isRepositoryCleanupDiagnosticError(error)) throw error;
        if (run) {
          await cleanupRepositoryRun({
            runStep: (id, handler) =>
              step.run(`${LINEAR_IMPLEMENTATION_CLEANUP_STEP_ID}:failure:${id}`, handler),
            cleanupStepId: "run",
            diagnosticStepId: "diagnostic",
            repository: input.repository,
            run,
            reportFailure: (cleanupError) =>
              ensureImplementationCleanupFailureComment({
                linear: input.linear,
                event: event.data,
                error: cleanupError,
              }),
          });
        }
        throw error;
      }
    },
  );
}

async function runReview(
  review: ImplementationReviewRunner,
  step: StepTools,
  workRequestId: string,
  checkpoint: RepositoryCheckpoint,
  run: RepositoryRun,
  source: ImplementationSource,
  round: 0 | 1,
): Promise<Extract<ChangeReviewResult, { status: "completed" }>> {
  const identity = implementationCycleIdentity({
    workRequestId,
    reviewRound: round,
    checkpointRevision: checkpoint.revision,
  });
  const result = await step.run(
    `${LINEAR_IMPLEMENTATION_REVIEW_STEP_ID}:${round}:${identity.key}`,
    () =>
      review({
        workspace: run.workspace,
        baseSha: checkpoint.baseSha,
        revision: checkpoint.revision,
        source,
      }),
  );
  if (result.status !== "completed" || result.verdict === "blocked") {
    throw new Error("Implementation review did not complete both reviewers successfully.");
  }
  requireReviewerOutputs(result);
  return result;
}

async function openReviewRun(input: {
  repository: RepositoryService;
  step: StepTools;
  baseRef: string;
  workRequestId: string;
  checkpoint: RepositoryCheckpoint;
  round: 0 | 1;
}): Promise<RepositoryRun> {
  const identity = implementationCycleIdentity({
    workRequestId: input.workRequestId,
    reviewRound: input.round,
    checkpointRevision: input.checkpoint.revision,
  });
  return input.step.run(`${identity.reviewStepId}:open`, () =>
    input.repository.openCheckpoint({
      checkpoint: input.checkpoint,
      baseRef: input.baseRef,
    }),
  );
}

function requireReviewerOutputs(review: Extract<ChangeReviewResult, { status: "completed" }>) {
  if (!review.reviewOutputs.implementation || !review.reviewOutputs.quality) {
    throw new Error("Implementation review did not return both reviewer outputs.");
  }
  return {
    implementation: review.reviewOutputs.implementation,
    quality: review.reviewOutputs.quality,
  };
}

function toRevisionSession(session: {
  provider: ImplementationRevisionAuthorSession["provider"];
  id: string;
}): ImplementationRevisionAuthorSession {
  return { version: 1, provider: session.provider, id: session.id };
}

async function publish(
  input: Parameters<typeof createLinearImplementationFunction>[0],
  config: LinearImplementationFunctionConfig,
  step: StepTools,
  authority: ImplementationAuthority,
  workRequestId: string,
  workItem: Parameters<typeof renderImplementationPullRequest>[0]["workItem"],
  decision: Extract<ImplementationResult, { ok: true }>["decision"],
  source: ImplementationSource,
  checkpoint: RepositoryCheckpoint,
  review: Extract<ChangeReviewResult, { status: "completed" }>,
  reviewRound: 0 | 1,
  exhausted: boolean,
) {
  const identity = implementationCycleIdentity({
    workRequestId,
    reviewRound,
    checkpointRevision: checkpoint.revision,
  });
  return step.run(`${identity.publishStepId}`, async () => {
    const confirmed = await confirmClaimedImplementation(input.linear, authority, config.readiness);
    if (confirmed.kind === "stale") return { kind: "stale" as const, reason: confirmed.reason };
    const opened = await input.repository.openCheckpoint({
      checkpoint,
      baseRef: config.baseRef,
    });
    const implemented = requireImplementedDecision(decision);
    const presentation = renderImplementationPullRequest({
      workItem,
      decision: implemented,
      source,
      checkpoint,
      review: { result: review, exhausted },
    });
    const reservedUrl = reservedImplementationPullRequestUrl(config.githubRepository);
    const comment = renderImplementationOutcomeComment({
      marker: implementationCycleCommentMarker(
        identity.commentIdentity,
        exhausted ? "exhausted" : "published",
      ),
      workItem,
      decision: implemented,
      source,
      checkpoint,
      review: { result: review, exhausted },
      pullRequestUrl: reservedUrl,
    });
    const pullRequest = await input.github.publishCheckpointPullRequest({
      run: opened,
      checkpoint,
      baseBranch: config.baseRef,
      title: presentation.title,
      body: presentation.body,
    });
    if (
      pullRequest.headSha !== checkpoint.revision ||
      pullRequest.merged ||
      pullRequest.state !== "open" ||
      pullRequest.owner !== config.githubRepository.owner ||
      pullRequest.repository !== config.githubRepository.repository ||
      pullRequest.baseBranch !== opened.baseRef ||
      pullRequest.headBranch !== opened.branch ||
      pullRequest.url.length > reservedUrl.length
    ) {
      throw new Error("Implementation publication did not return the selected checkpoint.");
    }
    return {
      kind: "published" as const,
      run: opened,
      pullRequestUrl: pullRequest.url,
      marker: implementationCycleCommentMarker(
        identity.commentIdentity,
        exhausted ? "exhausted" : "published",
      ),
      comment: comment.replaceAll(reservedUrl, pullRequest.url),
    };
  });
}

function requireImplementedDecision(
  decision: Extract<ImplementationResult, { ok: true }>["decision"],
): Extract<ImplementationResult, { ok: true }>["decision"] & { outcome: "implemented" } {
  if (decision.outcome !== "implemented") {
    throw new Error("Implementation publication requires an implemented decision.");
  }
  return decision;
}

async function projectNeedsInput(input: {
  event: ImplementationWorkRequestData;
  decision: Extract<ImplementationResult, { ok: true }>["decision"];
  authority: ImplementationAuthority;
  linear: LinearImplementationService;
  readiness: LinearReadinessConfig;
  step: StepTools;
  marker?: string;
}) {
  if (input.decision.outcome !== "needs-input")
    throw new Error("Expected an implementation Needs Input decision.");
  const marker = input.marker ?? implementationCommentMarker(input.event, "needs-input");
  const comment = renderImplementationNeedsInputComment({
    marker,
    summary: input.decision.summary,
    questions: input.decision.questions,
  });
  const projected = await input.step.run(
    `${LINEAR_IMPLEMENTATION_PROJECT_STEP_ID}:needs-input`,
    () =>
      projectClaimedImplementationOutcome({
        linear: input.linear,
        authority: input.authority,
        issueId: input.event.issueId,
        marker,
        comment,
        readiness: input.readiness,
        targetStateId: input.readiness.stateIds.needsInput,
      }),
  );
  return projected.kind === "stale"
    ? { outcome: "stale" as const, reason: projected.reason }
    : { outcome: "needs-input" as const, issueId: input.event.issueId };
}

async function projectZeroChange(input: {
  event: ImplementationWorkRequestData;
  workItem: WorkItemContext;
  decision: Extract<ImplementationResult, { ok: true }>["decision"];
  source: ImplementationSource;
  authority: ImplementationAuthority;
  linear: LinearImplementationService;
  readiness: LinearReadinessConfig;
  step: StepTools;
}) {
  if (input.decision.outcome !== "implemented")
    throw new Error("Expected an implemented decision.");
  const marker = implementationCommentMarker(input.event, "zero-change");
  const comment = renderImplementationOutcomeComment({
    marker,
    workItem: input.workItem,
    decision: input.decision,
    source: input.source,
    checkpoint: null,
    review: null,
  });
  const projected = await input.step.run(
    `${LINEAR_IMPLEMENTATION_PROJECT_STEP_ID}:zero-change`,
    () =>
      projectClaimedImplementationOutcome({
        linear: input.linear,
        authority: input.authority,
        issueId: input.event.issueId,
        marker,
        comment,
        readiness: input.readiness,
        targetStateId: input.readiness.stateIds.needsReview,
      }),
  );
  return projected.kind === "stale"
    ? { outcome: "stale" as const, reason: projected.reason }
    : { outcome: "zero-change" as const, issueId: input.event.issueId };
}

async function projectClaimedImplementationOutcome(input: {
  linear: LinearImplementationService;
  authority: ImplementationAuthority;
  issueId: string;
  marker: string;
  comment: string;
  readiness: LinearReadinessConfig;
  targetStateId: string;
}): Promise<Readonly<{ kind: "projected" }> | Readonly<{ kind: "stale"; reason: string }>> {
  return projectImplementationOutcome(input);
}

async function finishWithCleanup(
  repository: RepositoryService,
  run: RepositoryRun,
  step: StepTools,
  result: unknown,
  identity: string,
  linear: LinearImplementationService,
  event: ImplementationWorkRequestData,
) {
  await cleanupRepositoryRun({
    runStep: (id, handler) =>
      step.run(`${LINEAR_IMPLEMENTATION_CLEANUP_STEP_ID}:${identity}:${id}`, handler),
    cleanupStepId: "run",
    diagnosticStepId: "diagnostic",
    repository,
    run,
    reportFailure: (error) => ensureImplementationCleanupFailureComment({ linear, event, error }),
  });
  return result;
}

async function staleResult(
  event: ImplementationWorkRequestData,
  authority: ImplementationAuthority,
  readiness: LinearReadinessConfig,
  reason: string,
  run: RepositoryRun | undefined,
  repository: RepositoryService,
  step: StepTools,
  linear: LinearImplementationService,
) {
  if (run) {
    await step.run(`${LINEAR_IMPLEMENTATION_FAILURE_STEP_ID}:stale`, () =>
      ensureImplementationFailureComment({
        linear,
        event,
        error: `Implementation authority changed during execution: ${reason}`,
        bestEffort: true,
      }),
    );
    const recovery = await step.run(`${LINEAR_IMPLEMENTATION_FAILURE_STEP_ID}:stale-inspect`, () =>
      beginImplementationFailureRecovery({
        linear,
        issueId: event.issueId,
        readiness,
        authority,
      }),
    );
    if (recovery.reopen) {
      await step.run(`${LINEAR_IMPLEMENTATION_FAILURE_STEP_ID}:stale-reopen`, () =>
        reopenImplementationClaim({ linear, issueId: event.issueId, readiness }),
      );
    }
    if (recovery.removeAgentReady) {
      await step.run(`${LINEAR_IMPLEMENTATION_FAILURE_STEP_ID}:stale-labels`, () =>
        finishImplementationRecovery({ linear, issueId: event.issueId, readiness }),
      );
    }
    await finishWithCleanup(repository, run, step, undefined, "stale", linear, event);
  }
  return { outcome: "stale" as const, reason };
}
