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
import { factoryActionKey, type FactoryPhase } from "./factory-action-contract.ts";

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
    // Hard-link publication is atomic and never replaces an existing result.
    linkSync(temp, path);
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (!existsSync(path)) throw error;
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
export function readFactoryActionResult(actionDir: string): FactoryActionEvent {
  const event = parseFactoryActionEvent(
    JSON.parse(readFileSync(factoryActionResultPath(actionDir), "utf8")),
  );
  assertFactoryActionResultIdentity(actionDir, event);
  return event;
}

function assertFactoryActionResultIdentity(actionDir: string, event: FactoryActionEvent): void {
  const actionKey = factoryActionKey({
    phaseRunId: event.phaseRunId,
    handler: event.data.handler,
    attempt: event.data.attempt,
    causationEventId: event.data.causationEventId,
  });
  const expectedId = `${event.type}:${actionKey}`;
  if (basename(actionDir) !== actionKey || event.id !== expectedId) {
    throw new Error(`Factory action result identity mismatch: expected ${expectedId}`);
  }
  if (event.type === "factory.action.failed" && event.data.phase !== actionEventPhase(event)) {
    throw new Error("Factory action result phase mismatch");
  }
}

function actionEventPhase(event: FactoryActionEvent): FactoryPhase {
  if (event.type === "factory.action.failed") {
    if (event.data.handler === "triageWorkItem") return "triage";
    if (event.data.handler.includes("Plan")) return "planning";
    return "implementation";
  }
  if (event.type.startsWith("triage.")) return "triage";
  if (event.type.startsWith("planning.")) return "planning";
  return "implementation";
}
