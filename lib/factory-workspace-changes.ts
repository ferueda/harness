import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readWorkspaceStatus } from "./review-guard.ts";

const UNTRACKED_PATCH_FILE_CAP = 500;
const UNTRACKED_PATCH_BYTE_CAP = 5 * 1024 * 1024;
const UNTRACKED_CHANGED_FILES_CAP = 5_000;
const GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;

/** Test/diagnostic access to v1 untracked patch caps. */
export const FACTORY_UNTRACKED_PATCH_CAPS = {
  fileCap: UNTRACKED_PATCH_FILE_CAP,
  byteCap: UNTRACKED_PATCH_BYTE_CAP,
} as const;

export class FactoryWorkspaceChangesError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryWorkspaceChangesError";
  }
}

export type FactoryWorkspacePatchCapture = {
  porcelain: string;
  patch: string;
  patchSha256: string;
  changedFiles: string[];
  patchTruncated: boolean;
  truncatedUntrackedFileCount?: number;
};

export function captureFactoryWorkspaceChanges(input: {
  workspace: string;
}): FactoryWorkspacePatchCapture {
  const status = readWorkspaceStatus(input.workspace);
  if (!status.ok) {
    throw new FactoryWorkspaceChangesError(status.error.error);
  }
  return buildPatchCapture({
    workspace: input.workspace,
    porcelain: status.value,
  });
}

export function isEmptyPorcelainStatus(porcelain: string): boolean {
  return porcelain.length === 0;
}

export function buildPatchCapture(input: {
  workspace: string;
  porcelain: string;
  caps?: { fileCap?: number; byteCap?: number };
}): FactoryWorkspacePatchCapture {
  const fileCap = input.caps?.fileCap ?? UNTRACKED_PATCH_FILE_CAP;
  const byteCap = input.caps?.byteCap ?? UNTRACKED_PATCH_BYTE_CAP;
  const changes = collectChangedFiles({
    workspace: input.workspace,
    porcelain: input.porcelain,
    untrackedFileCap: Math.max(fileCap, UNTRACKED_CHANGED_FILES_CAP),
  });
  const untrackedFilesForPatch = changes.untrackedFiles.slice(0, fileCap);
  const skippedByPatchFileCap = changes.untrackedFiles.length - untrackedFilesForPatch.length;
  const initialTruncatedUntrackedFileCount =
    (changes.truncatedUntrackedFileCount ?? 0) + skippedByPatchFileCap;
  const { patch, patchTruncated, truncatedUntrackedFileCount } = buildPatchMaterial({
    workspace: input.workspace,
    porcelain: input.porcelain,
    untrackedFiles: untrackedFilesForPatch,
    fileCap,
    byteCap,
    initialTruncatedUntrackedFileCount:
      initialTruncatedUntrackedFileCount > 0 ? initialTruncatedUntrackedFileCount : undefined,
  });
  return {
    porcelain: input.porcelain,
    patch,
    patchSha256: sha256Hex(patch),
    changedFiles: changes.changedFiles,
    patchTruncated,
    ...(truncatedUntrackedFileCount !== undefined ? { truncatedUntrackedFileCount } : {}),
  };
}

type CollectedWorkspaceChanges = {
  changedFiles: string[];
  untrackedFiles: string[];
  truncatedUntrackedFileCount?: number;
};

function collectChangedFiles(input: {
  workspace: string;
  porcelain: string;
  untrackedFileCap?: number;
}): CollectedWorkspaceChanges {
  const files = new Set<string>();
  const untrackedFiles: string[] = [];
  const untrackedFileCap = input.untrackedFileCap ?? Number.POSITIVE_INFINITY;
  let truncatedUntrackedFileCount = 0;
  for (const record of parsePorcelainRecords(input.porcelain)) {
    if (record.kind === "rename" || record.kind === "copy") {
      addWorkspaceRelativePath(files, input.workspace, record.path);
      continue;
    }
    if (record.kind === "untracked-file") {
      const file = normalizeWorkspaceRelativePath(input.workspace, record.path);
      if (!file) continue;
      if (untrackedFiles.length >= untrackedFileCap) {
        truncatedUntrackedFileCount += 1;
        continue;
      }
      files.add(file);
      untrackedFiles.push(file);
      continue;
    }
    if (record.kind === "untracked-dir") {
      const result = enumerateUntrackedFiles(input.workspace, record.path, {
        limit: Math.max(untrackedFileCap - untrackedFiles.length, 0),
      });
      for (const file of result.files) {
        files.add(file);
        untrackedFiles.push(file);
      }
      truncatedUntrackedFileCount += result.truncatedFileCount;
      continue;
    }
    addWorkspaceRelativePath(files, input.workspace, record.path);
  }
  return {
    changedFiles: [...files].sort((a, b) => a.localeCompare(b)),
    untrackedFiles: untrackedFiles.sort((a, b) => a.localeCompare(b)),
    ...(truncatedUntrackedFileCount > 0 ? { truncatedUntrackedFileCount } : {}),
  };
}

type PorcelainRecord = {
  kind: "normal" | "untracked-file" | "untracked-dir" | "rename" | "copy";
  path: string;
};

function parsePorcelainRecords(porcelain: string): PorcelainRecord[] {
  if (porcelain.length === 0) return [];
  const parts = porcelain.split("\0");
  if (parts.at(-1) === "") parts.pop();

  const records: PorcelainRecord[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 3) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;

    if (xy === "??") {
      records.push({
        kind: path.endsWith("/") ? "untracked-dir" : "untracked-file",
        path: path.replace(/\/$/, ""),
      });
      continue;
    }

    const isRenameOrCopy = xy.includes("R") || xy.includes("C");
    if (isRenameOrCopy) {
      // Rename/copy records include an extra NUL-framed source path.
      i += 1;
      records.push({
        kind: xy.includes("R") ? "rename" : "copy",
        path,
      });
      continue;
    }

    records.push({ kind: "normal", path });
  }
  return records;
}

