import {
  closeSync,
  copyFileSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function writeDurableFactoryFile(path: string, data: string, exclusive = false): void {
  mkdirSync(dirname(path), { recursive: true });
  if (exclusive) {
    writeFileSync(path, data, { encoding: "utf8", flag: "wx" });
    syncFileAndDirectory(path);
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

function syncFileAndDirectory(path: string): void {
  syncFile(path);
  syncDirectory(dirname(path));
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
