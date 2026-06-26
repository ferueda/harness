import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  codexStateDbPath,
  resolveCodexRolloutPath,
  workspaceKeyForCodexPath,
} from "../../../lib/sessions/codex/paths.ts";
import { makeSessionEnv, writeCodexStateDb } from "../helpers.ts";

test("codexStateDbPath prefers root state database", () => {
  const env = makeSessionEnv();
  const root = writeCodexStateDb(env, []);
  writeCodexStateDb(env, [], { fallbackOnly: true });

  expect(codexStateDbPath(env)).toBe(root);
});

test("codexStateDbPath falls back to sqlite directory when root is missing", () => {
  const env = makeSessionEnv();
  const fallback = writeCodexStateDb(env, [], { fallbackOnly: true });

  expect(codexStateDbPath(env)).toBe(fallback);
});

test("resolveCodexRolloutPath resolves relative archived paths under codex home", () => {
  const env = makeSessionEnv();
  const expected = join(env.codexHome, "archived_sessions", "rollout.jsonl");
  mkdirSync(join(env.codexHome, "archived_sessions"), { recursive: true });

  expect(resolveCodexRolloutPath(env, "archived_sessions/rollout.jsonl")).toBe(expected);
});

test("resolveCodexRolloutPath resolves relative session paths under codex home", () => {
  const env = makeSessionEnv();
  const expected = join(env.codexHome, "sessions", "rollout.jsonl");
  mkdirSync(join(env.codexHome, "sessions"), { recursive: true });

  expect(resolveCodexRolloutPath(env, "sessions/rollout.jsonl")).toBe(expected);
});

test("resolveCodexRolloutPath preserves absolute paths", () => {
  const env = makeSessionEnv();
  const absolute = join(env.homeDir, "rollout.jsonl");

  expect(resolveCodexRolloutPath(env, absolute)).toBe(absolute);
});

test("workspaceKeyForCodexPath creates stable readable keys", () => {
  expect(workspaceKeyForCodexPath("/Users/example/dev/my repo")).toBe("Users-example-dev-my-repo");
  expect(workspaceKeyForCodexPath("")).toBe("home");
});
