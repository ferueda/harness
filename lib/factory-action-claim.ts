import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

type FactoryActionClaim = {
  pid: number;
  hostname: string;
  token: string;
};

/** Serializes one provider action without holding the lifecycle projection lock. */
export async function withFactoryActionClaim<T>(input: {
  actionDir: string;
  resultPath: string;
  action: () => Promise<T>;
}): Promise<T | undefined> {
  mkdirSync(input.actionDir, { recursive: true });
  const claimPath = join(input.actionDir, "action-claim.json");
  const claim: FactoryActionClaim = {
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
  };
  while (true) {
    if (existsSync(input.resultPath)) return undefined;
    try {
      writeFileSync(claimPath, `${JSON.stringify(claim)}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    const owner = readClaim(claimPath);
    if (!owner) {
      if (!existsSync(claimPath)) continue;
      throw new Error(`Factory action claim is invalid: ${claimPath}`);
    }
    if (owner.hostname === hostname() && !isProcessAlive(owner.pid)) {
      unlinkSync(claimPath);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    return await input.action();
  } finally {
    const owner = readClaim(claimPath);
    if (owner?.token === claim.token) unlinkSync(claimPath);
  }
}

function readClaim(path: string): FactoryActionClaim | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<FactoryActionClaim>;
    return typeof value.pid === "number" &&
      typeof value.hostname === "string" &&
      typeof value.token === "string"
      ? (value as FactoryActionClaim)
      : undefined;
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isMissingError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
