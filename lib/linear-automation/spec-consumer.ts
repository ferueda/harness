import { createHash } from "node:crypto";
import type { Context, FailureEventArgs, Inngest, InngestFunction } from "inngest";
import { z } from "zod";
import { AGENT_REASONING_EFFORTS, type Agent } from "../agent/contract.ts";
import { errorMessage } from "../agent/invocation.ts";
import type {
  GitHubPublicationService,
  PublishedPullRequest,
  GitHubRepositoryIdentity,
} from "../github/types.ts";
import type { LinearService } from "../linear/client.ts";
import type { LinearIssueContext } from "../linear/types.ts";
import type { RepositoryService } from "../repository/types.ts";
import {
  renderSpecFailureComment,
  renderSpecOutcomeComment,
  renderSpecPullRequest,
  reservedPullRequestUrl,
  SpecPresentationError,
  validateSpecWorkspaceChanges,
} from "../spec/presentation.ts";
import {
  SpecIssueReferenceSchema,
  SpecWorkItemContextSchema,
  type SpecDecision,
  type SpecWorkItemContext,
} from "../spec/schema.ts";
import { specIssue, type SpecExecution, type SpecIssueResult } from "../spec/spec.ts";
import {
  SpecWorkRequestedEvent,
  WORK_REQUEST_EVENT_ID_PREFIX,
  WorkRequestDataSchema,
  workRequestEventId,
  type WorkRequestData,
} from "./events/work-events.ts";
import {
  classifyLinearReadiness,
  LinearReadinessConfigSchema,
  type LinearReadinessConfig,
} from "./readiness.ts";
import { toLinearWorkItemContext } from "./work-item.ts";

export const LINEAR_SPEC_FUNCTION_ID = "spec-linear-issue-v1";
export const LINEAR_SPEC_RETRIES = 3;
export const LINEAR_SPEC_LOAD_STEP_ID = "load-linear-spec-v1";
export const LINEAR_SPEC_CLAIM_STEP_ID = "claim-linear-spec-v2";
export const LINEAR_SPEC_BASE_STEP_ID = "resolve-linear-spec-base-v1";
export const LINEAR_SPEC_PREPARE_STEP_ID = "prepare-linear-spec-run-v1";
export const LINEAR_SPEC_AGENT_STEP_ID = "run-linear-spec-agent-v1";
export const LINEAR_SPEC_CONFIRM_STEP_ID = "confirm-linear-spec-authority-v1";
export const LINEAR_SPEC_INSPECT_STEP_ID = "inspect-linear-spec-changes-v1";
export const LINEAR_SPEC_PUBLISH_STEP_ID = "publish-linear-spec-v1";
export const LINEAR_SPEC_FAILURE_COMMENT_STEP_ID = "project-linear-spec-failure-v1";
export const LINEAR_SPEC_PROJECT_STEP_ID = "project-linear-spec-outcome-v1";
export const LINEAR_SPEC_CLEANUP_STEP_ID = "cleanup-linear-spec-run-v1";

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

type EligibleSpec = Readonly<{
  context: LinearIssueContext;
  workItem: SpecWorkItemContext;
  sourceFingerprint: string;
}>;

type LoadedSpec =
  | Readonly<{ kind: "eligible"; value: EligibleSpec }>
  | Readonly<{
      kind: "ineligible";
      reason: "issue-mismatch" | "incomplete-context" | "not-spec-ready" | "stale-snapshot";
    }>;

