import { InvalidArgumentError, type Command } from "commander";
import {
  factoryExecutionProvenance,
  factoryLifecycleExecutionProvenance,
  resolveFactoryStore,
  type FactoryStoreMeta,
  type FactoryStoreResolution,
} from "../lib/factory-store.ts";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { readFactoryLifecycleEvents } from "../lib/factory-lifecycle.ts";
import {
  allocateFactoryRun,
  releaseEmptyFactoryRunReservation,
  writeFactoryRunReservation,
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
  resolveFactoryImplementationReviewLegacyInput,
  resolveFactoryImplementationReviewInput,
  type FactoryImplementationReviewInputError,
  type FactoryImplementationReviewLegacyInput,
} from "../lib/factory-implementation-review-input.ts";
import { appendImplementationReviewUnresolvedEvent } from "../lib/factory-lifecycle-writes.ts";
import {
  createFactoryImplementationReviewRunContext,
  type FactoryImplementationReviewLegacyRunMeta,
  type FactoryImplementationReviewRunContext,
  type FactoryImplementationReviewRunMeta,
} from "../lib/factory-implementation-review-run-context.ts";
import { run as runReview } from "../workflows/factory-implementation-review.workflow.ts";
import { factoryImplementationReviewCliOutput } from "./factory-implementation-review-cli.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";
import { errorMessage } from "../lib/agent-invoke.ts";

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
      try {
        const output = await runFactoryImplementationReviewCommand(options, config);
        console.log(JSON.stringify(factoryImplementationReviewCliOutput(output), null, 2));
        if (output.status !== "review-complete" && output.status !== "already-complete") {
          process.exitCode = 1;
        }
      } catch (error) {
        console.log(
          JSON.stringify(
            {
              workflow: "factory-implementation-review",
              status: "rejected",
              error: errorMessage(error),
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
      }
    });
}

