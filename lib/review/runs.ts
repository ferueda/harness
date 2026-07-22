import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { InvalidArgumentError } from "commander";

export type PruneRunsOptions = {
  workspace: string;
  runsDir?: string;
  olderThanMs: number;
  dryRun: boolean;
  now?: Date;
};

export type PrunedRun = {
  runId: string;
  path: string;
  startedAt: string;
  status?: string;
  deleted: boolean;
};

export type PruneRunsResult = {
  workspace: string;
  runsDir: string;
  dryRun: boolean;
  olderThanMs: number;
  cutoff: string;
  matched: number;
  deleted: number;
  kept: number;
  skipped: number;
  runs: PrunedRun[];
};

type RunMetadata = {
  startedAt?: string;
  status?: string;
};

type RunCandidate = {
  startedAt: Date;
  status?: string;
};

const DURATION_PATTERN = /^(\d+)([dh])$/;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function parseRetentionDuration(value: string): number {
  const normalized = value.trim().toLowerCase();
  const match = DURATION_PATTERN.exec(normalized);
  if (!match) {
    throw new InvalidArgumentError("invalid duration; use Nd or Nh, e.g. 7d or 24h");
  }

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new InvalidArgumentError("invalid duration; use a positive duration like 7d or 24h");
  }

  const multiplier = match[2] === "d" ? MS_PER_DAY : MS_PER_HOUR;
  const durationMs = amount * multiplier;
  if (!Number.isSafeInteger(durationMs)) {
    throw new InvalidArgumentError("invalid duration; duration is too large");
  }
  return durationMs;
}

export function pruneRuns(options: PruneRunsOptions): PruneRunsResult {
  const workspace = resolve(options.workspace);
  const runsDir = resolve(options.runsDir ?? join(workspace, ".harness/runs/reviews"));
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.olderThanMs);
  const result: PruneRunsResult = {
    workspace,
    runsDir,
    dryRun: options.dryRun,
    olderThanMs: options.olderThanMs,
    cutoff: cutoff.toISOString(),
    matched: 0,
    deleted: 0,
    kept: 0,
    skipped: 0,
    runs: [],
  };

  if (!existsSync(runsDir)) {
    return result;
  }

  for (const runId of readdirSync(runsDir).sort()) {
    const runPath = join(runsDir, runId);
    const stats = lstatSync(runPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      result.skipped += 1;
      continue;
    }

    const candidate = readRunCandidate(runId, runPath);
    if (!candidate) {
      result.skipped += 1;
      continue;
    }

    if (candidate.startedAt.getTime() >= cutoff.getTime()) {
      result.kept += 1;
      continue;
    }

    const didDelete = !options.dryRun;
    result.matched += 1;
    if (didDelete) {
      rmSync(runPath, { recursive: true, force: true });
      result.deleted += 1;
    }
    result.runs.push({
      runId,
      path: runPath,
      startedAt: candidate.startedAt.toISOString(),
      ...(candidate.status ? { status: candidate.status } : {}),
      deleted: didDelete,
    });
  }

  result.runs.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return result;
}

function readRunCandidate(runId: string, runPath: string): RunCandidate | null {
  const metadata = readRunMetadata(join(runPath, "meta.json"));
  const startedAt = parseDate(metadata?.startedAt) ?? parseRunIdDate(runId);
  if (!startedAt) {
    return null;
  }

  return {
    startedAt,
    ...(metadata?.status ? { status: metadata.status } : {}),
  };
}

function readRunMetadata(path: string): RunMetadata | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(parsed)) {
      return null;
    }

    return {
      ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}),
      ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
    };
  } catch {
    return null;
  }
}

function parseRunIdDate(runId: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]+$/.exec(runId);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