type ConfirmedSpec = Readonly<{ kind: "confirmed" }> | Readonly<{ kind: "stale"; reason: string }>;

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
  agent: Agent;
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

      await step.run(LINEAR_SPEC_CLAIM_STEP_ID, () =>
        claimSpec(input.linear, event.data.issueId, config.readiness),
      );

      const identity = specWorkIdentity(event.data);
      const base = await step.run(LINEAR_SPEC_BASE_STEP_ID, () =>
        input.repository.resolveBase({ baseRef: config.baseRef }),
      );
      const run = await step.run(LINEAR_SPEC_PREPARE_STEP_ID, () =>
        input.repository.prepareRun({
          id: identity.workId,
          base,
          branch: identity.branch,
        }),
      );

      const result = await step.run(LINEAR_SPEC_AGENT_STEP_ID, async () => {
        const executed = await specIssue({
          workItem: loaded.value.workItem,
          agent: input.agent,
          workspace: run.workspace,
          execution: config.execution,
        });
        if (!executed.ok && isRetryableAgentFailure(executed)) {
          throw new Error(executed.error);
        }
        return executed;
      });
      if (!result.ok) {
        await step.run(LINEAR_SPEC_FAILURE_COMMENT_STEP_ID, () =>
          ensureSpecFailureComment({
            linear: input.linear,
            event: event.data,
            error: result.error,
          }),
        );
        return failedResult(event.data, result.failureKind);
      }

      const confirmed = await step.run(LINEAR_SPEC_CONFIRM_STEP_ID, () =>
        confirmClaimedSpec(input.linear, loaded.value, config.readiness),
      );
      if (confirmed.kind === "stale") {
        await step.run(LINEAR_SPEC_FAILURE_COMMENT_STEP_ID, () =>
          ensureSpecFailureComment({
            linear: input.linear,
            event: event.data,
            error: `Spec authority changed during execution: ${confirmed.reason}`,
          }),
        );
        return failedResult(event.data, "stale-authority");
      }

      const inspected = await step.run(LINEAR_SPEC_INSPECT_STEP_ID, async () => {
        try {
          const changes = validateSpecWorkspaceChanges({
            reference: event.data.issueIdentifier,
            decision: result.decision,
            changes: await input.repository.inspectChanges(run),
          });
          const marker = specCommentMarker(event.data, result.decision.outcome);
          if (result.decision.outcome === "needs-input") {
            return {
              ok: true as const,
              changes,
              marker,
              comment: renderSpecOutcomeComment({
                marker,
                decision: result.decision,
                provenance: result.provenance,
              }),
            };
          }

          const pullRequest = renderSpecPullRequest({
            workItem: loaded.value.workItem,
            decision: result.decision,
            provenance: result.provenance,
          });
          const reservedUrl = reservedPullRequestUrl(config.githubRepository);
          renderSpecOutcomeComment({
            marker,
            decision: result.decision,
            provenance: result.provenance,
            pullRequestUrl: reservedUrl,
          });
          return {
            ok: true as const,
            changes,
            marker,
            pullRequest,
            reservedUrl,
          };
        } catch (error) {
          return { ok: false as const, error: errorMessage(error) };
        }
      });
      if (!inspected.ok) {
        await step.run(LINEAR_SPEC_FAILURE_COMMENT_STEP_ID, () =>
          ensureSpecFailureComment({
            linear: input.linear,
            event: event.data,
            error: inspected.error,
          }),
        );
        return failedResult(event.data, "invalid-workspace");
      }

      let pullRequest: PublishedPullRequest | null = null;
      if (result.decision.outcome === "ready-for-review") {
        const published = await step.run(LINEAR_SPEC_PUBLISH_STEP_ID, () =>
          input.github.publishPullRequest({
            run,
            expectedChanges: inspected.changes,
            baseBranch: config.baseRef,
            commitMessage: `docs: add ${event.data.issueIdentifier} spec`,
            title: inspected.pullRequest.title,
            body: inspected.pullRequest.body,
          }),
        );
        pullRequest = published;
        const publicationError = validatePublishedPullRequest(published, inspected.reservedUrl);
        if (publicationError) {
          await step.run(LINEAR_SPEC_FAILURE_COMMENT_STEP_ID, () =>
            ensureSpecFailureComment({
              linear: input.linear,
              event: event.data,
              error: publicationError,
            }),
          );
          return failedResult(event.data, "invalid-publication");
        }
      }

      const comment =
        result.decision.outcome === "ready-for-review"
          ? renderSpecOutcomeComment({
              marker: inspected.marker,
              decision: result.decision,
              provenance: result.provenance,
              pullRequestUrl: pullRequest?.url,
            })
          : inspected.comment;
      const targetStateId =
        result.decision.outcome === "ready-for-review"
          ? config.readiness.stateIds.needsReview
          : config.readiness.stateIds.needsInput;
      await step.run(LINEAR_SPEC_PROJECT_STEP_ID, () =>
        projectSpecOutcome({
          linear: input.linear,
          issueId: event.data.issueId,
          marker: inspected.marker,
          comment,
          specLabelId: config.readiness.agentActionLabelIds.spec,
          inProgressStateId: config.readiness.stateIds.inProgress,
          targetStateId,
        }),
      );
      await step.run(LINEAR_SPEC_CLEANUP_STEP_ID, () => input.repository.cleanupRun(run));

      return {
        outcome: result.decision.outcome,
        issueId: event.data.issueId,
        ...(pullRequest ? { pullRequestUrl: pullRequest.url } : {}),
      };
    },
  );
}

async function claimSpec(
  linear: LinearSpecService,
  issueId: string,
  readiness: LinearReadinessConfig,
): Promise<void> {
  await linear.updateIssueState({
    issueId,
    expectedStateId: readiness.stateIds.open,
    stateId: readiness.stateIds.inProgress,
  });
  await linear.updateIssueLabels({
    issueId,
    addLabelIds: [],
    removeLabelIds: [readiness.agentReadyLabelId],
  });
}