export async function runFactoryImplementationReviewCommand(
  options: FactoryImplementationReviewOptions,
  config: FactoryImplementationReviewCommandConfig,
): Promise<FactoryImplementationReviewRunMeta | FactoryImplementationReviewLegacyRunMeta> {
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
  let allocation = allocateFactoryRun({
    factoryRunsDir: store.reviewRunsDir,
    idPrefix: "implementation-review",
  });
  writeReviewReservationManifest(allocation, store, options);
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
    writeReviewRejection(allocation, store, options, message);
    if (
      error &&
      typeof error === "object" &&
      "classification" in error &&
      (error as FactoryImplementationReviewInputError).classification === "legacy-incomplete"
    ) {
      const legacy = resolveFactoryImplementationReviewLegacyInput({
        workspace: store.workspace,
        ...(options.itemFile ? { itemFile: options.itemFile } : {}),
        ...(options.linearIssue ? { linearIssue: options.linearIssue } : {}),
        factoryStore: store,
      });
      return terminalizeLegacyReview(allocation, legacy);
    }
    throw error;
  }
  if (resolved.factoryStore.reviewRunsDir !== store.reviewRunsDir) {
    releaseEmptyFactoryRunReservation({
      runDir: allocation.runDir,
      factoryRunsDir: dirname(allocation.runDir),
      reservationToken: allocation.reservationToken,
    });
    allocation = allocateFactoryRun({
      factoryRunsDir: resolved.factoryStore.reviewRunsDir,
      idPrefix: "implementation-review",
    });
    writeReviewReservationManifest(allocation, resolved.factoryStore, options);
  }
  if (resolved.state.factoryStage === "review-complete") {
    releaseEmptyFactoryRunReservation({
      runDir: allocation.runDir,
      factoryRunsDir: dirname(allocation.runDir),
      reservationToken: allocation.reservationToken,
    });
    return existingCompletedResult(resolved);
  }
  const allowed = options.resume
    ? ["review-running", "review-failed"]
    : ["implementation-complete"];
  if (!allowed.includes(resolved.state.factoryStage ?? "")) {
    writeReviewRejection(
      allocation,
      resolved.factoryStore,
      options,
      `${options.resume ? "--resume" : "Initial review"} is not allowed from ${resolved.state.factoryStage ?? "uninitialized"}.`,
    );
    throw new Error(
      `${options.resume ? "--resume" : "Initial review"} is not allowed from ${resolved.state.factoryStage ?? "uninitialized"}.`,
    );
  }
  let settings: ReturnType<typeof resolveFactoryImplementationSettings>;
  try {
    settings = resolveFactoryImplementationSettings({
      workspace: store.workspace,
      ...(options.maxReviewIterations !== undefined
        ? { maxReviewIterations: options.maxReviewIterations }
        : {}),
    });
  } catch (error) {
    writeReviewRejection(
      allocation,
      resolved.factoryStore,
      options,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
  const effectiveReviewLimit = options.resume
    ? resolved.checkpoint.effectiveReviewLimit
    : { value: settings.maxReviewIterations, source: settings.source };
  if (
    options.resume &&
    (settings.maxReviewIterations !== resolved.checkpoint.effectiveReviewLimit.value ||
      settings.source !== resolved.checkpoint.effectiveReviewLimit.source)
  ) {
    writeReviewRejection(
      allocation,
      resolved.factoryStore,
      options,
      `Review limit provenance changed on resume: persisted ${JSON.stringify(resolved.checkpoint.effectiveReviewLimit)}, current ${JSON.stringify({ value: settings.maxReviewIterations, source: settings.source })}.`,
    );
    throw new Error(
      `Review limit provenance changed on resume: persisted ${JSON.stringify(resolved.checkpoint.effectiveReviewLimit)}, current ${JSON.stringify({ value: settings.maxReviewIterations, source: settings.source })}.`,
    );
  }
  let reviewerRole: ReturnType<typeof resolveFactoryImplementationReviewer>;
  let implementerRole: ReturnType<typeof resolveFactoryRoleAgent>;
  try {
    reviewerRole = resolveFactoryImplementationReviewer({ workspace: store.workspace });
    implementerRole = resolveFactoryRoleAgent({
      workspace: store.workspace,
      station: "implementation",
      role: "implementer",
    });
  } catch (error) {
    writeReviewRejection(
      allocation,
      resolved.factoryStore,
      options,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
  const checkpoint = {
    ...resolved.checkpoint,
    effectiveReviewLimit,
  };
  const reviewAbort = new AbortController();
  const onReviewAbort = () => reviewAbort.abort();
  process.once("SIGINT", onReviewAbort);
  process.once("SIGTERM", onReviewAbort);
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
    signal: reviewAbort.signal,
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
    ctx.writeSummary(
      `# Factory Implementation Review\n\n- Status: rejected\n- Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    throw error;
  } finally {
    process.off("SIGINT", onReviewAbort);
    process.off("SIGTERM", onReviewAbort);
  }
}

function writeReviewRejection(
  allocation: { runId: string; runDir: string; reservationToken: string },
  store: FactoryStoreResolution | FactoryStoreMeta,
  options: FactoryImplementationReviewOptions,
  message: string,
): void {
  const workspace = "workspace" in store ? store.workspace : store.projectRoot;
  writeFileSync(
    join(allocation.runDir, "summary.md"),
    `# Factory Implementation Review\n\n- Status: rejected\n- Error: ${message}\n`,
    "utf8",
  );
  writeFileSync(
    join(allocation.runDir, "attempt-rejected.json"),
    `${JSON.stringify(
      {
        status: "rejected",
        runId: allocation.runId,
        reservationToken: allocation.reservationToken,
        identity: options.linearIssue ?? options.itemFile,
        workspace,
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
        workspace,
        runDir: allocation.runDir,
        identity: options.linearIssue ?? options.itemFile,
        error: message,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeReviewReservationManifest(
  allocation: { runId: string; runDir: string; reservationToken: string },
  store: FactoryStoreResolution | FactoryStoreMeta,
  options: FactoryImplementationReviewOptions,
): void {
  writeFactoryRunReservation(allocation);
  const workspace = "workspace" in store ? store.workspace : store.projectRoot;
  const reservation = {
    station: "implementation-review",
    runId: allocation.runId,
    reservationToken: allocation.reservationToken,
    identity: options.linearIssue ?? options.itemFile,
    workspace,
    storeRoot: store.storeRoot,
    factoryProjectId: store.projectId,
    factoryStateRoot: store.factoryStateRoot,
    factoryRunsDir: store.factoryRunsDir,
    reviewRunsDir: store.reviewRunsDir,
  };
  writeFileSync(
    join(allocation.runDir, "implementation-review-reservation.json"),
    `${JSON.stringify(reservation, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function terminalizeLegacyReview(
  allocation: { runId: string; runDir: string; reservationToken: string },
  legacy: FactoryImplementationReviewLegacyInput,
): FactoryImplementationReviewLegacyRunMeta {
  const message = `Legacy implementation is incomplete; missing ${legacy.missing.join(", ")}.`;
  const summaryPath = join(allocation.runDir, "summary.md");
  writeFileSync(
    summaryPath,
    `# Factory Implementation Review\n\n- Status: ready-for-human\n- Reason: legacy-incomplete\n- Implementation run: ${legacy.implementationRunId}\n- Missing: ${legacy.missing.join(", ")}\n- Provider invocation: not run.\n`,
    "utf8",
  );
  writeFileSync(
    join(allocation.runDir, "attempt-rejected.json"),
    `${JSON.stringify(
      {
        status: "rejected",
        reason: "legacy-incomplete",
        runId: allocation.runId,
        reservationToken: allocation.reservationToken,
        implementationRunId: legacy.implementationRunId,
        missing: legacy.missing,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const summary = { root: "review" as const, runId: allocation.runId, path: "summary.md" };
  appendImplementationReviewUnresolvedEvent({
    workspace: legacy.workspace,
    workItem: legacy.workItem,
    runId: allocation.runId,
    owningImplementationRunId: legacy.implementationRunId,
    factoryStateRoot: legacy.factoryStore.factoryStateRoot,
    execution: factoryLifecycleExecutionProvenance(
      factoryExecutionProvenance(legacy.workspace, allocation.runDir),
      legacy.factoryStore,
    ),
    summary,
    reason: "legacy-incomplete",
  });
  const meta: FactoryImplementationReviewLegacyRunMeta = {
    runId: allocation.runId,
    workflow: "factory-implementation-review",
    status: "ready-for-human",
    legacyIncomplete: true,
    missing: legacy.missing,
    workspace: legacy.workspace,
    runDir: allocation.runDir,
    workItem: {
      id: legacy.workItem.id,
      source: legacy.workItem.source,
      title: legacy.workItem.title,
    },
    implementationRunId: legacy.implementationRunId,
    reviewerAgent: { agent: "codex", sandboxMode: "read-only", approvalPolicy: "never" },
    factoryStore: legacy.factoryStore,
    summaryPath,
    metaPath: join(allocation.runDir, "meta.json"),
    error: message,
    artifacts: { summary: "summary.md", rejection: "attempt-rejected.json" },
  };
  writeFileSync(meta.metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
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
  const runDir = join(
    input.checkpoint.runRoots[
      completed.data.handoff.root === "factory" ? "factoryRunsDir" : "reviewRunsDir"
    ],
    completed.data.handoff.runId,
  );
  return {
    runId: completed.data.handoff.runId,
    runDir,
    path,
  };
}
