import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { errorMessage } from "./agent-invoke.ts";
import type {
  AgentApprovalPolicy,
  AgentProviderName,
  AgentProviderOptions,
  AgentReasoningEffort,
  AgentSandboxMode,
  Agent,
} from "./agents.ts";
import { buildRunId } from "./context.ts";
import {
  createFactoryRunContext,
  type FactoryRunContext,
  readFactoryWorkItemFile,
  type FactoryRunMeta,
} from "./factory-run-context.ts";
import { type FactoryWorkItem } from "./factory-schemas.ts";
import type { WorkflowEventSink } from "./workflow-events.ts";

export type FactoryInboxItem = {
  file: string;
  path: string;
  id?: string;
  source?: FactoryWorkItem["source"];
  title?: string;
  error?: string;
};

export type FactoryInboxFailedItem = {
  file: string;
  path: string;
  error?: string;
  errorPath?: string;
};

export type FactoryInboxStatus = {
  workspace: string;
  inboxDir: string;
  pendingCount: number;
  pending: FactoryInboxItem[];
  processedCount: number;
  failedCount: number;
  failed: FactoryInboxFailedItem[];
};

export type FactoryDispatchItemResult = {
  file: string;
  sourcePath: string;
  runId: string;
  runDir?: string;
  status: FactoryRunMeta["status"] | "failed";
  movedTo?: string;
  errorPath?: string;
  route?: FactoryRunMeta["route"];
  nextAction?: FactoryRunMeta["nextAction"];
  error?: string;
};

export type FactoryDispatchResult = {
  workspace: string;
  inboxDir: string;
  dryRun: boolean;
  // Snapshot of pending files before dispatch starts; aborts can leave work unprocessed.
  pendingCount: number;
  // In dry-run mode these are logical outcomes; inbox files are not moved.
  processedCount: number;
  failedCount: number;
  processed: FactoryDispatchItemResult[];
  failed: FactoryDispatchItemResult[];
};

export type FactoryDispatchOptions = {
  workspace: string;
  inboxDir?: string;
  runsDir?: string;
  agentProvider?: AgentProviderName;
  codexPathOverride?: string;
  model?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
  maxRuntimeMs: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  eventSink?: WorkflowEventSink;
  runFactoryTriage: (context: FactoryRunContext) => Promise<FactoryRunMeta>;
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
};

export function defaultFactoryInboxDir(workspace: string): string {
  return join(resolve(workspace), ".harness/inbox/factory");
}

export function factoryInboxStatus(input: {
  workspace: string;
  inboxDir?: string;
}): FactoryInboxStatus {
  const workspace = resolve(input.workspace);
  const inboxDir = resolveFactoryInboxDir(workspace, input.inboxDir);
  const pending = inboxJsonFiles(inboxDir).map(readStatusPendingItem);
  const failedDir = join(inboxDir, "failed");
  const failed = inboxJsonFiles(failedDir)
    .filter((file) => !file.name.endsWith(".error.json"))
    .map(readFailedItem);
  const processedCount = inboxJsonFiles(join(inboxDir, "processed")).length;

  return {
    workspace,
    inboxDir,
    pendingCount: pending.length,
    pending,
    processedCount,
    failedCount: failed.length,
    failed,
  };
}

export async function dispatchFactoryInbox(
  options: FactoryDispatchOptions,
): Promise<FactoryDispatchResult> {
  const workspace = resolve(options.workspace);
  const inboxDir = resolveFactoryInboxDir(workspace, options.inboxDir);
  const pendingFiles = inboxJsonFiles(inboxDir);
  const processed: FactoryDispatchItemResult[] = [];
  const failed: FactoryDispatchItemResult[] = [];

  for (const file of pendingFiles) {
    if (options.signal?.aborted) break;
    const itemPath = join(inboxDir, file.name);
    const result = await dispatchFactoryInboxItem({
      ...options,
      workspace,
      inboxDir,
      itemFile: file.name,
      itemPath,
    });
    if (result.status === "failed") {
      failed.push(result);
    } else {
      processed.push(result);
    }
  }

  return {
    workspace,
    inboxDir,
    dryRun: options.dryRun ?? false,
    pendingCount: pendingFiles.length,
    processedCount: processed.length,
    failedCount: failed.length,
    processed,
    failed,
  };
}

type InboxJsonFile = {
  name: string;
  path: string;
};

type DispatchItemOptions = FactoryDispatchOptions & {
  workspace: string;
  inboxDir: string;
  itemFile: string;
  itemPath: string;
};

