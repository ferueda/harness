import {
  closeSync,
  copyFileSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function writeDurableFactoryFile(
  path: string,
  data: string | Uint8Array,
  exclusive = false,
): void {
  mkdirSync(dirname(path), { recursive: true });
  if (exclusive) {
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, data, "utf8");
    syncFile(temp);
    try {
      try {
        linkSync(temp, path);
        syncDirectory(dirname(path));
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        const existing = readFileSync(path);
        const expected = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
        if (!existing.equals(expected)) {
          throw new Error(`Divergent durable Factory file: ${path}`);
        }
      }
    } finally {
      unlinkSync(temp);
    }
    return;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, data, "utf8");
  syncFile(temp);
  renameSync(temp, path);
  syncDirectory(dirname(path));
}

export function copyDurableFactoryFile(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.${randomUUID()}.tmp`;
  copyFileSync(source, temp);
  syncFile(temp);
  try {
    linkSync(temp, destination);
    syncDirectory(dirname(destination));
  } finally {
    unlinkSync(temp);
  }
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
