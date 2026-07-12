import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertFactoryStoreFormat, ensureFactoryStoreFormat } from "./factory-store-format.ts";
import {
  isFactoryActionEvent,
  parseFactoryLifecycleEvent,
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

export class FactoryLifecycleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryLifecycleConflictError";
  }
}
export type AppendFactoryActionEventInput = {
  factoryStateRoot: string;
  event: FactoryLifecycleEvent;
  expectedLastEventId: string | null;
  lockOptions?: FactoryLockRuntimeOptions;
};

export function actionLifecycleEventPath(root: string, key: string): string {
  return join(resolve(root), "events", `${workItemKeyToFilename(key)}.jsonl`);
}
export function actionLifecycleStatePath(root: string, key: string): string {
  return join(resolve(root), "state", `${workItemKeyToFilename(key)}.json`);
}
export function readFactoryActionEvents(root: string, key: string): FactoryLifecycleEvent[] {
  assertFactoryStoreFormat(root);
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
  const event = parseFactoryLifecycleEvent(input.event);
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
      const events = readFactoryActionEvents(root, event.workItemKey);
      const existing = events.find((candidate) => candidate.id === event.id);
      if (existing) {
        if (canonicalFactoryEvent(existing) !== canonicalFactoryEvent(event))
          throw new FactoryLifecycleConflictError(
            `Factory event ${event.id} already exists with different content`,
          );
        return { event: existing, state: requiredState(events) };
      }
      const actual = events.at(-1)?.id ?? null;
      if (actual !== input.expectedLastEventId)
        throw new FactoryLifecycleConflictError(
          `Stale Factory cursor: expected ${String(input.expectedLastEventId)}, found ${String(actual)}`,
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
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
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
