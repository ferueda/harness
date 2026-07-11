import { InvalidArgumentError, type Command } from "commander";
import { resolveFactoryStore } from "../lib/factory-store.ts";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { readFactoryLifecycleEvents } from "../lib/factory-lifecycle.ts";
import {
  allocateFactoryRun,
  releaseEmptyFactoryRunReservation,
} from "../lib/factory-run-allocation.ts";
import {
  resolveFactoryImplementationReviewer,
  resolveFactoryImplementationSettings,
  resolveFactoryRoleAgent,
  parsePositiveIntegerOption,
} from "../lib/config.ts";
import { createAgentProvider } from "../providers/registry.ts";
import {
  resolveFactoryArtifactPointer,
  resolveFactoryImplementationReviewInput,
} from "../lib/factory-implementation-review-input.ts";
import {
  createFactoryImplementationReviewRunContext,
  type FactoryImplementationReviewRunContext,
  type FactoryImplementationReviewRunMeta,
} from "../lib/factory-implementation-review-run-context.ts";
import { run as runReview } from "../workflows/factory-implementation-review.workflow.ts";
import { factoryImplementationReviewCliOutput } from "./factory-implementation-review-cli.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";

export type FactoryImplementationReviewOptions = {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  resume: boolean;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
  maxReviewIterations?: number;
  maxRuntimeMs: number;
  verbose: boolean;
};

export type FactoryImplementationReviewCommandConfig = {
  defaultMaxRuntimeMs: number;
  positiveNumber: (value: string) => number;
  writeVerboseWorkflowEvent?: (event: WorkflowEvent) => void;
  implementationAgentProviderFactory?: typeof createAgentProvider;
  implementationReviewRunner?: (
    ctx: FactoryImplementationReviewRunContext,
  ) => Promise<FactoryImplementationReviewRunMeta>;
};

export function addFactoryImplementationReviewCommand(
  parent: Command,
  config: FactoryImplementationReviewCommandConfig,
): void {
  parent
    .command("review")
    .description("Review and remediate a completed Factory implementation")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier, e.g. TEAM-123")
    .option("--resume", "resume an interrupted or failed review attempt", false)
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option(
      "--max-review-iterations <count>",
      "maximum full review cycles (initial claim only)",
      parseReviewLimit,
    )
    .option(
      "--max-runtime-ms <ms>",
      `per-agent timeout (default: ${config.defaultMaxRuntimeMs})`,
      config.positiveNumber,
      config.defaultMaxRuntimeMs,
    )
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: FactoryImplementationReviewOptions) => {
      const output = await runFactoryImplementationReviewCommand(options, config);
      console.log(JSON.stringify(factoryImplementationReviewCliOutput(output), null, 2));
      if (output.status !== "review-complete" && output.status !== "already-complete") {
        process.exitCode = 1;
      }
    });
}

