import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { defaultSessionEnvironment } from "../../lib/core/env.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("defaultSessionEnvironment migrates legacy cache directory", () => {
  const home = mkdtempSync(join(tmpdir(), "sessions-env-"));
  const legacyRoot = join(home, ".harness", "session-index");
  const cacheRoot = join(home, ".sessions", "index");
  mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(join(legacyRoot, "meta.json"), "{}\n", "utf8");

  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const env = defaultSessionEnvironment({ homeDir: home });

  expect(env.cacheRoot).toBe(cacheRoot);
  expect(stderr).toHaveBeenCalledWith(`migrated sessions cache from ${legacyRoot} to ${cacheRoot}`);
});

test("defaultSessionEnvironment honors SESSIONS_CACHE_DIR", () => {
  const home = mkdtempSync(join(tmpdir(), "sessions-env-"));
  const custom = join(home, "custom-cache");
  vi.stubEnv("SESSIONS_CACHE_DIR", custom);

  const env = defaultSessionEnvironment({ homeDir: home });
  expect(env.cacheRoot).toBe(custom);
});
