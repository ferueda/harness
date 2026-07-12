import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  if (existsSync(path)) {
    if (JSON.stringify(readFactoryActionResult(actionDir)) !== JSON.stringify(parsed)) {
      throw new Error(`Divergent Factory action result: ${path}`);
    }
    return path;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  try {
    writeFileSync(path, readFileSync(temp), { flag: "wx" });
  } catch (error) {
    if (!existsSync(path)) throw error;
    if (JSON.stringify(readFactoryActionResult(actionDir)) !== JSON.stringify(parsed)) {
      throw new Error(`Divergent Factory action result: ${path}`);
    }
  } finally {
    unlinkSync(temp);
  }
  return path;
}
export function readFactoryActionResult(actionDir: string): FactoryActionEvent {
  return FactoryLifecycleEventSchema.parse(
    JSON.parse(readFileSync(factoryActionResultPath(actionDir), "utf8")),
  ) as FactoryActionEvent;
}
