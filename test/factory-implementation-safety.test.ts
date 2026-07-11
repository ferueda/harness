import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

type WriteFileSync = typeof writeFileSync;
type MkdirSync = typeof mkdirSync;
type NodeFsModule = {
  [key: string]: unknown;
  writeFileSync: WriteFileSync;
  mkdirSync: MkdirSync;
};

const fsMocks = vi.hoisted(() => ({
  realWriteFileSync: undefined as WriteFileSync | undefined,
  writeFileSync: vi.fn(),
  realMkdirSync: undefined as MkdirSync | undefined,
  mkdirSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<NodeFsModule>();
  fsMocks.realWriteFileSync = actual.writeFileSync;
  fsMocks.writeFileSync.mockImplementation(actual.writeFileSync);
  fsMocks.realMkdirSync = actual.mkdirSync;
  fsMocks.mkdirSync.mockImplementation(actual.mkdirSync);
  return { ...actual, writeFileSync: fsMocks.writeFileSync, mkdirSync: fsMocks.mkdirSync };
});
import {
  allocateFactoryRun,
  releaseEmptyFactoryRunReservation,
  writeFactoryRunReservation,
} from "../lib/factory-run-allocation.ts";
import {
  resolveFactoryArtifactPointer,
  FactoryImplementationReviewInputError,
} from "../lib/factory-implementation-review-input.ts";
import {
  assertFactoryWriterBoundary,
  captureFactoryWriterBoundary,
} from "../lib/factory-writer-boundary.ts";
import {
  acquireFactoryWorkspaceWriterLease,
  inspectFactoryWorkspaceWriterLease,
  releaseFactoryWorkspaceWriterLease,
} from "../lib/factory-locks.ts";

test("run reservation cleanup requires the persisted token", () => {
  const factoryRunsDir = mkdtempSync(join(tmpdir(), "harness-factory-allocation-"));
  const allocation = allocateFactoryRun({ factoryRunsDir, runId: "implementation-test" });
  writeFactoryRunReservation(allocation);

  expect(
    JSON.parse(readFileSync(join(allocation.runDir, "attempt-reservation.json"), "utf8")),
  ).toMatchObject({ runId: allocation.runId, reservationToken: allocation.reservationToken });
  expect(
    releaseEmptyFactoryRunReservation({
      runDir: allocation.runDir,
      factoryRunsDir,
      reservationToken: "wrong-token",
    }),
  ).toBe(false);
  expect(existsSync(allocation.runDir)).toBe(true);
  expect(
    releaseEmptyFactoryRunReservation({
      runDir: allocation.runDir,
      factoryRunsDir,
      reservationToken: allocation.reservationToken,
    }),
  ).toBe(true);
  expect(existsSync(allocation.runDir)).toBe(false);
});

test("run reservation cleanup removes an empty allocation without a manifest", () => {
  const factoryRunsDir = mkdtempSync(join(tmpdir(), "harness-factory-allocation-empty-"));
  const allocation = allocateFactoryRun({ factoryRunsDir, runId: "implementation-empty" });

  expect(
    releaseEmptyFactoryRunReservation({
      runDir: allocation.runDir,
      factoryRunsDir,
      reservationToken: allocation.reservationToken,
    }),
  ).toBe(true);
  expect(existsSync(allocation.runDir)).toBe(false);
});

test("run reservation cleanup preserves non-empty evidence without a manifest", () => {
  const factoryRunsDir = mkdtempSync(join(tmpdir(), "harness-factory-allocation-evidence-"));
  const allocation = allocateFactoryRun({ factoryRunsDir, runId: "implementation-evidence" });
  writeFileSync(join(allocation.runDir, "implementation-review-reservation.json"), "{}\n", "utf8");

  expect(
    releaseEmptyFactoryRunReservation({
      runDir: allocation.runDir,
      factoryRunsDir,
      reservationToken: allocation.reservationToken,
    }),
  ).toBe(false);
  expect(existsSync(allocation.runDir)).toBe(true);
});

test("artifact pointers reject traversal and symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-factory-pointer-"));
  const reviewRunsDir = join(root, "reviews");
  const runDir = join(reviewRunsDir, "review-1");
  const outside = join(root, "outside.json");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "meta.json"), "{}\n", "utf8");
  writeFileSync(outside, "outside\n", "utf8");
  symlinkSync(outside, join(runDir, "escape.json"));

  expect(
    resolveFactoryArtifactPointer({
      pointer: { root: "review", runId: "review-1", path: "meta.json" },
      runRoots: { factoryRunsDir: join(root, "factory"), reviewRunsDir },
    }),
  ).toBe(join(runDir, "meta.json"));
  expect(() =>
    resolveFactoryArtifactPointer({
      pointer: { root: "review", runId: "review-1", path: "../outside.json" },
      runRoots: { factoryRunsDir: join(root, "factory"), reviewRunsDir },
    }),
  ).toThrow(FactoryImplementationReviewInputError);
  expect(() =>
    resolveFactoryArtifactPointer({
      pointer: { root: "review", runId: "review-1", path: "escape.json" },
      runRoots: { factoryRunsDir: join(root, "factory"), reviewRunsDir },
    }),
  ).toThrow(/symlinked/);
});

