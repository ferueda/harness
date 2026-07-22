import type { Inngest, InngestFunction } from "inngest";
import { z } from "zod";
import { AGENT_REASONING_EFFORTS, type Agent } from "./agents.ts";
import {
  TriageWorkRequestedEvent,
  workRequestEventId,
  type WorkRequestData,
} from "./inngest/work-events.ts";
import {
  classifyLinearReadiness,
  LinearReadinessConfigSchema,
  type LinearReadinessConfig,
} from "./linear-readiness.ts";
import type { LinearService } from "./linear/client.ts";
import { LinearError } from "./linear/error.ts";
import type {
  LinearCommentActor,
  LinearIssueContext,
  LinearIssueReference,
} from "./linear/read.ts";
import {
  triageIssue,
  type TriageExecution,
  type TriageIssueResult,
  type TriageProvenance,
} from "./triage/triage.ts";
import type {
  TriageDecision,
  TriageEvidence,
  TriageWorkItemContext,
  TriageWorkItemReference,
} from "./triage/schema.ts";

export const LINEAR_TRIAGE_FUNCTION_ID = "triage-linear-issue-v1";
export const LINEAR_TRIAGE_RETRIES = 3;
export const LINEAR_TRIAGE_LOAD_STEP_ID = "load-linear-triage-v1";
export const LINEAR_TRIAGE_AGENT_STEP_ID = "run-linear-triage-agent-v1";
export const LINEAR_TRIAGE_CONFIRM_STEP_ID = "confirm-linear-triage-v1";
export const LINEAR_TRIAGE_RESOLVE_STEP_ID = "resolve-linear-triage-relations-v1";
export const LINEAR_TRIAGE_COMMENT_STEP_ID = "project-linear-triage-comment-v1";
export const LINEAR_TRIAGE_RELATIONS_STEP_ID = "project-linear-triage-relations-v1";
export const LINEAR_TRIAGE_LABELS_STEP_ID = "project-linear-triage-labels-v1";
export const LINEAR_TRIAGE_STATE_STEP_ID = "project-linear-triage-state-v1";

export type LinearTriageService = Pick<
  LinearService,
  | "getIssueContext"
  | "ensureComment"
  | "ensureDuplicateRelation"
  | "ensureBlockedByRelation"
  | "updateIssueLabels"
  | "updateIssueState"
>;

export type LinearTriageFunctionConfig = Readonly<{
  readiness: LinearReadinessConfig;
  workspace: string;
  execution: TriageExecution;
}>;

type ObservedTriage =
  | Readonly<{ kind: "eligible"; context: LinearIssueContext }>
  | Readonly<{
      kind: "ineligible";
      reason: "issue-mismatch" | "incomplete-context" | "not-triage-ready" | "stale-snapshot";
    }>;

type ResolvedRelations = Readonly<{
  duplicateOfIssueId: string | null;
  blockerIssueIds: readonly string[];
}>;

const TriageExecutionSchema = z
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

const LinearTriageFunctionConfigSchema = z
  .object({
    readiness: LinearReadinessConfigSchema,
    workspace: z.string().trim().min(1),
    execution: TriageExecutionSchema,
  })
  .strict();

