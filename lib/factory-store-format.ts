import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { formatZodError } from "./schemas.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";

export const FACTORY_STORE_FORMAT = 3 as const;
export const FACTORY_STORE_FORMAT_FILE = "store-format.json";

const FactoryStoreFormatSchema = z
  .object({ format: z.literal("harness-factory"), version: z.literal(FACTORY_STORE_FORMAT) })
  .strict();

export class FactoryStoreFormatError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryStoreFormatError";
  }
}

export function ensureFactoryStoreFormat(factoryStateRoot: string): void {
  const root = resolve(factoryStateRoot);
  const marker = join(root, FACTORY_STORE_FORMAT_FILE);
  if (existsSync(marker)) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(marker, "utf8"));
    } catch (error) {
      throw incompatible(root, "format marker is not valid JSON", error);
    }
    const parsed = FactoryStoreFormatSchema.safeParse(value);
    if (!parsed.success) throw incompatible(root, formatZodError(parsed.error), parsed.error);
    return;
  }
  const entries = existsSync(root) ? readdirSync(root) : [];
  if (entries.includes(FACTORY_STORE_FORMAT_FILE)) {
    ensureFactoryStoreFormat(root);
    return;
  }
  if (!entries.every(isOrphanedMarkerTemp)) {
    throw incompatible(root, "lifecycle directory has data but no format marker");
  }
  mkdirSync(root, { recursive: true });
  try {
    writeDurableFactoryFile(
      marker,
      `${JSON.stringify({ format: "harness-factory", version: FACTORY_STORE_FORMAT })}\n`,
      true,
    );
  } catch (error) {
    // Another process may have initialized the same empty root.
    if (!existsSync(marker)) throw error;
    const parsed = FactoryStoreFormatSchema.safeParse(JSON.parse(readFileSync(marker, "utf8")));
    if (!parsed.success) throw incompatible(root, formatZodError(parsed.error), parsed.error);
  }
}

function isOrphanedMarkerTemp(name: string): boolean {
  return /^store-format\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(
    name,
  );
}

/** Validate an existing store without initializing an empty or absent root. */
export function assertFactoryStoreFormat(factoryStateRoot: string): void {
  const root = resolve(factoryStateRoot);
  const marker = join(root, FACTORY_STORE_FORMAT_FILE);
  if (!existsSync(marker)) {
    const entries = existsSync(root) ? readdirSync(root) : [];
    if (entries.includes(FACTORY_STORE_FORMAT_FILE)) {
      assertFactoryStoreFormat(root);
      return;
    }
    if (entries.every(isOrphanedMarkerTemp)) return;
    throw incompatible(root, "lifecycle directory has data but no format marker");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(marker, "utf8"));
  } catch (error) {
    throw incompatible(root, "format marker is not valid JSON", error);
  }
  const parsed = FactoryStoreFormatSchema.safeParse(value);
  if (!parsed.success) throw incompatible(root, formatZodError(parsed.error), parsed.error);
}

function incompatible(root: string, reason: string, cause?: unknown): FactoryStoreFormatError {
  return new FactoryStoreFormatError(
    `Incompatible Factory state at ${root}: ${reason}. Archive or reset this directory before using the new Factory store format; Harness will not migrate or delete it.`,
    { cause },
  );
}