test("artifact pointers reject nested run IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-factory-pointer-nested-"));
  const reviewRunsDir = join(root, "reviews");
  mkdirSync(join(reviewRunsDir, "nested", "run-1"), { recursive: true });

  expect(() =>
    resolveFactoryArtifactPointer({
      pointer: { root: "review", runId: "nested/run-1", path: "meta.json" },
      runRoots: { factoryRunsDir: join(root, "factory"), reviewRunsDir },
    }),
  ).toThrow(FactoryImplementationReviewInputError);
});

test("writer boundary rejects external symlink targets in protected roots", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-boundary-"));
  const external = mkdtempSync(join(tmpdir(), "harness-factory-boundary-target-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspace,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "tracked.txt"), "tracked\n", "utf8");
  writeFileSync(join(workspace, ".gitignore"), ".harness/\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  mkdirSync(join(workspace, ".harness"), { recursive: true });
  symlinkSync(external, join(workspace, ".harness", "external"));

  expect(() => captureFactoryWriterBoundary({ workspace })).toThrow(/rejects external symlink/);
});

test("writer boundary canonicalizes missing allowed logs through symlinked durable roots", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-boundary-log-workspace-"));
  const durableTarget = mkdtempSync(join(tmpdir(), "harness-factory-boundary-log-target-"));
  const durableLink = join(workspace, "runs");
  const runDir = join(durableTarget, "run-1");
  const logPath = join(runDir, "implementation/stream.jsonl");
  const logicalLogPath = join(durableLink, "run-1/implementation/stream.jsonl");
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspace,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "tracked.txt"), "tracked\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  mkdirSync(join(runDir, "implementation"), { recursive: true });
  symlinkSync(durableTarget, durableLink, "dir");
  writeFileSync(logPath, "{}\n", "utf8");

  const before = captureFactoryWriterBoundary({
    workspace,
    durablePaths: [durableLink],
    allowedPaths: [logicalLogPath],
  });
  writeFileSync(logPath, '{"event":true}\n', "utf8");
  const after = captureFactoryWriterBoundary({
    workspace,
    durablePaths: [durableLink],
    allowedPaths: [logicalLogPath],
  });

  expect(() => assertFactoryWriterBoundary(before, after)).not.toThrow();
});

test("writer boundary tolerates new sibling review runs but detects existing-run edits", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-boundary-review-store-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "harness-factory-boundary-review-store-root-"));
  const reviewRunsDir = join(storeRoot, "runs", "reviews");
  const existingRun = join(reviewRunsDir, "review-1");
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspace,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "tracked.txt"), "tracked\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  mkdirSync(existingRun, { recursive: true });
  writeFileSync(join(existingRun, "meta.json"), "before\n", "utf8");

  const before = captureFactoryWriterBoundary({
    workspace,
    factoryStoreRoot: storeRoot,
    volatileDurablePaths: [reviewRunsDir],
  });
  mkdirSync(join(reviewRunsDir, "review-2"), { recursive: true });
  writeFileSync(
    join(reviewRunsDir, "review-2/meta.json"),
    JSON.stringify({ runId: "review-2", workspace, agent: {}, scope: {} }) + "\n",
    "utf8",
  );
  const concurrentAfter = captureFactoryWriterBoundary({
    workspace,
    factoryStoreRoot: storeRoot,
    volatileDurablePaths: [reviewRunsDir],
  });
  expect(() => assertFactoryWriterBoundary(before, concurrentAfter)).not.toThrow();

  mkdirSync(join(reviewRunsDir, "review-3"), { recursive: true });
  writeFileSync(join(reviewRunsDir, "review-3/meta.json"), "unauthorized\n", "utf8");
  const unauthorizedAfter = captureFactoryWriterBoundary({
    workspace,
    factoryStoreRoot: storeRoot,
    volatileDurablePaths: [reviewRunsDir],
  });
  expect(() => assertFactoryWriterBoundary(before, unauthorizedAfter)).toThrow(/Factory store/);

  writeFileSync(join(existingRun, "meta.json"), "tampered\n", "utf8");
  const tamperedAfter = captureFactoryWriterBoundary({
    workspace,
    factoryStoreRoot: storeRoot,
    volatileDurablePaths: [reviewRunsDir],
  });
  expect(() => assertFactoryWriterBoundary(before, tamperedAfter)).toThrow(/Factory store/);
});

test("writer boundary records symbolic HEAD and index flags", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-boundary-git-state-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspace,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "tracked.txt"), "tracked\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });

  const beforeBranch = captureFactoryWriterBoundary({ workspace });
  execFileSync("git", ["switch", "-c", "same-commit"], { cwd: workspace, stdio: "ignore" });
  const afterBranch = captureFactoryWriterBoundary({ workspace });
  expect(() => assertFactoryWriterBoundary(beforeBranch, afterBranch)).toThrow(/HEAD symbolic ref/);

  execFileSync("git", ["switch", "main"], { cwd: workspace, stdio: "ignore" });
  const beforeFlags = captureFactoryWriterBoundary({ workspace });
  execFileSync("git", ["update-index", "--skip-worktree", "tracked.txt"], {
    cwd: workspace,
    stdio: "ignore",
  });
  const afterFlags = captureFactoryWriterBoundary({ workspace });
  execFileSync("git", ["update-index", "--no-skip-worktree", "tracked.txt"], {
    cwd: workspace,
    stdio: "ignore",
  });
  expect(() => assertFactoryWriterBoundary(beforeFlags, afterFlags)).toThrow(/index/);
});

