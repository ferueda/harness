import { InvalidArgumentError, type Command } from "commander";
import {
  factoryExecutionProvenance,
  factoryLifecycleExecutionProvenance,
  resolveFactoryStore,
  factoryStoreMetadata,
  type FactoryStoreMeta,
  type FactoryStoreResolution,
} from "../lib/factory-store.ts";
import { canonicalizeFactoryWorkspace } from "../lib/factory-locks.ts";
import { dirname, join } from "node:path";
import { deriveFactoryWorkItemKey, readFactoryLifecycleEvents } from "../lib/factory-lifecycle.ts";
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
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
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
  writeFactoryReviewRunFile,
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
  workspaceLeaseEnv?: NodeJS.ProcessEnv;
  implementationReviewRunner?: (
    ctx: FactoryImplementationReviewRunContext,
  ) => Promise<FactoryImplementationReviewRunMeta>;
};

export type FactoryImplementationReviewRejectedRunMeta = {
  runId: string;
  workflow: "factory-implementation-review";
  status: "rejected";
  workspace: string;
  runDir: string;
  implementationRunId?: string;
  factoryStore: FactoryStoreMeta;
  summaryPath: string;
  metaPath: string;
  error: string;
  artifacts: Record<string, string>;
};

class FactoryImplementationReviewCommandFailure extends Error {
  readonly output: FactoryImplementationReviewRejectedRunMeta;

  constructor(message: string, output: FactoryImplementationReviewRejectedRunMeta) {
    super(message);
    this.name = "FactoryImplementationReviewCommandFailure";
    this.output = output;
  }
}

function printRejectedReview(error: unknown): void {
  if (error instanceof FactoryImplementationReviewCommandFailure) {
    console.log(JSON.stringify(error.output, null, 2));
    return;
  }
  console.log(
    JSON.stringify(
      {
        workflow: "factory-implementation-review",
        status: "rejected",
        rejectedBeforeAllocation: true,
        error: errorMessage(error),
      },
      null,
      2,
    ),
  );
}

export function addFactoryImplementationReviewCommand(
  parent: Command,
  config: FactoryImplementationReviewCommandConfig,
): void {
  const review = parent
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
        printRejectedReview(error);
        process.exitCode = 1;
      }
    });
  review.exitOverride((error) => {
    if (error.exitCode !== 0) {
      printRejectedReview(error);
      process.exitCode = 1;
    }
    throw error;
  });
}

export async function runFactoryImplementationReviewCommand(
  options: FactoryImplementationReviewOptions,
  config: FactoryImplementationReviewCommandConfig,
): Promise<
  | FactoryImplementationReviewRunMeta
  | FactoryImplementationReviewLegacyRunMeta
  | FactoryImplementationReviewRejectedRunMeta