export function createLinearTriageFunction(input: {
  client: Inngest.Any;
  linear: LinearTriageService;
  agent: Agent;
  config: LinearTriageFunctionConfig;
}): InngestFunction.Any {
  const config = LinearTriageFunctionConfigSchema.parse(input.config);

  return input.client.createFunction(
    {
      id: LINEAR_TRIAGE_FUNCTION_ID,
      concurrency: { key: "event.data.issueId", limit: 1 },
      retries: LINEAR_TRIAGE_RETRIES,
      triggers: [TriageWorkRequestedEvent],
    },
    async ({ event, step }) => {
      const observed = await step.run(LINEAR_TRIAGE_LOAD_STEP_ID, () =>
        loadEligibleIssue(input.linear, event.data, config.readiness),
      );
      if (observed.kind === "ineligible") {
        return { outcome: "ignored" as const, reason: observed.reason };
      }

      const workItem = toTriageWorkItemContext(observed.context);
      const triage = await step.run(LINEAR_TRIAGE_AGENT_STEP_ID, async () => {
        const result = await triageIssue({
          workItem,
          agent: input.agent,
          workspace: config.workspace,
          execution: config.execution,
        });
        if (!result.ok && result.failureKind === "provider") {
          throw new Error(result.error);
        }
        return result;
      });
      if (!triage.ok) {
        return {
          outcome: "failed" as const,
          reason: triage.failureKind,
          issueId: event.data.issueId,
        };
      }

      const confirmed = await step.run(LINEAR_TRIAGE_CONFIRM_STEP_ID, () =>
        loadEligibleIssue(input.linear, event.data, config.readiness),
      );
      if (confirmed.kind === "ineligible") {
        return {
          outcome: "stale" as const,
          reason: confirmed.reason,
          issueId: event.data.issueId,
        };
      }

      const relations = await step.run(LINEAR_TRIAGE_RESOLVE_STEP_ID, () =>
        resolveRelations(input.linear, event.data.issueId, triage.decision),
      );
      const marker = triageCommentMarker(event.data);
      await step.run(LINEAR_TRIAGE_COMMENT_STEP_ID, () =>
        input.linear.ensureComment({
          issueId: event.data.issueId,
          marker,
          body: renderTriageComment(marker, triage),
        }),
      );

      if (triage.decision.decision === "duplicate") {
        await step.run(LINEAR_TRIAGE_LABELS_STEP_ID, () =>
          input.linear.updateIssueLabels({
            issueId: event.data.issueId,
            addLabelIds: [],
            removeLabelIds: Object.values(config.readiness.agentActionLabelIds),
          }),
        );
        await step.run(LINEAR_TRIAGE_RELATIONS_STEP_ID, () =>
          input.linear.ensureDuplicateRelation({
            issueId: event.data.issueId,
            duplicateOfIssueId: requiredDuplicateId(relations),
          }),
        );
        return {
          outcome: "projected" as const,
          decision: "duplicate" as const,
          issueId: event.data.issueId,
        };
      }

      await step.run(LINEAR_TRIAGE_RELATIONS_STEP_ID, () =>
        ensureBlockerRelations(input.linear, event.data.issueId, relations.blockerIssueIds),
      );

      if (triage.decision.decision === "needs-input") {
        await step.run(LINEAR_TRIAGE_LABELS_STEP_ID, () =>
          input.linear.updateIssueLabels({
            issueId: event.data.issueId,
            addLabelIds: [],
            removeLabelIds: Object.values(config.readiness.agentActionLabelIds),
          }),
        );
        await step.run(LINEAR_TRIAGE_STATE_STEP_ID, () =>
          input.linear.updateIssueState({
            issueId: event.data.issueId,
            expectedStateId: config.readiness.stateIds.backlog,
            stateId: config.readiness.stateIds.needsInput,
          }),
        );

        return {
          outcome: "projected" as const,
          decision: triage.decision.decision,
          agentAction: triage.decision.agentAction,
          issueId: event.data.issueId,
        };
      }

      const targetLabelId = decisionLabelId(triage.decision, config.readiness);
      await step.run(LINEAR_TRIAGE_LABELS_STEP_ID, () =>
        input.linear.updateIssueLabels({
          issueId: event.data.issueId,
          addLabelIds: [targetLabelId],
          removeLabelIds: Object.values(config.readiness.agentActionLabelIds).filter(
            (labelId) => labelId !== targetLabelId,
          ),
        }),
      );
      await step.run(LINEAR_TRIAGE_STATE_STEP_ID, () =>
        input.linear.updateIssueState({
          issueId: event.data.issueId,
          expectedStateId: config.readiness.stateIds.backlog,
          stateId: config.readiness.stateIds.open,
        }),
      );

      return {
        outcome: "projected" as const,
        decision: triage.decision.decision,
        agentAction: triage.decision.agentAction,
        issueId: event.data.issueId,
      };
    },
  );
}

