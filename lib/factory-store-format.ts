import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { formatZodError } from "./schemas.ts";

export const FACTORY_STORE_FORMAT = 1 as const;
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
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw incompatible(root, "lifecycle directory has data but no format marker");
  }
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(marker, `${JSON.stringify({ format: "harness-factory", version: 1 })}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    // Another process may have initialized the same empty root.
    if (!existsSync(marker)) throw error;
    const parsed = FactoryStoreFormatSchema.safeParse(JSON.parse(readFileSync(marker, "utf8")));
    if (!parsed.success) throw incompatible(root, formatZodError(parsed.error), parsed.error);
  }
}

/** Validate an existing store without initializing an empty or absent root. */
export function assertFactoryStoreFormat(factoryStateRoot: string): void {
  const root = resolve(factoryStateRoot);
  const marker = join(root, FACTORY_STORE_FORMAT_FILE);
  if (!existsSync(marker)) {
    if (!existsSync(root) || readdirSync(root).length === 0) return;
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
