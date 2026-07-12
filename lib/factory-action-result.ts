import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseFactoryActionEvent, type FactoryActionEvent } from "./factory-lifecycle-events.ts";
import { canonicalFactoryEvent } from "./factory-event-canonical.ts";
import { assertFactoryActionEventIdentity } from "./factory-action-identity.ts";

export function factoryActionResultPath(actionDir: string): string {
  return join(actionDir, "action-result.json");
}
export function writeFactoryActionResult(actionDir: string, event: FactoryActionEvent): string {
  const parsed = parseFactoryActionEvent(event);
  assertFactoryActionResultIdentity(actionDir, parsed);
  const path = factoryActionResultPath(actionDir);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (
      canonicalFactoryEvent(readFactoryActionResult(actionDir)) !== canonicalFactoryEvent(parsed)
    ) {
      throw new Error(`Divergent Factory action result: ${path}`);
    }
    return path;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  const tempFd = openSync(temp, "r");
  try {
    fsyncSync(tempFd);
  } finally {
    closeSync(tempFd);
  }
  try {
    let published = false;
    try {
      // Hard-link publication is atomic and never replaces an existing result.
      linkSync(temp, path);
      published = true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    if (published) {
      const dirFd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    }
    if (!existsSync(path)) throw new Error(`Factory action result was not published: ${path}`);
    if (
      canonicalFactoryEvent(readFactoryActionResult(actionDir)) !== canonicalFactoryEvent(parsed)
    ) {
      throw new Error(`Divergent Factory action result: ${path}`);
    }
  } finally {
    unlinkSync(temp);
  }
  return path;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
export function readFactoryActionResult(actionDir: string): FactoryActionEvent {
  const event = parseFactoryActionEvent(
    JSON.parse(readFileSync(factoryActionResultPath(actionDir), "utf8")),
  );
  assertFactoryActionResultIdentity(actionDir, event);
  return event;
}

function assertFactoryActionResultIdentity(actionDir: string, event: FactoryActionEvent): void {
  const actionKey = assertFactoryActionEventIdentity(event);
  if (basename(actionDir) !== actionKey) throw new Error("Factory action result path mismatch");
}
