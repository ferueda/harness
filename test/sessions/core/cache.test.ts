import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cursorCachePath, readCachedSessions } from "../../../lib/sessions/core/cache.ts";
import { makeSessionEnv, session } from "../helpers.ts";

test("readCachedSessions rejects cursor rows without transcript paths", () => {
  const env = makeSessionEnv();
  mkdirSync(env.cacheRoot, { recursive: true });
  const row = {
    ...session({ sessionId: "bad-cache-row" }),
    jsonlPath: undefined,
  };
  writeFileSync(cursorCachePath(env), `${JSON.stringify(row)}\n`, "utf8");

  expect(() => readCachedSessions(env)).toThrow(/Invalid session cache row/);
});

test("readCachedSessions rejects unknown fields", () => {
  const env = makeSessionEnv();
  mkdirSync(env.cacheRoot, { recursive: true });
  writeFileSync(
    cursorCachePath(env),
    `${JSON.stringify({ ...session({ sessionId: "extra" }), unexpected: true })}\n`,
    "utf8",
  );

  expect(() => readCachedSessions(env)).toThrow(/Invalid session cache row/);
});
