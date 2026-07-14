import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  MAX_FACTORY_CONTINUATION_RESPONSE_BYTES,
  readFactoryContinuationResponseFile,
  validateFactoryContinuationResponse,
} from "../lib/factory-continuation.ts";

test("continuation responses preserve accepted UTF-8 bytes within the bound", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-continuation-"));
  const path = join(root, "response.md");
  const response = "Accepted proof: café.\n";
  writeFileSync(path, response);

  expect(readFactoryContinuationResponseFile(path)).toBe(response);
  expect(
    validateFactoryContinuationResponse("x".repeat(MAX_FACTORY_CONTINUATION_RESPONSE_BYTES)),
  ).toHaveLength(MAX_FACTORY_CONTINUATION_RESPONSE_BYTES);
});

test("continuation responses reject relative, blank, and oversized input", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-continuation-"));
  const invalid = join(root, "invalid.md");
  writeFileSync(invalid, Buffer.from([0xff]));

  expect(() => readFactoryContinuationResponseFile("response.md")).toThrow(/absolute/);
  expect(() => readFactoryContinuationResponseFile(invalid)).toThrow(/valid UTF-8/);
  expect(() => validateFactoryContinuationResponse(" \n\t")).toThrow(/blank/);
  expect(() =>
    validateFactoryContinuationResponse("x".repeat(MAX_FACTORY_CONTINUATION_RESPONSE_BYTES + 1)),
  ).toThrow(/exceeds/);
});