async function dispatchFactoryInboxItem(
  options: DispatchItemOptions,
): Promise<FactoryDispatchItemResult> {
  let workItem: FactoryWorkItem;
  try {
    workItem = readFactoryWorkItemFile(options.itemPath);
  } catch (error) {
    const runId = buildRunId();
    return handleDispatchFailure({
      inboxDir: options.inboxDir,
      sourcePath: options.itemPath,
      file: options.itemFile,
      runId,
      dryRun: options.dryRun ?? false,
      error,
    });
  }

  let ctx: FactoryRunContext;
  try {
    ctx = createFactoryRunContext({
      workspace: options.workspace,
      runsDir: options.runsDir,
      workItem,
      agentProvider: options.agentProvider,
      codexPathOverride: options.codexPathOverride,
      model: options.model,
      sandboxMode: options.sandboxMode,
      approvalPolicy: options.approvalPolicy,
      modelReasoningEffort: options.modelReasoningEffort,
      maxRuntimeMs: options.maxRuntimeMs,
      dryRun: options.dryRun,
      signal: options.signal,
      eventSink: options.eventSink,
      agentProviderFactory: options.agentProviderFactory,
    });
  } catch (error) {
    const runId = buildRunId();
    return handleDispatchFailure({
      inboxDir: options.inboxDir,
      sourcePath: options.itemPath,
      file: options.itemFile,
      runId,
      dryRun: options.dryRun ?? false,
      error,
    });
  }

  const meta = await runTriageOrExportFailure(options, ctx);

  if (meta.status === "failed") {
    return handleDispatchFailure({
      inboxDir: options.inboxDir,
      sourcePath: options.itemPath,
      file: options.itemFile,
      runId: meta.runId,
      runDir: meta.runDir,
      dryRun: options.dryRun ?? false,
      error: meta.error ?? "factory triage failed",
    });
  }

  const movedTo = options.dryRun
    ? undefined
    : moveInboxItem({
        inboxDir: options.inboxDir,
        sourcePath: options.itemPath,
        targetDirName: "processed",
        runId: meta.runId,
        file: options.itemFile,
      });

  return {
    file: options.itemFile,
    sourcePath: options.itemPath,
    runId: meta.runId,
    runDir: meta.runDir,
    status: meta.status,
    ...(movedTo ? { movedTo } : {}),
    ...(meta.route ? { route: meta.route } : {}),
    ...(meta.nextAction ? { nextAction: meta.nextAction } : {}),
  };
}

function handleDispatchFailure(input: {
  inboxDir: string;
  sourcePath: string;
  file: string;
  runId: string;
  runDir?: string;
  dryRun: boolean;
  error: unknown;
}): FactoryDispatchItemResult {
  const error = errorMessage(input.error);
  let movedTo: string | undefined;
  let errorPath: string | undefined;

  if (!input.dryRun) {
    movedTo = moveInboxItem({
      inboxDir: input.inboxDir,
      sourcePath: input.sourcePath,
      targetDirName: "failed",
      runId: input.runId,
      file: input.file,
    });
    errorPath = failedErrorPath(movedTo);
    writeJson(errorPath, { file: input.file, runId: input.runId, error });
  }

  return {
    file: input.file,
    sourcePath: input.sourcePath,
    runId: input.runId,
    ...(input.runDir ? { runDir: input.runDir } : {}),
    status: "failed",
    ...(movedTo ? { movedTo } : {}),
    ...(errorPath ? { errorPath } : {}),
    error,
  };
}

function readStatusPendingItem(file: InboxJsonFile): FactoryInboxItem {
  try {
    const item = readFactoryWorkItemFile(file.path);
    return {
      file: file.name,
      path: file.path,
      id: item.id,
      source: item.source,
      title: item.title,
    };
  } catch (error) {
    return {
      file: file.name,
      path: file.path,
      error: errorMessage(error),
    };
  }
}

function readFailedItem(file: InboxJsonFile): FactoryInboxFailedItem {
  const errorPath = failedErrorPath(file.path);
  const hasErrorSummary = existsSync(errorPath);
  const error = hasErrorSummary ? readErrorSummary(errorPath) : undefined;
  return {
    file: file.name,
    path: file.path,
    ...(error ? { error } : {}),
    ...(hasErrorSummary ? { errorPath } : {}),
  };
}

async function runTriageOrExportFailure(
  options: DispatchItemOptions,
  ctx: FactoryRunContext,
): Promise<FactoryRunMeta> {
  try {
    return await options.runFactoryTriage(ctx);
  } catch (error) {
    return ctx.exportFailed(error);
  }
}

function inboxJsonFiles(dir: string): InboxJsonFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({
      name: entry.name,
      path: join(dir, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function moveInboxItem(input: {
  inboxDir: string;
  sourcePath: string;
  targetDirName: "processed" | "failed";
  runId: string;
  file: string;
}): string {
  const targetDir = join(input.inboxDir, input.targetDirName);
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, `${input.runId}-${basename(input.file)}`);
  renameSync(input.sourcePath, targetPath);
  return targetPath;
}

function failedErrorPath(failedItemPath: string): string {
  const extension = extname(failedItemPath);
  if (!extension) return `${failedItemPath}.error.json`;
  return `${failedItemPath.slice(0, -extension.length)}.error.json`;
}

function readErrorSummary(path: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const error = (parsed as { error?: unknown }).error;
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function resolveFactoryInboxDir(workspace: string, inboxDir?: string): string {
  if (!inboxDir) return defaultFactoryInboxDir(workspace);
  return isAbsolute(inboxDir) ? resolve(inboxDir) : resolve(workspace, inboxDir);
}
