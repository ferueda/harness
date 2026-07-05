import { expect, test } from "vitest";
import { createAgentSessionRef, normalizeAgentSessionForProvider } from "../lib/agent-session.ts";

test("createAgentSessionRef normalizes nonblank provider ids", () => {
  expect(createAgentSessionRef("cursor", " agent-123 ")).toEqual({
    provider: "cursor",
    id: "agent-123",
    raw: { kind: "cursor-agent" },
  });
});

test("createAgentSessionRef omits blank provider ids", () => {
  expect(createAgentSessionRef("codex", " ")).toBeUndefined();
  expect(createAgentSessionRef("codex", null)).toBeUndefined();
});

test("normalizeAgentSessionForProvider trims matching session ids", () => {
  expect(
    normalizeAgentSessionForProvider("cursor", {
      provider: "cursor",
      id: " agent-123 ",
      raw: { kind: "existing" },
    }),
  ).toEqual({
    ok: true,
    session: {
      provider: "cursor",
      id: "agent-123",
      raw: { kind: "existing" },
    },
  });
});

test("normalizeAgentSessionForProvider rejects provider mismatches", () => {
  expect(
    normalizeAgentSessionForProvider("codex", {
      provider: "cursor",
      id: "agent-123",
    }),
  ).toEqual({
    ok: false,
    error: {
      ok: false,
      error: "Cannot resume codex agent from cursor session",
      exitCode: 1,
    },
  });
});

test("normalizeAgentSessionForProvider rejects blank ids", () => {
  expect(
    normalizeAgentSessionForProvider("codex", {
      provider: "codex",
      id: " ",
    }),
  ).toEqual({
    ok: false,
    error: {
      ok: false,
      error: "Cannot resume codex agent with blank session id",
      exitCode: 1,
    },
  });
});
