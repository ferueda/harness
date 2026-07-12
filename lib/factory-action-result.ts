import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  FactoryLifecycleEventSchema,
  type FactoryActionEvent,
} from "./factory-lifecycle-events.ts";

export function factoryActionResultPath(actionDir: string): string {
  return join(actionDir, "action-result.json");
}
export function writeFactoryActionResult(actionDir: string, event: FactoryActionEvent): string {
  const parsed = FactoryLifecycleEventSchema.parse(event) as FactoryActionEvent;
  const path = factoryActionResultPath(actionDir);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  return path;
}
export function readFactoryActionResult(actionDir: string): FactoryActionEvent {
  return FactoryLifecycleEventSchema.parse(
    JSON.parse(readFileSync(factoryActionResultPath(actionDir), "utf8")),
  ) as FactoryActionEvent;
}
