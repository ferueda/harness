import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { errorMessage } from "./agent-invoke.ts";
import { readFactoryWorkItemFile } from "./factory-run-context.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";

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

type InboxJsonFile = {
  name: string;
  path: string;
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

function resolveFactoryInboxDir(workspace: string, inboxDir?: string): string {
  if (!inboxDir) return defaultFactoryInboxDir(workspace);
  return isAbsolute(inboxDir) ? resolve(inboxDir) : resolve(workspace, inboxDir);
}