test("writer lease removes a newly created lock when owner publication fails", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-lease-publication-workspace-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  const env = {
    ...process.env,
    XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "harness-factory-lease-publication-data-")),
  };
  fsMocks.writeFileSync.mockImplementation(() => {
    throw new Error("owner publication failed");
  });

  expect(() =>
    acquireFactoryWorkspaceWriterLease({
      workspace,
      factoryProjectId: "test-project",
      storeRoot: mkdtempSync(join(tmpdir(), "harness-factory-lease-publication-store-")),
      workItemKey: "linear:ENG-123",
      runId: "implementation-test",
      operation: "implementation",
      env,
    }),
  ).toThrow(/Cannot acquire factory workspace writer lease/);
  fsMocks.writeFileSync.mockImplementation(fsMocks.realWriteFileSync!);

  expect(inspectFactoryWorkspaceWriterLease({ workspace, env })).toBeUndefined();
});

test("writer lease inspection and release reject symlinked lease entries", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-lease-symlink-workspace-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  const env = {
    ...process.env,
    XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "harness-factory-lease-symlink-data-")),
  };
  const handle = acquireFactoryWorkspaceWriterLease({
    workspace,
    factoryProjectId: "test-project",
    storeRoot: mkdtempSync(join(tmpdir(), "harness-factory-lease-symlink-store-")),
    workItemKey: "linear:ENG-123",
    runId: "implementation-test",
    operation: "implementation",
    env,
  });
  const external = mkdtempSync(join(tmpdir(), "harness-factory-lease-symlink-target-"));
  rmSync(handle.path, { recursive: true, force: true });
  symlinkSync(external, handle.path, "dir");

  expect(() => inspectFactoryWorkspaceWriterLease({ workspace, env })).toThrow(/symlinked/);
  expect(() => releaseFactoryWorkspaceWriterLease({ handle })).toThrow(/symlinked/);
});

test("writer lease namespace tolerates a concurrent first-acquisition mkdir", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-lease-race-workspace-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  const env = {
    ...process.env,
    XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "harness-factory-lease-race-data-")),
  };
  let raced = false;
  fsMocks.mkdirSync.mockImplementation((...args: Parameters<MkdirSync>) => {
    if (!raced) {
      raced = true;
      fsMocks.realMkdirSync!(...args);
      const error = Object.assign(new Error("concurrent mkdir"), { code: "EEXIST" });
      throw error;
    }
    return fsMocks.realMkdirSync!(...args);
  });

  try {
    const handle = acquireFactoryWorkspaceWriterLease({
      workspace,
      factoryProjectId: "test-project",
      storeRoot: mkdtempSync(join(tmpdir(), "harness-factory-lease-race-store-")),
      workItemKey: "linear:ENG-123",
      runId: "implementation-test",
      operation: "implementation",
      env,
    });
    releaseFactoryWorkspaceWriterLease({ handle });
  } finally {
    fsMocks.mkdirSync.mockImplementation(fsMocks.realMkdirSync!);
  }

  expect(raced).toBe(true);
});

test("writer lease release requires full owner identity and rejects dangling owners", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-lease-owner-workspace-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  const env = {
    ...process.env,
    XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "harness-factory-lease-owner-data-")),
  };
  const handle = acquireFactoryWorkspaceWriterLease({
    workspace,
    factoryProjectId: "test-project",
    storeRoot: mkdtempSync(join(tmpdir(), "harness-factory-lease-owner-store-")),
    workItemKey: "linear:ENG-123",
    runId: "implementation-test",
    operation: "implementation",
    env,
  });

  writeFileSync(
    join(handle.path, "owner.json"),
    `${JSON.stringify({ ...handle.owner, workItemKey: "linear:ENG-124" })}\n`,
    "utf8",
  );
  releaseFactoryWorkspaceWriterLease({ handle });
  expect(existsSync(handle.path)).toBe(true);

  rmSync(join(handle.path, "owner.json"), { force: true });
  expect(inspectFactoryWorkspaceWriterLease({ workspace, env })).toMatchObject({
    classification: "owner-missing",
    stale: false,
  });
  expect(() => releaseFactoryWorkspaceWriterLease({ handle })).not.toThrow();
  symlinkSync(join(handle.path, "missing-owner.json"), join(handle.path, "owner.json"));
  expect(() => inspectFactoryWorkspaceWriterLease({ workspace, env })).toThrow(/symlinked/);
  expect(() => releaseFactoryWorkspaceWriterLease({ handle })).toThrow(/symlinked/);
});
