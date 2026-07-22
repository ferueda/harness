import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProviderName, AgentRunResult } from "../agent/contract.ts";
import type { AgentStreamFormat, AgentStreamLogSummary } from "../agent/stream-log.ts";
import {
  renderFailedSummary,
  renderSummary,
  type FailedReview,
  type ReviewSection,
  type ReviewVerdict,
  type WorkflowStepMetadata,
} from "./aggregate.ts";
import { WORKFLOW_EVENTS_FILE } from "./events.ts";
import type { GitScope } from "./run-context.ts";

export type ReviewRunScope = GitScope & {
  baseRef: string;
  headRef: string;
};

export type PromptArtifacts = Partial<Record<string, string>>;

export type StreamArtifact = {
  path: string;
  status: AgentStreamLogSummary["status"];
  provider: AgentProviderName;
  format: AgentStreamFormat;
  bytes?: number;
  error?: string;
  agentMessageCount?: number;
  finalAgentMessageId?: string;
};

export type StreamArtifacts = Partial<Record<string, StreamArtifact>>;

type FinalizeRunInput =
  | {
      status: "completed";
      title: string;
      reviews: ReviewSection[];
      verdict: ReviewVerdict;
      steps?: WorkflowStepMetadata;
    }
  | {
      status: "failed";
      title: string;
      reviews: ReviewSection[];
      failedReviews: FailedReview[];
      steps?: WorkflowStepMetadata;
    };

type ReviewSummary = ReturnType<typeof summarizeReview>;
type ReviewSummaries = Record<string, ReviewSummary>;

export function buildScopeMeta(scope: ReviewRunScope) {
  return {
    baseRef: scope.baseRef,
    headRef: scope.headRef,
    mergeBase: scope.mergeBase,
    headSha: scope.headSha,
    headBranch: scope.headBranch,
    diffChars: scope.diff.length,
    diffLines: scope.diff ? scope.diff.split("\n").length : 0,
  };
}

export function createRunReportWriter(input: {
  runId: string;
  runDir: string;
  workspace: string;
  startedAt: Date;
  agentMeta: Readonly<Record<string, unknown>>;
  scope?: ReviewRunScope;
  scopeMeta?: ReturnType<typeof buildScopeMeta>;
  promptPaths: PromptArtifacts;
  streamArtifacts: StreamArtifacts;
}) {
  return {
    writeDryRun(steps?: WorkflowStepMetadata) {
      const meta = {
        runId: input.runId,
        status: "dry_run",
        workspace: input.workspace,
        runDir: input.runDir,
        agent: input.agentMeta,
        ...(input.scopeMeta ? { scope: input.scopeMeta } : {}),
        ...steps,
        prompts: input.promptPaths,
      };
      writeJson(join(input.runDir, "meta.json"), meta);
      return meta;
    },
    finalize(finalizeInput: FinalizeRunInput) {
      const durationMs = Date.now() - input.startedAt.getTime();
      const startedAtIso = input.startedAt.toISOString();
      const summary =
        finalizeInput.status === "completed"
          ? renderSummary({
              title: finalizeInput.title,
              runId: input.runId,
              workspace: input.workspace,
              scope: input.scope,
              reviews: finalizeInput.reviews,
              verdict: finalizeInput.verdict,
              startedAt: startedAtIso,
              durationMs,
              steps: finalizeInput.steps,
            })
          : renderFailedSummary({
              title: finalizeInput.title,
              runId: input.runId,
              workspace: input.workspace,
              scope: input.scope,
              reviews: finalizeInput.reviews,
              failedReviews: finalizeInput.failedReviews,
              startedAt: startedAtIso,
              durationMs,
              steps: finalizeInput.steps,
            });
      writeFileSync(join(input.runDir, "summary.md"), summary, "utf8");

      const reviewSummaries = buildReviewSummaries(finalizeInput.reviews);
      const baseMeta = {
        runId: input.runId,
        workspace: input.workspace,
        agent: input.agentMeta,
        ...(input.scopeMeta ? { scope: input.scopeMeta } : {}),
        startedAt: startedAtIso,
        durationMs,
        ...finalizeInput.steps,
        ...buildTopLevelReviewFields(reviewSummaries),
        reviews: reviewSummaries,
        ...buildStreamArtifactsMeta(input.streamArtifacts),
        eventsFile: WORKFLOW_EVENTS_FILE,
      };
      const meta =
        finalizeInput.status === "completed"
          ? { ...baseMeta, status: "completed", verdict: finalizeInput.verdict }
          : {
              ...baseMeta,
              status: "failed",
              failedReviews: finalizeInput.failedReviews,
            };
      writeJson(join(input.runDir, "meta.json"), meta);
      return meta;
    },
  };
}

