import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

type WriteFileSync = typeof writeFileSync;
type NodeFsModule = { [key: string]: unknown; writeFileSync: WriteFileSync };

const fsMocks = vi.hoisted(() => ({
  realWriteFileSync: undefined as WriteFileSync | undefined,
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<NodeFsModule>();
  fsMocks.realWriteFileSync = actual.writeFileSync;
  fsMocks.writeFileSync.mockImplementation(actual.writeFileSync);
  return { ...actual, writeFileSync: fsMocks.writeFileSync };
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
  FactoryWriterBoundaryError,
} from "../lib/factory-writer-boundary.ts";
import {
  acquireFactoryWorkspaceWriterLease,
  inspectFactoryWorkspaceWriterLease,
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

test("writer boundary fingerprints the canonical Git workspace and symlink targets", () => {
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

  const before = captureFactoryWriterBoundary({ workspace });
  const replacement = mkdtempSync(join(tmpdir(), "harness-factory-boundary-replacement-"));
  unlinkSync(join(workspace, ".harness", "external"));
  symlinkSync(replacement, join(workspace, ".harness", "external"));
  const after = captureFactoryWriterBoundary({ workspace });

  expect(() => assertFactoryWriterBoundary(before, after)).toThrow(FactoryWriterBoundaryError);
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
