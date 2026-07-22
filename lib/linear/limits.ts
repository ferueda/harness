import { LinearError } from "./error.ts";
import type { LinearReadLimits } from "./types.ts";

export function normalizeLimits(input: LinearReadLimits): LinearReadLimits {
  const entries = Object.entries(input ?? {}) as Array<[keyof LinearReadLimits, unknown]>;
  const requiredKeys: Array<keyof LinearReadLimits> = [
    "comments",
    "labels",
    "relations",
    "attachments",
    "children",
  ];
  const values = Object.fromEntries(entries) as Partial<Record<keyof LinearReadLimits, unknown>>;
  for (const key of requiredKeys) {
    const value = values[key];
    if (!Number.isInteger(value) || Number(value) < 1) {
      throw new LinearError("invalid-config", `Linear ${key} limit must be a positive integer.`);
    }
  }
  return Object.freeze({
    comments: Number(values.comments),
    labels: Number(values.labels),
    relations: Number(values.relations),
    attachments: Number(values.attachments),
    children: Number(values.children),
  });
}
