import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export type FactoryWriterBoundarySnapshot = {
  workspace: string;
  refs: Record<string, string>;
  head: string;
  index: string;
  harness: string;
  lifecycle: string;
  factoryStore: string;
  allowedPaths: string[];
};

export class FactoryWriterBoundaryError extends Error {
  readonly changedSurfaces: readonly string[];
  readonly before: FactoryWriterBoundarySnapshot;
  readonly after: FactoryWriterBoundarySnapshot;

  constructor(
    changedSurfaces: readonly string[],
    before: FactoryWriterBoundarySnapshot,
    after: FactoryWriterBoundarySnapshot,
  ) {
    super(`Factory writer boundary violation: ${changedSurfaces.join(", ")}`);
    this.name = "FactoryWriterBoundaryError";
    this.changedSurfaces = changedSurfaces;
    this.before = before;
    this.after = after;
  }
}

export type FactoryWriterBoundaryInput = {
  workspace: string;
  lifecycleRoot?: string;
  factoryStoreRoot?: string;
  durablePaths?: readonly string[];
  allowedPaths?: readonly string[];
};

export function captureFactoryWriterBoundary(
  input: FactoryWriterBoundaryInput,
): FactoryWriterBoundarySnapshot {
  const workspace = resolve(input.workspace);
  const allowedPaths = (input.allowedPaths ?? []).map(canonicalPath).sort();
  const durablePaths = [
    ...(input.factoryStoreRoot ? [input.factoryStoreRoot] : []),
    ...(input.durablePaths ?? []),
  ]
    .map(canonicalPath)
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort();
  const gitRoot = canonicalPath(gitValue(workspace, ["rev-parse", "--show-toplevel"]));
  return {
    workspace,
    refs: readRefs(gitRoot),
    head: gitValue(gitRoot, ["rev-parse", "HEAD"]),
    index: hashGitIndex(gitRoot),
    harness: fingerprintPath(join(gitRoot, ".harness"), allowedPaths),
    lifecycle: fingerprintPath(input.lifecycleRoot, allowedPaths),
    factoryStore: durablePaths
      .map((path) => `${path}:${fingerprintPath(path, allowedPaths)}`)
      .join("|"),
    allowedPaths,
  };
}

export function assertFactoryWriterBoundary(
  before: FactoryWriterBoundarySnapshot,
  after: FactoryWriterBoundarySnapshot,
): void {
  const changed: string[] = [];
  if (!sameRefs(before.refs, after.refs)) changed.push("refs");
  if (before.head !== after.head) changed.push("HEAD");
  if (before.index !== after.index) changed.push("index");
  if (before.harness !== after.harness) changed.push("workspace .harness");
  if (before.lifecycle !== after.lifecycle) changed.push("lifecycle");
  if (before.factoryStore !== after.factoryStore) changed.push("Factory store");
  if (changed.length > 0) throw new FactoryWriterBoundaryError(changed, before, after);
}

function readRefs(workspace: string): Record<string, string> {
  const output = gitValue(workspace, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  const refs: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const [name, object] = line.trim().split(/\s+/, 2);
    if (name && object) refs[name] = object;
  }
  return refs;
}

function hashGitIndex(workspace: string): string {
  // `git status` may refresh index stat-cache metadata while probing the
  // workspace. Compare logical staged entries, not volatile index bytes.
  try {
    const entries = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return createHash("sha256").update(entries).digest("hex");
  } catch {
    throw new Error("Factory writer boundary Git probe failed: ls-files --stage");
  }
}

function gitValue(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`Factory writer boundary Git probe failed: ${args.join(" ")}`);
  }
}

function fingerprintPath(path: string | undefined, allowedPaths: readonly string[]): string {
  if (!path || !existsSync(path)) return "missing";
  const root = canonicalPath(path);
  const entries: string[] = [];
  const visitedRealpaths = new Set<string>();
  const maxEntries = 10_000;
  const visit = (current: string): void => {
    if (allowedPaths.some((allowed) => current === allowed || current.startsWith(`${allowed}/`))) {
      return;
    }
    const stat = lstatSync(current);
    const realCurrent = realpathSync(current);
    if (visitedRealpaths.has(realCurrent)) return;
    visitedRealpaths.add(realCurrent);
    if (visitedRealpaths.size > maxEntries) {
      throw new Error(`Factory writer boundary fingerprint exceeded ${maxEntries} paths.`);
    }
    const rel = relative(root, current) || ".";
    entries.push(`${rel}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.isSymbolicLink()}`);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(current);
      entries.push(`target:${target}`);
      if (isContainedPath(root, target)) visit(target);
      return;
    }
    if (!stat.isDirectory()) {
      if (stat.isFile()) entries.push(hashFile(current));
      return;
    }
    for (const entry of readdirSync(current)) visit(join(current, entry));
  };
  visit(root);
  return entries.sort().join("|");
}

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("../"));
}

function hashFile(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "unreadable";
  }
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  let existing = resolved;
  const suffix: string[] = [];
  while (!existsSync(existing) && existing !== dirname(existing)) {
    suffix.unshift(basename(existing));
    existing = dirname(existing);
  }
  try {
    return join(realpathSync(existing), ...suffix);
  } catch {
    return resolved;
  }
}

function sameRefs(left: Record<string, string>, right: Record<string, string>): boolean {
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const name of names) if (left[name] !== right[name]) return false;
  return true;
}
