import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupOrphanedRunDir } from "../lib/workflow-context.js";

test("cleanupOrphanedRunDir removes incomplete run directories", () => {
  const runDir = mkdtempSync(join(tmpdir(), "harness-orphaned-run-"));
  mkdirSync(join(runDir, "context"));

  assert.equal(cleanupOrphanedRunDir(runDir), true);
  assert.equal(existsSync(runDir), false);
});

test("cleanupOrphanedRunDir preserves runs with metadata", () => {
  const runDir = mkdtempSync(join(tmpdir(), "harness-run-"));
  writeFileSync(join(runDir, "meta.json"), "{}\n", "utf8");

  assert.equal(cleanupOrphanedRunDir(runDir), false);
  assert.equal(existsSync(runDir), true);
});