> {
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
  // Reject unsupported workspaces before creating durable review-run evidence.
  canonicalizeFactoryWorkspace(store.workspace);
  let rejectionStore: FactoryStoreResolution | FactoryStoreMeta = store;
  let rejectionWorkspace = store.workspace;
  let rejectionImplementationRunId: string | undefined;
  let allocation = allocateFactoryRun({
    factoryRunsDir: store.reviewRunsDir,
    idPrefix: "implementation-review",
  });
  try {
    try {
      writeFactoryRunReservation(allocation);
    } catch (error) {
      releaseEmptyFactoryRunReservation({
        runDir: allocation.runDir,
        factoryRunsDir: dirname(allocation.runDir),
        reservationToken: allocation.reservationToken,
      });
      throw error;
    }
    let resolved: ReturnType<typeof resolveFactoryImplementationReviewInput>;
    try {
      resolved = resolveFactoryImplementationReviewInput({
        workspace: store.workspace,
        ...(options.itemFile ? { itemFile: options.itemFile } : {}),
        ...(options.linearIssue ? { linearIssue: options.linearIssue } : {}),
        factoryStore: store,
      });
      rejectionStore = resolved.factoryStore;
      rejectionWorkspace = resolved.workspace;
      rejectionImplementationRunId = resolved.implementationRunId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejected = writeReviewRejection(allocation, store, options, store.workspace, message);
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
      return rejected;
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
      rejectionStore = resolved.factoryStore;
      try {
        writeFactoryRunReservation(allocation);
      } catch (error) {
        releaseEmptyFactoryRunReservation({
          runDir: allocation.runDir,
          factoryRunsDir: dirname(allocation.runDir),
          reservationToken: allocation.reservationToken,
        });
        throw error;
      }
    }
    try {
      writeReviewReservationManifest(allocation, resolved.factoryStore, options, {
        workItem: resolved.workItem,
        workspace: resolved.workspace,
        physicalWorkspace: resolved.checkpoint.workspace.physicalGitRoot,
        workspaceKey: resolved.checkpoint.workspace.workspaceKey,
      });
    } catch (error) {
      releaseEmptyFactoryRunReservation({
        runDir: allocation.runDir,
        factoryRunsDir: dirname(allocation.runDir),
        reservationToken: allocation.reservationToken,
      });
      throw error;
    }
    if (resolved.state.factoryStage === "review-complete") {
      writeReviewIdempotentMarker(
        allocation,
        resolved.factoryStore,
        options,
        store.workspace,
        resolved,
      );
      return existingCompletedResult(resolved);
    }
    const allowed = options.resume
      ? ["review-running", "review-failed"]
      : ["implementation-complete"];
    if (!allowed.includes(resolved.state.factoryStage ?? "")) {
      return writeReviewRejection(
        allocation,
        resolved.factoryStore,
        options,
        store.workspace,
        `${options.resume ? "--resume" : "Initial review"} is not allowed from ${resolved.state.factoryStage ?? "uninitialized"}.`,
        resolved.implementationRunId,
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
      return writeReviewRejection(
        allocation,
        resolved.factoryStore,
        options,
        store.workspace,
        error instanceof Error ? error.message : String(error),
        resolved.implementationRunId,
      );
    }
    const effectiveReviewLimit = options.resume
      ? resolved.checkpoint.effectiveReviewLimit
      : { value: settings.maxReviewIterations, source: settings.source };
    if (
      options.resume &&
      (settings.maxReviewIterations !== resolved.checkpoint.effectiveReviewLimit.value ||
        settings.source !== resolved.checkpoint.effectiveReviewLimit.source)
    ) {
      return writeReviewRejection(
        allocation,
        resolved.factoryStore,
        options,
        store.workspace,
        `Review limit provenance changed on resume: persisted ${JSON.stringify(resolved.checkpoint.effectiveReviewLimit)}, current ${JSON.stringify({ value: settings.maxReviewIterations, source: settings.source })}.`,
        resolved.implementationRunId,
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
      return writeReviewRejection(
        allocation,
        resolved.factoryStore,
        options,
        store.workspace,
        error instanceof Error ? error.message : String(error),
        resolved.implementationRunId,
      );
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
      ...(config.workspaceLeaseEnv ? { workspaceLeaseEnv: config.workspaceLeaseEnv } : {}),
      signal: reviewAbort.signal,
      ...(options.verbose && config.writeVerboseWorkflowEvent
        ? { eventSink: config.writeVerboseWorkflowEvent }
        : {}),
      agentProviderFactory: config.implementationAgentProviderFactory ?? createAgentProvider,
    });
    try {
      ctx.writeReservation();
    } catch (error) {
      return writeReviewRejection(
        allocation,
        resolved.factoryStore,
        options,
        resolved.workspace,
        errorMessage(error),
        resolved.implementationRunId,
      );
    }
    try {
      const runner = config.implementationReviewRunner ?? runReview;
      return await runner(ctx);
    } catch (error) {
      return writeReviewRejection(
        allocation,
        resolved.factoryStore,
        options,
        resolved.workspace,
        errorMessage(error),
        resolved.implementationRunId,
      );
    } finally {
      process.off("SIGINT", onReviewAbort);
      process.off("SIGTERM", onReviewAbort);
    }
  } catch (error) {
    try {
      return writeReviewRejection(
        allocation,
        rejectionStore,
        options,
        rejectionWorkspace,
        errorMessage(error),
        rejectionImplementationRunId,
      );
    } catch (rejectionError) {
      throw new FactoryImplementationReviewCommandFailure(
        `${errorMessage(error)}; durable rejection projection failed: ${errorMessage(rejectionError)}`,
        buildRejectedRunMeta(
          allocation,
          rejectionStore,
          rejectionWorkspace,
          options,
          rejectionImplementationRunId,
          errorMessage(error),
        ),
      );
    }
  }
}

function writeReviewRejection(
  allocation: { runId: string; runDir: string; reservationToken: string },
  store: FactoryStoreResolution | FactoryStoreMeta,
  options: FactoryImplementationReviewOptions,
  workspace: string,
  message: string,
  implementationRunId?: string,
): FactoryImplementationReviewRejectedRunMeta {
  const rejected = buildRejectedRunMeta(
    allocation,
    store,
    workspace,
    options,
    implementationRunId,
    message,
  );
  const factoryStore = "workspace" in store ? factoryStoreMetadata(store) : store;
  writeFactoryReviewRunFile({
    runDir: allocation.runDir,
    relativePath: "summary.md",
    value: `# Factory Implementation Review\n\n- Status: rejected\n- Error: ${message}\n`,
  });
  writeFactoryReviewRunFile({
    runDir: allocation.runDir,
    relativePath: "attempt-rejected.json",
    value: `${JSON.stringify(
      {
        status: "rejected",
        runId: allocation.runId,
        reservationToken: allocation.reservationToken,
        identity: options.linearIssue ?? options.itemFile,
        workspace,
        ...(implementationRunId ? { implementationRunId } : {}),
        factoryStore,
        error: message,
      },
      null,
      2,
    )}\n`,
  });
  writeFactoryReviewRunFile({
    runDir: allocation.runDir,
    relativePath: "meta.json",
    value: `${JSON.stringify(
      {
        runId: allocation.runId,
        workflow: "factory-implementation-review",
        status: "rejected",
        workspace,
        runDir: allocation.runDir,
        identity: options.linearIssue ?? options.itemFile,
        ...(implementationRunId ? { implementationRunId } : {}),
        factoryStore,
        error: message,
      },
      null,
      2,
    )}\n`,
  });
  return rejected;
}

function buildRejectedRunMeta(
  allocation: { runId: string; runDir: string },
  store: FactoryStoreResolution | FactoryStoreMeta,
  workspace: string,
  _options: FactoryImplementationReviewOptions,
  implementationRunId: string | undefined,
  message: string,
): FactoryImplementationReviewRejectedRunMeta {
  const factoryStore = "workspace" in store ? factoryStoreMetadata(store) : store;
  return {
    runId: allocation.runId,
    workflow: "factory-implementation-review",
    status: "rejected",
    workspace,
    runDir: allocation.runDir,
    ...(implementationRunId ? { implementationRunId } : {}),
    factoryStore,
    summaryPath: join(allocation.runDir, "summary.md"),
    metaPath: join(allocation.runDir, "meta.json"),
    error: message,
    artifacts: { summary: "summary.md", rejection: "attempt-rejected.json", meta: "meta.json" },
  };
}

function writeReviewIdempotentMarker(
  allocation: { runId: string; runDir: string; reservationToken: string },
  store: FactoryStoreResolution | FactoryStoreMeta,
  options: FactoryImplementationReviewOptions,
  workspace: string,
  resolved: ReturnType<typeof resolveFactoryImplementationReviewInput>,
): void {
  writeFactoryReviewRunFile({
    runDir: allocation.runDir,
    relativePath: "attempt-idempotent.json",
    value: `${JSON.stringify(
      {
        status: "already-complete",
        workflow: "factory-implementation-review",
        station: "implementation-review",
        runId: allocation.runId,
        reservationToken: allocation.reservationToken,
        terminalRunId: resolved.implementationRunId,
        terminalRunDir: resolved.implementationRunDir,
        identity: options.linearIssue ?? options.itemFile,
        workspace,
        factoryStore: store,
        lifecycleStage: resolved.state.factoryStage,
      },
      null,
      2,
    )}\n`,
  });
}

function writeReviewReservationManifest(
  allocation: { runId: string; runDir: string; reservationToken: string },
  store: FactoryStoreResolution | FactoryStoreMeta,
  options: FactoryImplementationReviewOptions,
  provenance: {
    workItem: FactoryWorkItem;
    workspace: string;
    physicalWorkspace: string;
    workspaceKey: string;
  },
): void {
  const reservation = {
    station: "implementation-review",
    workItemKey: deriveFactoryWorkItemKey(provenance.workItem),
    runId: allocation.runId,
    reservationToken: allocation.reservationToken,
    identity: options.linearIssue ?? options.itemFile,
    workspace: provenance.workspace,
    physicalWorkspace: provenance.physicalWorkspace,
    workspaceKey: provenance.workspaceKey,
    storeRoot: store.storeRoot,
    factoryProjectId: store.projectId,
    factoryStateRoot: store.factoryStateRoot,
    factoryRunsDir: store.factoryRunsDir,
    reviewRunsDir: store.reviewRunsDir,
  };
  writeFactoryReviewRunFile({
    runDir: allocation.runDir,
    relativePath: "implementation-review-reservation.json",
    value: `${JSON.stringify(reservation, null, 2)}\n`,
    flag: "wx",
  });
}

function terminalizeLegacyReview(
  allocation: { runId: string; runDir: string; reservationToken: string },
  legacy: FactoryImplementationReviewLegacyInput,
): FactoryImplementationReviewLegacyRunMeta {
  const message = `Legacy implementation is incomplete; missing ${legacy.missing.join(", ")}.`;
  const summaryPath = join(allocation.runDir, "summary.md");
  writeFactoryReviewRunFile({
    runDir: allocation.runDir,
    relativePath: "summary.md",
    value: `# Factory Implementation Review\n\n- Status: ready-for-human\n- Reason: legacy-incomplete\n- Implementation run: ${legacy.implementationRunId}\n- Missing: ${legacy.missing.join(", ")}\n- Provider invocation: not run.\n`,
  });
  writeFactoryReviewRunFile({
    runDir: allocation.runDir,
    relativePath: "attempt-rejected.json",
    value: `${JSON.stringify(
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
  });
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
  writeFactoryReviewRunFile({
    runDir: allocation.runDir,
    relativePath: "meta.json",
    value: `${JSON.stringify(meta, null, 2)}\n`,
  });
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
