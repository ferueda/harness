import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ensureFactoryRunDirectory, writeFactoryRunFile } from "./factory-run-files.ts";

const MAX_ALLOCATION_ATTEMPTS = 8;

export type FactoryRunAllocation = {
  runId: string;
  runDir: string;
  reservationToken: string;
};

export function writeFactoryRunReservation(allocation: FactoryRunAllocation): void {
  writeFactoryRunFile({
    runDir: allocation.runDir,
    relativePath: "attempt-reservation.json",
    value: `${JSON.stringify(
      { runId: allocation.runId, reservationToken: allocation.reservationToken },
      null,
      2,
    )}\n`,
    flag: "wx",
  });
}

export class FactoryRunAllocationError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryRunAllocationError";
  }
}

export function allocateFactoryRun(input: {
  factoryRunsDir: string;
  idPrefix?: string;
  runId?: string;
  now?: () => Date;
  random?: () => string;
}): FactoryRunAllocation {
  if (input.runId !== undefined && !isSafeRunId(input.runId)) {
    throw new FactoryRunAllocationError(`Invalid Factory run ID: ${input.runId}`);
  }
  const root = resolve(input.factoryRunsDir);
  try {
    ensureFactoryRunDirectory(root);
  } catch (error) {
    throw new FactoryRunAllocationError(`Cannot create Factory runs root: ${root}`, {
      cause: error,
    });
  }
  const now = input.now ?? (() => new Date());
  const random = input.random ?? (() => randomBytes(6).toString("hex"));
  const prefix = input.idPrefix ?? "run";
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const runId = input.runId ?? `${prefix}-${formatRunTimestamp(now())}-${random()}`;
    const runDir = join(root, runId);
    try {
      mkdirSync(runDir);
      const reservationToken = randomBytes(16).toString("hex");
      return { runId, runDir, reservationToken };
    } catch (error) {
      if (isAlreadyExistsError(error)) continue;
      throw new FactoryRunAllocationError(`Cannot reserve Factory run directory: ${runDir}`, {
        cause: error,
      });
    }
  }
  throw new FactoryRunAllocationError(
    `Could not reserve a unique Factory run directory after ${MAX_ALLOCATION_ATTEMPTS} attempts under ${root}`,
  );
}

/** Remove only an untouched reservation. Context/manifest evidence is preserved. */
export function releaseEmptyFactoryRunReservation(input: {
  runDir: string;
  reservationToken: string;
  factoryRunsDir?: string;
}): boolean {
  try {
    const runDir = resolve(input.runDir);
    const root = resolve(input.factoryRunsDir ?? dirname(runDir));
    const relativeRun = relative(root, runDir);
    if (!relativeRun || relativeRun.includes("/") || relativeRun === "..") return false;
    const runStat = lstatSync(runDir);
    if (runStat.isSymbolicLink() || !runStat.isDirectory()) return false;
    const manifestPath = join(runDir, "attempt-reservation.json");
    const entries = readdirSync(runDir);
    if (!existsSync(manifestPath)) {
      if (entries.length !== 0) return false;
      rmdirSync(runDir);
      return true;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      runId?: unknown;
      reservationToken?: unknown;
    };
    if (manifest.runId !== relativeRun || manifest.reservationToken !== input.reservationToken)
      return false;
    const reservationFiles = new Set([
      "attempt-reservation.json",
      "implementation-review-reservation.json",
    ]);
    if (entries.some((entry) => !reservationFiles.has(entry))) return false;
    unlinkSync(manifestPath);
    const reviewManifestPath = join(runDir, "implementation-review-reservation.json");
    if (existsSync(reviewManifestPath)) unlinkSync(reviewManifestPath);
    rmdirSync(runDir);
    return true;
  } catch {
    return false;
  }
}

export const FACTORY_RUN_ALLOCATION_ATTEMPTS = MAX_ALLOCATION_ATTEMPTS;

function formatRunTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-");
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSafeRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== "..";
}
