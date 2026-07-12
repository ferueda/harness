import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeDurableFactoryFile } from "../lib/factory-durable-file.ts";

test("exclusive durable publication accepts an identical existing file", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-durable-"));
  const path = join(root, "identity.json");

  writeDurableFactoryFile(path, "same\n", true);
  writeDurableFactoryFile(path, "same\n", true);

  expect(readFileSync(path, "utf8")).toBe("same\n");
  expect(readdirSync(root)).toEqual(["identity.json"]);
});

test("exclusive durable publication rejects an interrupted conflicting destination", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-durable-"));
  const path = join(root, "identity.json");
  writeDurableFactoryFile(path, "partial", true);

  expect(() => writeDurableFactoryFile(path, "complete\n", true)).toThrow(
    `Divergent durable Factory file: ${path}`,
  );
  expect(readFileSync(path, "utf8")).toBe("partial");
  expect(readdirSync(root)).toEqual(["identity.json"]);
});
