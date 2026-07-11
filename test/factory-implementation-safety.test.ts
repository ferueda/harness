import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  allocateFactoryRun,
  releaseEmptyFactoryRunReservation,
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

test("run reservation cleanup requires the persisted token", () => {
  const factoryRunsDir = mkdtempSync(join(tmpdir(), "harness-factory-allocation-"));
  const allocation = allocateFactoryRun({ factoryRunsDir, runId: "implementation-test" });

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
  writeFileSync(join(external, "state.txt"), "before\n", "utf8");
  symlinkSync(external, join(workspace, ".harness", "external"));

  const before = captureFactoryWriterBoundary({ workspace });
  writeFileSync(join(external, "state.txt"), "after\n", "utf8");
  const after = captureFactoryWriterBoundary({ workspace });

  expect(() => assertFactoryWriterBoundary(before, after)).toThrow(FactoryWriterBoundaryError);
});
