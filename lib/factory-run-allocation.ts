import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_ALLOCATION_ATTEMPTS = 8;

export type FactoryRunAllocation = {
  runId: string;
  runDir: string;
  reservationToken: string;
};

export class FactoryRunAllocationError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryRunAllocationError";
  }
}

export function allocateFactoryRun(input: {
  factoryRunsDir: string;
  idPrefix?: string;
  now?: () => Date;
  random?: () => string;
}): FactoryRunAllocation {
  const root = resolve(input.factoryRunsDir);
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new FactoryRunAllocationError(`Cannot create Factory runs root: ${root}`, {
      cause: error,
    });
  }
  const now = input.now ?? (() => new Date());
  const random = input.random ?? (() => randomBytes(6).toString("hex"));
  const prefix = input.idPrefix ?? "run";
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const runId = `${prefix}-${formatRunTimestamp(now())}-${random()}`;
    const runDir = join(root, runId);
    try {
      mkdirSync(runDir);
      return { runId, runDir, reservationToken: randomBytes(16).toString("hex") };
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
}): boolean {
  // The token is supplied by the owning caller; no token is persisted before the
  // identity manifest, so an untouched directory is the only safe pre-manifest state.
  void input.reservationToken;
  try {
    if (readdirSync(input.runDir).length !== 0) return false;
    rmSync(input.runDir, { recursive: false, force: false });
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
