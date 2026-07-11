import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export type FactoryWriterBoundarySnapshot = {
  workspace: string;
  refs: Record<string, string>;
  head: string;
  headRef: string;
  index: string;
  harness: string;
  lifecycle: string;
  factoryStore: string;
  volatileFactoryStore: Array<{
    root: string;
    rootFingerprint: string;
    children: Record<string, string>;
  }>;
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
  volatileDurablePaths?: readonly string[];
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
  const volatileDurablePaths = (input.volatileDurablePaths ?? [])
    .map(canonicalPath)
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort();
  const stableDurablePaths = durablePaths.filter((path) => !volatileDurablePaths.includes(path));
  const gitRoot = canonicalPath(gitValue(workspace, ["rev-parse", "--show-toplevel"]));
  return {
    workspace,
    refs: readRefs(gitRoot),
    head: gitValue(gitRoot, ["rev-parse", "HEAD"]),
    headRef: gitValueOrEmpty(gitRoot, ["symbolic-ref", "--short", "-q", "HEAD"]),
    index: hashGitIndex(gitRoot),
    harness: fingerprintPath(join(gitRoot, ".harness"), allowedPaths),
    lifecycle: fingerprintPath(input.lifecycleRoot, allowedPaths),
    factoryStore: stableDurablePaths
      .map((path) => {
        const excluded = volatileDurablePaths.filter((volatilePath) =>
          isContainedPath(path, volatilePath),
        );
        return `${path}:${fingerprintPath(path, allowedPaths, excluded)}`;
      })
      .join("|"),
    volatileFactoryStore: volatileDurablePaths.map((root) =>
      fingerprintVolatileRoot(root, allowedPaths),
    ),
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
  if (before.headRef !== after.headRef) changed.push("HEAD symbolic ref");
  if (before.index !== after.index) changed.push("index");
  if (before.harness !== after.harness) changed.push("workspace .harness");
  if (before.lifecycle !== after.lifecycle) changed.push("lifecycle");
  if (before.factoryStore !== after.factoryStore) changed.push("Factory store");
  if (!sameVolatileFactoryStore(before.volatileFactoryStore, after.volatileFactoryStore)) {
    changed.push("Factory store");
  }
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
    const flags = execFileSync("git", ["ls-files", "-v", "-z"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return createHash("sha256").update(`${entries}\0${flags}`).digest("hex");
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

function gitValueOrEmpty(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function fingerprintPath(
  path: string | undefined,
  allowedPaths: readonly string[],
  excludedPaths: readonly string[] = [],
): string {
  if (!path || !existsSync(path)) return "missing";
  const root = canonicalPath(path);
  const entries: string[] = [];
  const visitedRealpaths = new Set<string>();
  const maxEntries = 10_000;
  const visit = (current: string): void => {
    if (excludedPaths.includes(current)) return;
    const allowedFile = allowedPaths.find((allowed) => current === allowed);
    if (allowedFile) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
          `Factory writer boundary allowlisted path is not a regular file: ${current}`,
        );
      }
      const rel = relative(root, current) || ".";
      // Allow stream contents to change, but keep replacement/type changes visible.
      entries.push(`${rel}:allowed-file:${stat.mode}`);
      return;
    }
    if (allowedPaths.some((allowed) => current.startsWith(`${allowed}/`))) {
      throw new Error(
        `Factory writer boundary allowlisted path was replaced by a directory: ${current}`,
      );
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
      if (!isContainedPath(root, target)) {
        throw new Error(`Factory writer boundary rejects external symlink: ${current}`);
      }
      visit(target);
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

function fingerprintVolatileRoot(
  root: string,
  allowedPaths: readonly string[],
): FactoryWriterBoundarySnapshot["volatileFactoryStore"][number] {
  if (!existsSync(root)) return { root, rootFingerprint: "missing", children: {} };
  const stat = lstatSync(root);
  if (!stat.isDirectory()) {
    return { root, rootFingerprint: fingerprintPath(root, allowedPaths), children: {} };
  }
  // Directory mtime/size changes whenever an expected sibling run is created.
  // Compare the root type only; existing children remain fully fingerprinted.
  const rootEntries = [`.:${stat.mode}:${stat.isSymbolicLink()}`];
  const children: Record<string, string> = {};
  for (const entry of readdirSync(root)) {
    const child = join(root, entry);
    const childStat = lstatSync(child);
    if (childStat.isDirectory()) {
      children[entry] = fingerprintPath(child, allowedPaths);
    } else {
      rootEntries.push(`${entry}:${fingerprintPath(child, allowedPaths)}`);
    }
  }
  return { root, rootFingerprint: rootEntries.sort().join("|"), children };
}

function sameVolatileFactoryStore(
  before: FactoryWriterBoundarySnapshot["volatileFactoryStore"],
  after: FactoryWriterBoundarySnapshot["volatileFactoryStore"],
): boolean {
  for (const beforeRoot of before) {
    const afterRoot = after.find((candidate) => candidate.root === beforeRoot.root);
    if (!afterRoot || beforeRoot.rootFingerprint !== afterRoot.rootFingerprint) return false;
    for (const [name, fingerprint] of Object.entries(beforeRoot.children)) {
      if (afterRoot.children[name] !== fingerprint) return false;
    }
    for (const name of Object.keys(afterRoot.children)) {
      if (!(name in beforeRoot.children) && !isHarnessOwnedReviewRun(afterRoot.root, name)) {
        return false;
      }
    }
  }
  return true;
}

function isHarnessOwnedReviewRun(root: string, name: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(root, name, "meta.json"), "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
      record.runId === name &&
      typeof record.workspace === "string" &&
      typeof record.agent === "object" &&
      record.agent !== null &&
      typeof record.scope === "object" &&
      record.scope !== null
    );
  } catch {
    return false;
  }
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
