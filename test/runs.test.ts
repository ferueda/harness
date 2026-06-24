import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseRetentionDuration, pruneRuns } from "../lib/runs.ts";

const FIXED_NOW = new Date("2026-06-24T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function createRunsDir(): string {
  return mkdtempSync(join(tmpdir(), "harness-runs-"));
}

function writeRun(
  runsDir: string,
  runId: string,
  metadata?: { startedAt?: string; status?: string },
): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  if (metadata) {
    writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }
  return runDir;
}

test("parseRetentionDuration accepts day and hour shorthand", () => {
  expect(parseRetentionDuration("7d")).toBe(7 * DAY_MS);
  expect(parseRetentionDuration("24h")).toBe(24 * HOUR_MS);
  expect(parseRetentionDuration(" 30D ")).toBe(30 * DAY_MS);
});

test("parseRetentionDuration rejects unsupported duration forms", () => {
  for (const value of ["soon", "7 days", "0d", "1.5d", "-1d", `${Number.MAX_SAFE_INTEGER}d`]) {
    expect(() => parseRetentionDuration(value)).toThrow(/invalid duration/i);
  }
});

test("pruneRuns dry-run reports old runs without deleting", () => {
  const runsDir = createRunsDir();
  const oldRun = writeRun(runsDir, "20260101-000000-aaaaaa", {
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const recentRun = writeRun(runsDir, "20260623-000000-bbbbbb", {
    status: "completed",
    startedAt: "2026-06-23T00:00:00.000Z",
  });

  const result = pruneRuns({
    workspace: runsDir,
    runsDir,
    olderThanMs: 7 * DAY_MS,
    dryRun: true,
    now: FIXED_NOW,
  });

  expect(result.matched).toBe(1);
  expect(result.deleted).toBe(0);
  expect(result.kept).toBe(1);
  expect(result.runs).toMatchObject([
    {
      runId: "20260101-000000-aaaaaa",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      deleted: false,
    },
  ]);
  expect(existsSync(oldRun)).toBe(true);
  expect(existsSync(recentRun)).toBe(true);
});

test("pruneRuns deletes only runs older than cutoff", () => {
  const runsDir = createRunsDir();
  const oldRun = writeRun(runsDir, "20260101-000000-aaaaaa", {
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const recentRun = writeRun(runsDir, "20260623-000000-bbbbbb", {
    startedAt: "2026-06-23T00:00:00.000Z",
  });

  const result = pruneRuns({
    workspace: runsDir,
    runsDir,
    olderThanMs: 7 * DAY_MS,
    dryRun: false,
    now: FIXED_NOW,
  });

  expect(result.matched).toBe(1);
  expect(result.deleted).toBe(1);
  expect(result.kept).toBe(1);
  expect(result.runs).toMatchObject([{ runId: "20260101-000000-aaaaaa", deleted: true }]);
  expect(existsSync(oldRun)).toBe(false);
  expect(existsSync(recentRun)).toBe(true);
});

test("pruneRuns keeps runs at the exact cutoff", () => {
  const runsDir = createRunsDir();
  const cutoffRun = writeRun(runsDir, "20260617-000000-aaaaaa", {
    startedAt: "2026-06-17T00:00:00.000Z",
  });

  const result = pruneRuns({
    workspace: runsDir,
    runsDir,
    olderThanMs: 7 * DAY_MS,
    dryRun: false,
    now: FIXED_NOW,
  });

  expect(result.matched).toBe(0);
  expect(result.deleted).toBe(0);
  expect(result.kept).toBe(1);
  expect(result.runs).toEqual([]);
  expect(existsSync(cutoffRun)).toBe(true);
});

test("pruneRuns falls back to run id timestamp", () => {
  const runsDir = createRunsDir();
  const oldRun = writeRun(runsDir, "20200101-000000-aaaaaa");

  const result = pruneRuns({
    workspace: runsDir,
    runsDir,
    olderThanMs: 7 * DAY_MS,
    dryRun: false,
    now: FIXED_NOW,
  });

  expect(result.matched).toBe(1);
  expect(result.deleted).toBe(1);
  expect(result.runs).toMatchObject([
    { runId: "20200101-000000-aaaaaa", startedAt: "2020-01-01T00:00:00.000Z" },
  ]);
  expect(existsSync(oldRun)).toBe(false);
});

test("pruneRuns falls back to run id timestamp when metadata date is invalid", () => {
  const runsDir = createRunsDir();
  const oldRun = writeRun(runsDir, "20200101-000000-aaaaaa", {
    status: "completed",
    startedAt: "not-a-date",
  });

  const result = pruneRuns({
    workspace: runsDir,
    runsDir,
    olderThanMs: 7 * DAY_MS,
    dryRun: false,
    now: FIXED_NOW,
  });

  expect(result.matched).toBe(1);
  expect(result.deleted).toBe(1);
  expect(result.runs).toMatchObject([
    {
      runId: "20200101-000000-aaaaaa",
      startedAt: "2020-01-01T00:00:00.000Z",
      status: "completed",
    },
  ]);
  expect(existsSync(oldRun)).toBe(false);
});

test("pruneRuns skips symlink children", () => {
  const runsDir = createRunsDir();
  const target = mkdtempSync(join(tmpdir(), "harness-runs-target-"));
  const link = join(runsDir, "20200101-000000-aaaaaa");
  try {
    symlinkSync(target, link, "dir");
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        return;
      }
    }
    throw error;
  }

  const result = pruneRuns({
    workspace: runsDir,
    runsDir,
    olderThanMs: 7 * DAY_MS,
    dryRun: false,
    now: FIXED_NOW,
  });

  expect(result.skipped).toBe(1);
  expect(result.matched).toBe(0);
  expect(existsSync(link)).toBe(true);
  expect(existsSync(target)).toBe(true);
});

test("pruneRuns treats missing runs dir as empty", () => {
  const runsDir = join(createRunsDir(), "missing");

  const result = pruneRuns({
    workspace: runsDir,
    runsDir,
    olderThanMs: 7 * DAY_MS,
    dryRun: false,
    now: FIXED_NOW,
  });

  expect(result.matched).toBe(0);
  expect(result.deleted).toBe(0);
  expect(result.kept).toBe(0);
  expect(result.skipped).toBe(0);
  expect(result.runs).toEqual([]);
});

test("pruneRuns skips unknown direct child directories and files", () => {
  const runsDir = createRunsDir();
  const notes = join(runsDir, "notes");
  const gitkeep = join(runsDir, ".gitkeep");
  mkdirSync(notes);
  writeFileSync(gitkeep, "", "utf8");

  const result = pruneRuns({
    workspace: runsDir,
    runsDir,
    olderThanMs: 7 * DAY_MS,
    dryRun: false,
    now: FIXED_NOW,
  });

  expect(result.skipped).toBe(2);
  expect(result.matched).toBe(0);
  expect(existsSync(notes)).toBe(true);
  expect(existsSync(gitkeep)).toBe(true);
});