export async function runFactoryImplementationReviewCommand(
  options: FactoryImplementationReviewOptions,
  config: FactoryImplementationReviewCommandConfig,
): Promise<FactoryImplementationReviewRunMeta> {
  if (Boolean(options.itemFile) === Boolean(options.linearIssue)) {
    throw new Error("Exactly one of --item-file or --linear-issue is required.");
  }
  const workspace = options.workspace;
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: options.factoryStoreRoot,
    factoryStoreProjectId: options.factoryStoreProjectId,
    env: process.env,
  });
  const allocation = allocateFactoryRun({
    factoryRunsDir: store.reviewRunsDir,
    idPrefix: "implementation-review",
  });
  let resolved: ReturnType<typeof resolveFactoryImplementationReviewInput>;
  try {
    resolved = resolveFactoryImplementationReviewInput({
      workspace: store.workspace,
      ...(options.itemFile ? { itemFile: options.itemFile } : {}),
      ...(options.linearIssue ? { linearIssue: options.linearIssue } : {}),
      factoryStore: store,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(
      join(allocation.runDir, "summary.md"),
      `# Factory Implementation Review\n\n- Status: rejected\n- Error: ${message}\n`,
    );
    writeFileSync(
      join(allocation.runDir, "attempt-rejected.json"),
      `${JSON.stringify(
        {
          status: "rejected",
          runId: allocation.runId,
          identity: options.linearIssue ?? options.itemFile,
          workspace: store.workspace,
          factoryStore: store,
          error: message,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      join(allocation.runDir, "meta.json"),
      `${JSON.stringify(
        {
          runId: allocation.runId,
          workflow: "factory-implementation-review",
          status: "rejected",
          workspace: store.workspace,
          runDir: allocation.runDir,
          identity: options.linearIssue ?? options.itemFile,
          error: message,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    throw error;
  }
  if (resolved.state.factoryStage === "review-complete") {
    releaseEmptyFactoryRunReservation({
      runDir: allocation.runDir,
      factoryRunsDir: store.reviewRunsDir,
      reservationToken: allocation.reservationToken,
    });
    return existingCompletedResult(resolved);
  }
  const allowed = options.resume
    ? ["review-running", "review-failed"]
    : ["implementation-complete"];
  if (!allowed.includes(resolved.state.factoryStage ?? "")) {
    throw new Error(
      `${options.resume ? "--resume" : "Initial review"} is not allowed from ${resolved.state.factoryStage ?? "uninitialized"}.`,
    );
  }
  const settings = resolveFactoryImplementationSettings({
    workspace: store.workspace,
    ...(options.maxReviewIterations !== undefined
      ? { maxReviewIterations: options.maxReviewIterations }
      : {}),
  });
  const effectiveReviewLimit = options.resume
    ? resolved.checkpoint.effectiveReviewLimit
    : { value: settings.maxReviewIterations, source: settings.source };
  if (
    options.resume &&
    (options.maxReviewIterations !== undefined || settings.source === "config") &&
    settings.maxReviewIterations !== resolved.checkpoint.effectiveReviewLimit.value
  ) {
    throw new Error(
      `Review limit changed on resume: persisted ${resolved.checkpoint.effectiveReviewLimit.value}, requested ${settings.maxReviewIterations}.`,
    );
  }
  const reviewerRole = resolveFactoryImplementationReviewer({ workspace: store.workspace });
  const implementerRole = resolveFactoryRoleAgent({
    workspace: store.workspace,
    station: "implementation",
    role: "implementer",
  });
  const checkpoint = {
    ...resolved.checkpoint,
    effectiveReviewLimit,
  };
  const ctx = createFactoryImplementationReviewRunContext({
    allocation,
    workspace: store.workspace,
    workItem: resolved.workItem,
    implementationRunId: resolved.implementationRunId,
    originalReviewBase: checkpoint.originalReviewBase,
    approvedCandidate: checkpoint.approvedCandidate,
    checkpoint,
    factoryStore: resolved.factoryStore,
    reviewerRole,
    implementerRole,
    ...(resolved.approvedPlanPath ? { approvedPlanPath: resolved.approvedPlanPath } : {}),
    maxRuntimeMs: options.maxRuntimeMs,
    ...(options.verbose && config.writeVerboseWorkflowEvent
      ? { eventSink: config.writeVerboseWorkflowEvent }
      : {}),
    agentProviderFactory: config.implementationAgentProviderFactory ?? createAgentProvider,
  });
  ctx.writeReservation();
  try {
    const runner = config.implementationReviewRunner ?? runReview;
    return await runner(ctx);
  } catch (error) {
    ctx.writeArtifact("attempt-rejected.json", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function parseReviewLimit(value: string): number {
  try {
    return parsePositiveIntegerOption(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function existingCompletedResult(
  input: ReturnType<typeof resolveFactoryImplementationReviewInput>,
): FactoryImplementationReviewRunMeta {
  const handoff = findCompletedHandoff(input);
  const runDir = handoff?.runDir ?? input.implementationRunDir;
  return {
    runId: handoff?.runId ?? input.implementationRunId,
    workflow: "factory-implementation-review",
    status: "already-complete",
    workspace: input.workspace,
    runDir,
    workItem: { id: input.workItem.id, source: input.workItem.source, title: input.workItem.title },
    implementationRunId: input.implementationRunId,
    originalReviewBase: input.checkpoint.originalReviewBase,
    approvedCandidate: input.checkpoint.approvedCandidate,
    effectiveReviewLimit: input.checkpoint.effectiveReviewLimit,
    completedReviewCount: input.checkpoint.completedReviewCount,
    candidateVersion: input.checkpoint.candidateVersion,
    reviewerAgent: { agent: "codex", sandboxMode: "read-only", approvalPolicy: "never" },
    implementerSession: input.checkpoint.implementerSession,
    factoryStore: input.factoryStore,
    summaryPath: join(runDir, "summary.md"),
    metaPath: join(runDir, "meta.json"),
    ...(handoff ? { handoffPath: handoff.path } : {}),
    artifacts: {},
  };
}

function findCompletedHandoff(
  input: ReturnType<typeof resolveFactoryImplementationReviewInput>,
): { runId: string; runDir: string; path: string } | undefined {
  const events = readFactoryLifecycleEvents({
    factoryStateRoot: input.factoryStore.factoryStateRoot,
    workItemKey: input.workItemKey,
  });
  const completed = [...events]
    .reverse()
    .find((event) => event.type === "implementation.review.completed");
  if (!completed || completed.type !== "implementation.review.completed") return undefined;
  const path = resolveFactoryArtifactPointer({
    pointer: completed.data.handoff,
    runRoots: input.checkpoint.runRoots,
  });
  const runDir = dirname(path);
  return {
    runId: completed.data.handoff.runId,
    runDir,
    path,
  };
}
