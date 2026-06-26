import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  codexCachePath,
  cursorCachePath,
  readCacheMeta,
  readCachedSessions,
  writeCodexCache,
  writeCursorCache,
} from "../../../lib/sessions/core/cache.ts";
import { getCursorIndexStats } from "../../../lib/sessions/cursor/stats.ts";
import { codexSession, makeSessionEnv, session } from "../helpers.ts";

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

test("readCachedSessions accepts rows without workspace path source", () => {
  const env = makeSessionEnv();
  mkdirSync(env.cacheRoot, { recursive: true });
  const row = session({
    sessionId: "legacy-source",
  });
  delete row.workspacePathSource;
  writeFileSync(cursorCachePath(env), `${JSON.stringify(row)}\n`, "utf8");

  expect(readCachedSessions(env)).toHaveLength(1);
});

test("readCachedSessions reads provider-specific codex rows", () => {
  const env = makeSessionEnv();
  writeCodexCache(env, {
    provider: "codex",
    schemaVersion: 1,
    lastReindexAt: "2026-06-26T00:00:00.000Z",
    transcriptsFound: 1,
    indexedSessions: 1,
    skipped: 0,
    skippedUnparseable: 0,
    sessions: [codexSession({ sessionId: "codex-one" })],
  });

  expect(readCachedSessions(env, "codex").map((row) => row.sessionId)).toEqual(["codex-one"]);
  expect(readCachedSessions(env)).toEqual([]);
});

test("readCachedSessions rejects malformed codex rows", () => {
  const env = makeSessionEnv();
  mkdirSync(env.cacheRoot, { recursive: true });
  const row = {
    ...codexSession({ sessionId: "bad-codex-row" }),
    rolloutPath: undefined,
  };
  writeFileSync(codexCachePath(env), `${JSON.stringify(row)}\n`, "utf8");

  expect(() => readCachedSessions(env, "codex")).toThrow(/Invalid session cache row/);
});

test("readCachedSessions rejects unknown codex fields", () => {
  const env = makeSessionEnv();
  mkdirSync(env.cacheRoot, { recursive: true });
  writeFileSync(
    codexCachePath(env),
    `${JSON.stringify({ ...codexSession({ sessionId: "extra-codex" }), unexpected: true })}\n`,
    "utf8",
  );

  expect(() => readCachedSessions(env, "codex")).toThrow(/Invalid session cache row/);
});

test("cursor and codex caches do not overwrite each other", () => {
  const env = makeSessionEnv();
  writeCursorCache(env, {
    provider: "cursor",
    schemaVersion: 1,
    lastReindexAt: "2026-06-26T00:00:00.000Z",
    transcriptsFound: 1,
    indexedSessions: 1,
    skipped: 0,
    skippedUnparseable: 0,
    sessions: [session({ sessionId: "cursor-one" })],
  });
  writeCodexCache(env, {
    provider: "codex",
    schemaVersion: 1,
    lastReindexAt: "2026-06-26T00:00:00.000Z",
    transcriptsFound: 1,
    indexedSessions: 1,
    skipped: 0,
    skippedUnparseable: 0,
    sessions: [codexSession({ sessionId: "codex-one" })],
  });

  expect(readCachedSessions(env, "cursor").map((row) => row.sessionId)).toEqual(["cursor-one"]);
  expect(readCachedSessions(env, "codex").map((row) => row.sessionId)).toEqual(["codex-one"]);
  expect(cursorCachePath(env)).not.toBe(codexCachePath(env));
});

test("readCacheMeta falls back to legacy Cursor meta.json", () => {
  const env = makeSessionEnv();
  mkdirSync(env.cacheRoot, { recursive: true });
  writeFileSync(
    cursorCachePath(env),
    `${JSON.stringify(session({ sessionId: "legacy" }))}\n`,
    "utf8",
  );
  writeFileSync(
    join(env.cacheRoot, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      provider: "cursor",
      lastReindexAt: "2026-06-25T00:00:00.000Z",
      counts: {
        transcriptsFound: 3,
        indexedSessions: 1,
        skippedUnparseable: 2,
      },
    }),
    "utf8",
  );

  expect(readCacheMeta(env, "cursor")).toMatchObject({
    lastReindexAt: "2026-06-25T00:00:00.000Z",
    counts: { transcriptsFound: 3, skippedUnparseable: 2 },
  });
  expect(getCursorIndexStats(env)).toMatchObject({
    lastReindexAt: "2026-06-25T00:00:00.000Z",
    transcriptsFound: 3,
    skippedUnparseable: 2,
  });
});
