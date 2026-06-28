import { expect, test } from "vitest";
import { isAutomationSession, isSubagentSession } from "../../lib/cursor/classify.ts";

test("detects harness automation workers", () => {
  const firstUserQuery = "You are running as an automated worker invoked by another agent.";
  expect(isAutomationSession(firstUserQuery)).toBe(true);
  expect(isSubagentSession("abc", firstUserQuery)).toBe(true);
});

test("detects final-answer worker templates without subagent marker", () => {
  const firstUserQuery = "Hard requirements for your FINAL answer:\n- Return only JSON.";
  expect(isAutomationSession(firstUserQuery)).toBe(true);
  expect(isSubagentSession("abc", firstUserQuery)).toBe(false);
});

test("detects agent-prefixed subagent sessions", () => {
  expect(isSubagentSession("agent-123", "normal task")).toBe(true);
  expect(isAutomationSession("normal task")).toBe(false);
});

test("does not flag ordinary user sessions", () => {
  const firstUserQuery = "Please review this implementation for clarity.";
  expect(isAutomationSession(firstUserQuery)).toBe(false);
  expect(isSubagentSession("chat-123", firstUserQuery)).toBe(false);
});