async function projectSpecOutcome(input: {
  linear: LinearSpecService;
  issueId: string;
  marker: string;
  comment: string;
  specLabelId: string;
  inProgressStateId: string;
  targetStateId: string;
}): Promise<void> {
  await input.linear.ensureComment({
    issueId: input.issueId,
    marker: input.marker,
    body: input.comment,
  });
  await input.linear.updateIssueLabels({
    issueId: input.issueId,
    addLabelIds: [],
    removeLabelIds: [input.specLabelId],
  });
  await input.linear.updateIssueState({
    issueId: input.issueId,
    expectedStateId: input.inProgressStateId,
    stateId: input.targetStateId,
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

export function specCommentMarker(
  event: WorkRequestData,
  outcome: SpecDecision["outcome"] | "failure",
): string {
  return `<!-- harness:linear-spec:${workRequestEventId("spec", event)}:${outcome} -->`;
}

export async function ensureSpecFailureComment(input: {
  linear: Pick<LinearSpecService, "ensureComment">;
  event: WorkRequestData;
  error: string;
  bestEffort?: boolean;
}): Promise<Readonly<{ projected: boolean }>> {
  const marker = specCommentMarker(input.event, "failure");
  try {
    await input.linear.ensureComment({
      issueId: input.event.issueId,
      marker,
      body: renderSpecFailureComment({ marker, error: input.error }),
    });
    return { projected: true };
  } catch (error) {
    if (!input.bestEffort) throw error;
    return { projected: false };
  }
}

async function loadEligibleSpec(
  linear: Pick<LinearSpecService, "getIssueContext">,
  event: WorkRequestData,
  readiness: LinearReadinessConfig,
): Promise<LoadedSpec> {
  const context = await linear.getIssueContext(event.issueId);
  if (context.id !== event.issueId || context.identifier !== event.issueIdentifier) {
    return { kind: "ineligible", reason: "issue-mismatch" };
  }
  if (!isComplete(context)) return { kind: "ineligible", reason: "incomplete-context" };

  const decision = classifyLinearReadiness({ context, config: readiness });
  if (decision.kind !== "dispatch" || decision.route !== "spec") {
    return { kind: "ineligible", reason: "not-spec-ready" };
  }
  if (decision.snapshotGeneration !== event.snapshotGeneration) {
    return { kind: "ineligible", reason: "stale-snapshot" };
  }

  const workItem = SpecWorkItemContextSchema.parse(
    toLinearWorkItemContext(context, readiness.agentReadyLabelId),
  );
  return {
    kind: "eligible",
    value: {
      context,
      workItem,
      sourceFingerprint: sourceFingerprint(context, readiness.agentReadyLabelId),
    },
  };
}

async function confirmClaimedSpec(
  linear: Pick<LinearSpecService, "getIssueContext">,
  initial: EligibleSpec,
  readiness: LinearReadinessConfig,
): Promise<ConfirmedSpec> {
  const context = await linear.getIssueContext(initial.context.id);
  if (!isComplete(context)) return { kind: "stale", reason: "context is incomplete" };
  if (
    context.id !== initial.context.id ||
    context.identifier !== initial.context.identifier ||
    context.team.id !== readiness.teamId ||
    context.project?.id !== readiness.projectId
  ) {
    return { kind: "stale", reason: "issue scope or identity changed" };
  }
  if (context.state.id !== readiness.stateIds.inProgress) {
    return { kind: "stale", reason: "issue is no longer In Progress" };
  }
  if (context.labels.some((label) => label.id === readiness.agentReadyLabelId)) {
    return { kind: "stale", reason: "Agent Ready permission is present again" };
  }
  const actions = context.labels.filter((label) =>
    Object.values(readiness.agentActionLabelIds).includes(label.id),
  );
  if (
    actions.length !== 1 ||
    actions[0]?.id !== readiness.agentActionLabelIds.spec ||
    hasUnresolvedBlocker(context, readiness)
  ) {
    return { kind: "stale", reason: "Spec action or blockers changed" };
  }
  if (sourceFingerprint(context, readiness.agentReadyLabelId) !== initial.sourceFingerprint) {
    return { kind: "stale", reason: "Linear source context changed" };
  }
  return { kind: "confirmed" };
}

function sourceFingerprint(context: LinearIssueContext, agentReadyLabelId: string): string {
  const workItem = toLinearWorkItemContext(context, agentReadyLabelId);
  const { state: _state, updatedAt: _updatedAt, ...source } = workItem;
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function hasUnresolvedBlocker(
  context: LinearIssueContext,
  readiness: LinearReadinessConfig,
): boolean {
  const terminal = new Set([
    readiness.stateIds.done,
    readiness.stateIds.canceled,
    readiness.stateIds.duplicate,
  ]);
  return context.blockedBy.some((blocker) => !terminal.has(blocker.state.id));
}

function isComplete(context: LinearIssueContext): boolean {
  return !Object.values(context.completeness).some(Boolean);
}

function isRetryableAgentFailure(result: Extract<SpecIssueResult, { ok: false }>): boolean {
  return ["provider", "timeout", "cancelled"].includes(result.failureKind);
}

function validatePublishedPullRequest(
  pullRequest: PublishedPullRequest,
  reservedUrl: string,
): string | null {
  if (pullRequest.state !== "open" || pullRequest.merged) {
    return "Spec publication recovered a closed or merged pull request.";
  }
  if (pullRequest.url.length > reservedUrl.length) {
    return "Spec pull-request URL exceeds the preflight reservation.";
  }
  return null;
}

function failedResult(event: WorkRequestData, reason: string) {
  return {
    outcome: "failed" as const,
    reason,
    issueId: event.issueId,
  };
}