export function recordStreamArtifact(
  artifacts: StreamArtifacts,
  stage: string,
  path: string,
  provider: AgentProviderName,
  result: AgentRunResult | undefined,
): void {
  const streamLog = extractStreamLog(result?.raw);
  const stat = fileStat(path);
  const bytes = stat?.size;
  const status = streamLog?.status ?? (bytes && bytes > 0 ? "written" : "missing");

  artifacts[stage] = {
    path,
    status,
    provider: streamLog?.provider ?? provider,
    format: streamLog?.format ?? streamFormatForProvider(provider),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(streamLog?.error ? { error: streamLog.error } : {}),
    ...(streamLog?.agentMessageCount !== undefined
      ? { agentMessageCount: streamLog.agentMessageCount }
      : {}),
    ...(streamLog?.finalAgentMessageId
      ? { finalAgentMessageId: streamLog.finalAgentMessageId }
      : {}),
  };
}

export function cleanupOrphanedRunDir(runDir: string): boolean {
  if (existsSync(join(runDir, "meta.json"))) return false;
  rmSync(runDir, { recursive: true, force: true });
  return true;
}

function summarizeReview(review: ReviewSection["review"]): {
  verdict: ReviewSection["review"]["verdict"];
  findingCount: number;
} {
  return {
    verdict: review?.verdict,
    findingCount: review?.findings?.length ?? 0,
  };
}

function buildReviewSummaries(reviews: ReviewSection[]): ReviewSummaries {
  return Object.fromEntries(reviews.map(({ key, review }) => [key, summarizeReview(review)]));
}

function buildTopLevelReviewFields(reviewSummaries: ReviewSummaries): {
  implementationReview?: ReviewSummary;
  qualityReview?: ReviewSummary;
  specReview?: ReviewSummary;
} {
  const fields: {
    implementationReview?: ReviewSummary;
    qualityReview?: ReviewSummary;
    specReview?: ReviewSummary;
  } = {};
  const fieldNames = {
    implementation: "implementationReview",
    codeQuality: "qualityReview",
    spec: "specReview",
  } as const;

  for (const [key, fieldName] of Object.entries(fieldNames)) {
    const summary = reviewSummaries[key];
    if (summary) fields[fieldName] = summary;
  }
  return fields;
}

function extractStreamLog(raw: unknown): AgentStreamLogSummary | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const streamLog = (raw as { streamLog?: unknown }).streamLog;
  if (!streamLog || typeof streamLog !== "object" || Array.isArray(streamLog)) return undefined;

  const candidate = streamLog as Partial<AgentStreamLogSummary>;
  if (
    typeof candidate.path !== "string" ||
    !isStreamStatus(candidate.status) ||
    (candidate.provider !== "cursor" && candidate.provider !== "codex") ||
    (candidate.format !== "cursor-sdk-message" && candidate.format !== "codex-thread-event")
  ) {
    return undefined;
  }
  return candidate as AgentStreamLogSummary;
}

function isStreamStatus(status: unknown): status is AgentStreamLogSummary["status"] {
  return (
    status === "written" || status === "missing" || status === "unsupported" || status === "error"
  );
}

function streamFormatForProvider(provider: AgentProviderName): AgentStreamFormat {
  return provider === "codex" ? "codex-thread-event" : "cursor-sdk-message";
}

function fileStat(path: string): { size: number } | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function buildStreamArtifactsMeta(artifacts: StreamArtifacts): {
  streamArtifacts?: StreamArtifacts;
} {
  return Object.keys(artifacts).length > 0 ? { streamArtifacts: artifacts } : {};
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
