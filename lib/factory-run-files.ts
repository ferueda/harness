import { appendFileSync, lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";

export function ensureFactoryRunDirectory(runDir: string): string {
  const target = resolve(runDir);
  const parsed = parse(target);
  let current = parsed.root;
  for (const segment of relative(parsed.root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    ensureDirectory(current, true);
  }
  return target;
}

export function assertFactoryRunDirectory(runDir: string): string {
  const target = resolve(runDir);
  const parsed = parse(target);
  let current = parsed.root;
  for (const segment of relative(parsed.root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    ensureDirectory(current, false);
  }
  return target;
}

export function factoryRunFilePath(runDir: string, relativePath: string): string {
  const root = assertFactoryRunDirectory(runDir);
  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Factory run artifact path escapes run directory: ${relativePath}`);
  }
  let current = root;
  for (const segment of normalized.split("/")) {
    current = join(current, segment);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() && !isTrustedSystemSymlink(current)) {
        throw new Error(`Factory run artifact path is symlinked: ${current}`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return current;
}

export function writeFactoryRunFile(input: {
  runDir: string;
  relativePath: string;
  value: string;
  flag?: "w" | "wx";
}): string {
  const path = factoryRunFilePath(input.runDir, input.relativePath);
  ensureFactoryRunDirectory(join(path, ".."));
  writeFileSync(path, input.value, input.flag ? { encoding: "utf8", flag: input.flag } : "utf8");
  return path;
}

export function appendFactoryRunFile(input: {
  runDir: string;
  relativePath: string;
  value: string;
}): string {
  const path = factoryRunFilePath(input.runDir, input.relativePath);
  ensureFactoryRunDirectory(join(path, ".."));
  appendFileSync(path, input.value, "utf8");
  return path;
}

function ensureDirectory(path: string, create: boolean): void {
  try {
    const entry = lstatSync(path);
    if (!isSafeDirectoryEntry(path, entry)) {
      throw new Error(`Factory run directory is symlinked or not a directory: ${path}`);
    }
  } catch (error) {
    if (!create || !(isNodeError(error) && error.code === "ENOENT")) throw error;
    mkdirSync(path, { mode: 0o700 });
    const entry = lstatSync(path);
    if (!isSafeDirectoryEntry(path, entry)) {
      throw new Error(`Factory run directory is symlinked or not a directory: ${path}`);
    }
  }
}

function isTrustedSystemSymlink(path: string): boolean {
  return process.platform === "darwin" && (path === "/var" || path === "/tmp");
}

function isSafeDirectoryEntry(path: string, entry: ReturnType<typeof lstatSync>): boolean {
  if (!entry) return false;
  if (entry.isDirectory()) return true;
  return entry.isSymbolicLink() && isTrustedSystemSymlink(path) && statSync(path).isDirectory();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
