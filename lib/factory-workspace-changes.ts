import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readWorkspaceStatus } from "./review-guard.ts";

const UNTRACKED_PATCH_FILE_CAP = 500;
const UNTRACKED_PATCH_BYTE_CAP = 5 * 1024 * 1024;

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

export type FactoryWorkspaceChangeSnapshot = {
  before: FactoryWorkspacePatchCapture;
  after: FactoryWorkspacePatchCapture;
  changed: boolean;
};

export function captureFactoryWorkspaceChanges(input: {
  workspace: string;
}): FactoryWorkspacePatchCapture {
  const status = readWorkspaceStatus(input.workspace);
  if (!status.ok) {
    const failure = status.error;
    throw new FactoryWorkspaceChangesError(
      failure.ok ? "Failed to inspect workspace status" : failure.error,
    );
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
}): FactoryWorkspacePatchCapture {
  const changedFiles = parsePorcelainChangedFiles(input.workspace, input.porcelain);
  const { patch, patchTruncated, truncatedUntrackedFileCount } = buildPatchMaterial({
    workspace: input.workspace,
    porcelain: input.porcelain,
    changedFiles,
  });
  return {
    porcelain: input.porcelain,
    patch,
    patchSha256: sha256Hex(patch),
    changedFiles,
    patchTruncated,
    ...(truncatedUntrackedFileCount !== undefined ? { truncatedUntrackedFileCount } : {}),
  };
}

export function parsePorcelainChangedFiles(workspace: string, porcelain: string): string[] {
  const files = new Set<string>();
  for (const record of parsePorcelainRecords(porcelain)) {
    if (record.kind === "rename" || record.kind === "copy") {
      addWorkspaceRelativePath(files, workspace, record.path);
      continue;
    }
    if (record.kind === "untracked-dir") {
      for (const file of enumerateUntrackedFiles(workspace, record.path)) {
        files.add(file);
      }
      continue;
    }
    addWorkspaceRelativePath(files, workspace, record.path);
  }
  return [...files].sort((a, b) => a.localeCompare(b));
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
  changedFiles: string[];
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

  const untrackedPaths = parsePorcelainRecords(input.porcelain)
    .filter((record) => record.kind === "untracked-file" || record.kind === "untracked-dir")
    .flatMap((record) =>
      record.kind === "untracked-dir"
        ? enumerateUntrackedFiles(input.workspace, record.path)
        : [normalizeWorkspaceRelativePath(input.workspace, record.path)].filter(
            (path): path is string => path !== undefined,
          ),
    );

  let untrackedPatch = "";
  let appendedFiles = 0;
  let appendedBytes = 0;
  let patchTruncated = false;
  let truncatedUntrackedFileCount = 0;

  for (const relativePath of untrackedPaths) {
    if (appendedFiles >= UNTRACKED_PATCH_FILE_CAP || appendedBytes >= UNTRACKED_PATCH_BYTE_CAP) {
      patchTruncated = true;
      truncatedUntrackedFileCount += 1;
      continue;
    }
    const absolutePath = resolve(input.workspace, relativePath);
    const noIndexPatch = gitDiffNoIndex(input.workspace, absolutePath);
    if (appendedBytes + noIndexPatch.length > UNTRACKED_PATCH_BYTE_CAP && appendedFiles > 0) {
      patchTruncated = true;
      truncatedUntrackedFileCount += 1;
      continue;
    }
    untrackedPatch += noIndexPatch;
    appendedFiles += 1;
    appendedBytes += noIndexPatch.length;
    if (appendedFiles >= UNTRACKED_PATCH_FILE_CAP || appendedBytes >= UNTRACKED_PATCH_BYTE_CAP) {
      // Cap may land exactly on this file; remaining paths still count as truncated.
      const remaining = untrackedPaths.length - appendedFiles;
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

function enumerateUntrackedFiles(workspace: string, relativeDir: string): string[] {
  const absoluteDir = resolve(workspace, relativeDir);
  const normalizedDir = normalizeWorkspaceRelativePath(workspace, relativeDir);
  if (!normalizedDir || !existsSync(absoluteDir)) return [];

  const files: string[] = [];
  const stack = [absoluteDir];
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
        files.push(relativeChild.split(sep).join("/"));
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function gitDiff(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new FactoryWorkspaceChangesError(`Failed to capture git diff: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function gitDiffNoIndex(workspace: string, absolutePath: string): string {
  try {
    return execFileSync(
      "git",
      ["diff", "--binary", "--no-index", "--", "/dev/null", absolutePath],
      {
        cwd: workspace,
        encoding: "utf8",
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
    throw new FactoryWorkspaceChangesError(
      `Failed to capture untracked file diff for ${absolutePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
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
