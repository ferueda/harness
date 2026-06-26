import { expect, test } from "vitest";
import { isCodexAutomation, isCodexSubagent } from "../../../lib/sessions/codex/classify.ts";

const base = {
  threadId: "thread",
  title: "Thread",
  source: "cli",
  isSpawnChild: false,
};

test("isCodexSubagent uses structural spawn signals", () => {
  expect(isCodexSubagent({ ...base, isSpawnChild: true })).toBe(true);
  expect(
    isCodexSubagent({
      ...base,
      source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "parent" } } }),
    }),
  ).toBe(true);
  expect(isCodexSubagent({ ...base, threadSource: "subagent" })).toBe(true);
});

test("isCodexSubagent does not treat normal cli or bare role as subagent", () => {
  expect(isCodexSubagent(base)).toBe(false);
  expect(isCodexSubagent({ ...base, source: "vscode", agentRole: "explorer" })).toBe(false);
});

test("isCodexAutomation uses explicit automation signals only", () => {
  expect(isCodexAutomation({ ...base, title: "Automation: weekly review" })).toBe(true);
  expect(
    isCodexAutomation({
      ...base,
      firstUserQuery:
        "You are running as an automated worker. Hard requirements for your FINAL answer.",
    }),
  ).toBe(true);
  expect(isCodexAutomation({ ...base, source: "automation" })).toBe(true);
  expect(isCodexAutomation({ ...base, threadSource: "automation" })).toBe(true);
  expect(isCodexAutomation(base)).toBe(false);
});

test("isCodexAutomation checks raw first user text for stripped automation markers", () => {
  expect(
    isCodexAutomation({
      ...base,
      firstUserQuery: "Please review the changes.",
      rawFirstUserQuery:
        "<INSTRUCTIONS>\nYou are running as an automated worker.\n</INSTRUCTIONS>\n\nPlease review the changes.",
    }),
  ).toBe(true);
});
