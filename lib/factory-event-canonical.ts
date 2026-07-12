import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";

export function canonicalFactoryEvent(event: FactoryLifecycleEvent): string {
  const { occurredAt: _ignored, ...content } = event;
  return stable(content);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
