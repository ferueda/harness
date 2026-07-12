import { createHash } from "node:crypto";
import { FactoryWorkItemMetadataSchema, type FactoryWorkItem } from "./factory-schemas.ts";

export {
  FactoryLifecycleConflictError,
  actionLifecycleEventPath as factoryLifecycleEventPath,
  actionLifecycleStatePath as factoryLifecycleStatePath,
  appendFactoryActionEvent as appendFactoryLifecycleEvent,
  readFactoryActionEvents as readFactoryLifecycleEvents,
} from "./factory-lifecycle-kernel.ts";
export {
  FactoryLifecycleEventSchema,
  parseFactoryLifecycleEvent,
  type FactoryActionEvent,
  type FactoryLifecycleEvent,
} from "./factory-lifecycle-events.ts";
export {
  FactoryLifecycleStateSchema,
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
  type FactoryReaction,
} from "./factory-state-machine.ts";

export type FactoryLifecycleWarning = {
  code: string;
  message: string;
  factoryStateRoot?: string;
  workItemKey?: string;
};

export function deriveFactoryWorkItemKey(workItem: FactoryWorkItem): string {
  const metadata = FactoryWorkItemMetadataSchema.safeParse(workItem.metadata ?? {});
  const tracker = metadata.success ? metadata.data.tracker : undefined;
  if (workItem.id.includes(":")) return workItem.id;
  return tracker ? `${tracker.source}:${tracker.id}` : `${workItem.source}:${workItem.id}`;
}

export function workItemKeyToFilename(workItemKey: string): string {
  const readable =
    workItemKey
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "work-item";
  const hash = createHash("sha256").update(workItemKey).digest("hex").slice(0, 12);
  return `${readable}-${hash}`;
}