function buildPatchMaterial(input: {
  workspace: string;
  porcelain: string;
  untrackedFiles: string[];
  fileCap: number;
  byteCap: number;
  initialTruncatedUntrackedFileCount?: number;
}): {
  patch: string;
  patchTruncated: boolean;
  truncatedUntrackedFileCount?: number;
} {
  if (input.porcelain.length === 0) {
    return { patch: "", patchTruncated: false };
  }

  const unstaged = gitDiff(input.workspace, ["diff", "--binary", "--", ".", ":!.harness"]);
  const staged = gitDiff(input.workspace, [
    "diff",
    "--cached",
    "--binary",
    "--",
    ".",
    ":!.harness",
  ]);
  const trackedPatch = [unstaged, staged].filter((part) => part.length > 0).join("");

  let untrackedPatch = "";
  let appendedFiles = 0;
  let appendedBytes = 0;
  let patchTruncated = input.initialTruncatedUntrackedFileCount !== undefined;
  let truncatedUntrackedFileCount = input.initialTruncatedUntrackedFileCount ?? 0;

  for (const relativePath of input.untrackedFiles) {
    if (appendedFiles >= input.fileCap || appendedBytes >= input.byteCap) {
      patchTruncated = true;
      truncatedUntrackedFileCount += 1;
      continue;
    }
    const absolutePath = resolve(input.workspace, relativePath);
    const noIndexPatch = gitDiffNoIndex(input.workspace, absolutePath, input.byteCap);
    if (noIndexPatch === undefined) {
      patchTruncated = true;
      truncatedUntrackedFileCount += 1;
      continue;
    }
    if (appendedBytes + noIndexPatch.length > input.byteCap) {
      patchTruncated = true;
      truncatedUntrackedFileCount += 1;
      continue;
    }
    untrackedPatch += noIndexPatch;
    appendedFiles += 1;
    appendedBytes += noIndexPatch.length;
    if (appendedFiles >= input.fileCap || appendedBytes >= input.byteCap) {
      // Cap may land exactly on this file; remaining paths still count as truncated.
      const remaining = input.untrackedFiles.length - appendedFiles;
      if (remaining > 0) {
        patchTruncated = true;
        truncatedUntrackedFileCount += remaining;
      }
      break;
    }
  }

  return {
    patch: `${trackedPatch}${untrackedPatch}`,
    patchTruncated,
    ...(truncatedUntrackedFileCount > 0 ? { truncatedUntrackedFileCount } : {}),
  };
}

function enumerateUntrackedFiles(
  workspace: string,
  relativeDir: string,
  options: { limit?: number } = {},
): { files: string[]; truncatedFileCount: number } {
  const absoluteDir = resolve(workspace, relativeDir);
  const normalizedDir = normalizeWorkspaceRelativePath(workspace, relativeDir);
  if (!normalizedDir || !existsSync(absoluteDir)) return { files: [], truncatedFileCount: 0 };

  const files: string[] = [];
  const stack = [absoluteDir];
  let truncatedFileCount = 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      const relativeChild = relative(workspace, child);
      if (relativeChild === ".harness" || relativeChild.startsWith(`.harness${sep}`)) continue;
      if (!isPathInsideWorkspace(workspace, child)) continue;
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (entry.isFile()) {
        if (files.length >= limit) {
          truncatedFileCount += 1;
          stack.length = 0;
          break;
        }
        files.push(relativeChild.split(sep).join("/"));
      }
    }
  }
  return { files: files.sort((a, b) => a.localeCompare(b)), truncatedFileCount };
}

function gitDiff(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: GIT_DIFF_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new FactoryWorkspaceChangesError(`Failed to capture git diff: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function gitDiffNoIndex(
  workspace: string,
  absolutePath: string,
  byteCap: number,
): string | undefined {
  try {
    return execFileSync(
      "git",
      ["diff", "--binary", "--no-index", "--", "/dev/null", absolutePath],
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: byteCap + 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    // git diff --no-index exits 1 when it produced a diff.
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status?: number }).status === 1 &&
      "stdout" in error &&
      typeof (error as { stdout?: unknown }).stdout === "string"
    ) {
      return (error as { stdout: string }).stdout;
    }
    if (isMaxBufferError(error)) return undefined;
    throw new FactoryWorkspaceChangesError(
      `Failed to capture untracked file diff for ${absolutePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function isMaxBufferError(error: unknown): boolean {
  return error instanceof Error && /maxBuffer|ENOBUFS/i.test(error.message);
}

function addWorkspaceRelativePath(files: Set<string>, workspace: string, path: string): void {
  const normalized = normalizeWorkspaceRelativePath(workspace, path);
  if (normalized) files.add(normalized);
}

function normalizeWorkspaceRelativePath(workspace: string, path: string): string | undefined {
  const absolute = isAbsolute(path) ? path : resolve(workspace, path);
  if (!isPathInsideWorkspace(workspace, absolute)) return undefined;
  return relative(workspace, absolute).split(sep).join("/");
}

function isPathInsideWorkspace(workspace: string, absolutePath: string): boolean {
  const resolvedWorkspace = resolve(workspace);
  const resolvedPath = resolve(absolutePath);
  if (resolvedPath === resolvedWorkspace) return true;
  return resolvedPath.startsWith(`${resolvedWorkspace}${sep}`);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
