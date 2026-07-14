import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { assertFactoryStoreFormat, ensureFactoryStoreFormat } from "./factory-store-format.ts";
import {
  isFactoryActionEvent,
  parseFactoryLifecycleEvent,
  parseFactoryLifecycleEventForAppend,
  type FactoryLifecycleEvent,
} from "./factory-lifecycle-events.ts";
import {
  FactoryLifecycleStateSchema,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
} from "./factory-state-machine.ts";
import { withFactoryWorkItemLock, type FactoryLockRuntimeOptions } from "./factory-locks.ts";
import { canonicalFactoryEvent } from "./factory-event-canonical.ts";
import { assertFactoryActionEventIdentity } from "./factory-action-identity.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";

export class FactoryLifecycleConflictError extends Error {
  readonly reason: "divergent-event" | "stale-cursor";

  constructor(message: string, reason: "divergent-event" | "stale-cursor") {
    super(message);
    this.name = "FactoryLifecycleConflictError";
    this.reason = reason;
  }
}
export type AppendFactoryActionEventInput = {
  factoryStateRoot: string;
  event: FactoryLifecycleEvent;
  expectedLastEventId: string | null;
  lockOptions?: FactoryLockRuntimeOptions;
};

export type ReadFactoryActionEventsOptions = {
  mode?: "locked" | "inspection";
};

export function actionLifecycleEventPath(root: string, key: string): string {
  return join(resolve(root), "events", `${workItemKeyToFilename(key)}.jsonl`);
}
export function actionLifecycleStatePath(root: string, key: string): string {
  return join(resolve(root), "state", `${workItemKeyToFilename(key)}.json`);
}
export function readFactoryActionEvents(
  root: string,
  key: string,
  options: ReadFactoryActionEventsOptions = {},
): FactoryLifecycleEvent[] {
  const resolvedRoot = resolve(root);
  assertFactoryStoreFormat(resolvedRoot);
  if (!existsSync(actionLifecycleEventPath(resolvedRoot, key))) return [];
  if (options.mode === "inspection") return readFactoryActionEventsUnlocked(resolvedRoot, key);
  return withFactoryWorkItemLock(
    {
      factoryStateRoot: resolvedRoot,
      workItemKey: key,
      workItemFilename: workItemKeyToFilename(key),
      workspace: process.cwd(),
      operation: "read",
    },
    () => readFactoryActionEventsUnlocked(resolvedRoot, key),
  );
}
function readFactoryActionEventsUnlocked(root: string, key: string): FactoryLifecycleEvent[] {
  const path = actionLifecycleEventPath(root, key);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const event = parseFactoryLifecycleEvent(JSON.parse(line));
      if (isFactoryActionEvent(event)) assertFactoryActionEventIdentity(event);
      return event;
    });
}
export function appendFactoryActionEvent(input: AppendFactoryActionEventInput): {
  event: FactoryLifecycleEvent;
  state: FactoryLifecycleState;
} {
  const event = parseFactoryLifecycleEventForAppend(input.event);
  if (isFactoryActionEvent(event)) assertFactoryActionEventIdentity(event);
  const root = resolve(input.factoryStateRoot);
  ensureFactoryStoreFormat(root);
  return withFactoryWorkItemLock(
    {
      factoryStateRoot: root,
      workItemKey: event.workItemKey,
      workItemFilename: workItemKeyToFilename(event.workItemKey),
      workspace: process.cwd(),
      operation: "write",
      options: input.lockOptions,
    },
    () => {
      const events = readFactoryActionEventsUnlocked(root, event.workItemKey);
      const existing = events.find((candidate) => candidate.id === event.id);
      if (existing) {
        if (canonicalFactoryEvent(existing) !== canonicalFactoryEvent(event))
          throw new FactoryLifecycleConflictError(
            `Factory event ${event.id} already exists with different content`,
            "divergent-event",
          );
        return { event: existing, state: requiredState(events) };
      }
      const actual = events.at(-1)?.id ?? null;
      if (actual !== input.expectedLastEventId)
        throw new FactoryLifecycleConflictError(
          `Stale Factory cursor: expected ${String(input.expectedLastEventId)}, found ${String(actual)}`,
          "stale-cursor",
        );
      const state = requiredState([...events, event]);
      appendAndSync(actionLifecycleEventPath(root, event.workItemKey), event);
      writeAtomic(
        actionLifecycleStatePath(root, event.workItemKey),
        FactoryLifecycleStateSchema.parse(state),
      );
      return { event, state };
    },
  );
}
function requiredState(events: readonly FactoryLifecycleEvent[]): FactoryLifecycleState {
  const state = reduceFactoryLifecycleEvents(events);
  if (!state) throw new Error("Factory event log produced no state");
  return state;
}
function appendAndSync(path: string, event: FactoryLifecycleEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  const creating = !existsSync(path);
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (creating) {
    const directoryFd = openSync(dirname(path), "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
}
function writeAtomic(path: string, value: unknown): void {
  writeDurableFactoryFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function workItemKeyToFilename(workItemKey: string): string {
  const readable =
    workItemKey
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "work-item";
  return `${readable}-${createHash("sha256").update(workItemKey).digest("hex").slice(0, 12)}`;
}