async function loadEligibleIssue(
  linear: Pick<LinearTriageService, "getIssueContext">,
  event: WorkRequestData,
  config: LinearReadinessConfig,
): Promise<ObservedTriage> {
  const context = await linear.getIssueContext(event.issueId);
  if (context.id !== event.issueId || context.identifier !== event.issueIdentifier) {
    return { kind: "ineligible", reason: "issue-mismatch" };
  }
  if (
    context.completeness.commentsTruncated ||
    context.completeness.labelsTruncated ||
    context.completeness.relationsTruncated ||
    context.completeness.attachmentsTruncated ||
    context.completeness.childrenTruncated
  ) {
    return { kind: "ineligible", reason: "incomplete-context" };
  }
  const readiness = classifyLinearReadiness({ context, config });
  if (
    readiness.kind !== "dispatch" ||
    readiness.route !== "triage" ||
    readiness.reason !== "ready"
  ) {
    return { kind: "ineligible", reason: "not-triage-ready" };
  }
  if (readiness.snapshotGeneration !== event.snapshotGeneration) {
    return { kind: "ineligible", reason: "stale-snapshot" };
  }
  return { kind: "eligible", context };
}

function toTriageWorkItemContext(context: LinearIssueContext): TriageWorkItemContext {
  return {
    id: context.id,
    reference: context.identifier,
    title: context.title,
    description: context.description,
    url: context.url,
    state: context.state.name,
    labels: context.labels.map((label) => label.name),
    comments: context.comments.map((comment) => ({
      author: commentAuthor(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    parent: context.parent ? toWorkItemReference(context.parent) : null,
    children: context.children.map(toWorkItemReference),
    duplicateOf: context.duplicateOf ? toWorkItemReference(context.duplicateOf) : null,
    blockedBy: context.blockedBy.map(toWorkItemReference),
    related: context.related.map(toWorkItemReference),
    links: context.attachments.map((attachment) => ({
      title: attachment.title,
      url: attachment.url,
    })),
    createdAt: context.createdAt,
    updatedAt: context.updatedAt,
    completeness: {
      commentsTruncated: context.completeness.commentsTruncated,
      labelsTruncated: context.completeness.labelsTruncated,
      relationsTruncated: context.completeness.relationsTruncated,
      linksTruncated: context.completeness.attachmentsTruncated,
      childrenTruncated: context.completeness.childrenTruncated,
    },
  };
}

function toWorkItemReference(reference: LinearIssueReference): TriageWorkItemReference {
  return {
    id: reference.id,
    reference: reference.identifier,
    title: reference.title,
    url: reference.url,
    state: reference.state.name,
  };
}

function commentAuthor(author: LinearCommentActor): string | null {
  if (!author) return null;
  if (author.kind === "user") return author.displayName;
  if (author.kind === "bot") return author.name;
  return author.id;
}

async function resolveRelations(
  linear: Pick<LinearTriageService, "getIssueContext">,
  issueId: string,
  decision: TriageDecision,
): Promise<ResolvedRelations> {
  if (decision.decision === "duplicate") {
    const target = await resolveIssueReference(
      linear,
      issueId,
      requiredReference(decision.duplicateOf),
    );
    return { duplicateOfIssueId: target, blockerIssueIds: [] };
  }

  const blockerIssueIds: string[] = [];
  for (const reference of new Set(decision.blockedBy)) {
    const targetId = await resolveIssueReference(linear, issueId, reference);
    if (!blockerIssueIds.includes(targetId)) blockerIssueIds.push(targetId);
  }
  return {
    duplicateOfIssueId: null,
    blockerIssueIds: blockerIssueIds.toSorted(),
  };
}

async function resolveIssueReference(
  linear: Pick<LinearTriageService, "getIssueContext">,
  issueId: string,
  reference: string,
): Promise<string> {
  const normalizedReference = reference.trim();
  const context = await linear.getIssueContext(normalizedReference);
  if (context.id === issueId) {
    throw new LinearError("invalid-input", `Linear triage relation cannot reference ${issueId}.`);
  }
  if (
    normalizedReference !== context.id &&
    normalizedReference.toUpperCase() !== context.identifier.toUpperCase()
  ) {
    throw new LinearError(
      "invalid-response",
      `Linear resolved ${normalizedReference} as unexpected issue ${context.identifier}.`,
    );
  }
  return context.id;
}

async function ensureBlockerRelations(
  linear: Pick<LinearTriageService, "ensureBlockedByRelation">,
  issueId: string,
  blockerIssueIds: readonly string[],
): Promise<Readonly<{ blockerIssueIds: readonly string[] }>> {
  for (const blockerIssueId of blockerIssueIds) {
    await linear.ensureBlockedByRelation({ issueId, blockerIssueId });
  }
  return { blockerIssueIds };
}

function decisionLabelId(decision: TriageDecision, config: LinearReadinessConfig): string {
  if (decision.agentAction === "spec") return config.agentActionLabelIds.spec;
  if (decision.agentAction === "implement") return config.agentActionLabelIds.implement;
  throw new LinearError("invalid-response", "Ready-for-agent triage decision has no agent action.");
}

function requiredReference(reference: string | null): string {
  if (!reference) {
    throw new LinearError("invalid-response", "Duplicate triage decision has no target.");
  }
  return reference;
}

function requiredDuplicateId(relations: ResolvedRelations): string {
  if (!relations.duplicateOfIssueId) {
    throw new LinearError("invalid-response", "Resolved triage decision has no duplicate target.");
  }
  return relations.duplicateOfIssueId;
}

function triageCommentMarker(event: WorkRequestData): string {
  return `<!-- harness:linear-triage:${workRequestEventId("triage", event)} -->`;
}

function renderTriageComment(
  marker: string,
  triage: Extract<TriageIssueResult, { ok: true }>,
): string {
  const { decision, provenance } = triage;
  const sections = [
    marker,
    "## Agent triage",
    `**Decision:** ${decisionTitle(decision)}`,
    `**${rationaleTitle(decision)}:** ${decision.rationale}`,
    evidenceSection(decision.evidence),
  ];
  if (decision.questions.length > 0) {
    sections.push(
      `**Questions**\n${decision.questions.map((question) => `- ${question}`).join("\n")}`,
    );
  }
  if (decision.inputReason) sections.push(`**Input reason:** ${decision.inputReason}`);
  if (decision.duplicateOf) sections.push(`**Duplicate of:** ${decision.duplicateOf}`);
  if (decision.blockedBy.length > 0) {
    sections.push(`**Blocked by:** ${decision.blockedBy.join(", ")}`);
  }
  sections.push(provenanceSection(provenance));
  return sections.join("\n\n");
}

function decisionTitle(decision: TriageDecision): string {
  if (decision.decision === "duplicate") return "Duplicate";
  if (decision.decision === "needs-input") return "Needs input";
  return decision.agentAction === "spec" ? "Ready for agent — Spec" : "Ready for agent — Implement";
}

function rationaleTitle(decision: TriageDecision): string {
  if (decision.decision === "duplicate") return "Why Duplicate";
  if (decision.decision === "needs-input") return "Why Needs Input";
  return decision.agentAction === "spec" ? "Why Spec" : "Why Implement";
}

function evidenceSection(evidence: readonly TriageEvidence[]): string {
  const items = evidence.map((item) => {
    const location = item.path ? ` \`${item.path}\`` : "";
    return `- **${item.kind}**${location}: ${item.summary}`;
  });
  return `**Evidence**\n${items.join("\n")}`;
}

function provenanceSection(provenance: TriageProvenance): string {
  return [
    "**Execution:**",
    `${provenance.provider} / ${provenance.model} / ${provenance.modelReasoningEffort}`,
    `policy ${provenance.policyVersion}, schema ${provenance.decisionSchemaVersion}`,
  ].join(" ");
}
