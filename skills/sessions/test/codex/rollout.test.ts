import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CodexRolloutParseError, parseCodexRolloutText } from "../../lib/codex/rollout.ts";
import { FIXTURES } from "../helpers.ts";

test("parseCodexRolloutText extracts user and assistant turns", () => {
  const parsed = parseCodexRolloutText(readFixture("codex-real-user.jsonl"));

  expect(parsed.firstUserQuery).toBe("Please verify the Codex provider works.");
  expect(parsed.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
});

test("parseCodexRolloutText skips unknown and developer-only events", () => {
  const parsed = parseCodexRolloutText(readFixture("codex-unknown-events.jsonl"));

  expect(parsed.turns.map((turn) => turn.role)).toEqual(["user", "tool"]);
  expect(parsed.firstUserQuery).toBe("Keep this user text.");
});

test("parseCodexRolloutText canonicalizes adjacent event and response message pairs", () => {
  const parsed = parseCodexRolloutText(`
{"type":"event_msg","payload":{"type":"user_message","message":"Check the paired rollout."}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Check the paired rollout."}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Paired response."}]}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Paired response."}}
`);

  expect(parsed.firstUserQuery).toBe("Check the paired rollout.");
  expect(parsed.turns).toEqual([
    { role: "user", text: "Check the paired rollout.", rawText: "Check the paired rollout." },
    { role: "assistant", text: "Paired response.", rawText: "Paired response." },
  ]);
});

test("parseCodexRolloutText preserves source-only and same-source messages", () => {
  const parsed = parseCodexRolloutText(`
{"type":"event_msg","payload":{"type":"user_message","message":"Event only."}}
{"type":"event_msg","payload":{"type":"user_message","message":"Event only."}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Response only."}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Response only."}]}}
`);

  expect(parsed.turns.map((turn) => [turn.role, turn.text])).toEqual([
    ["user", "Event only."],
    ["user", "Event only."],
    ["assistant", "Response only."],
    ["assistant", "Response only."],
  ]);
});

test("parseCodexRolloutText keeps tool and system interruptions with rollout provenance", () => {
  const parsed = parseCodexRolloutText(`
{"type":"event_msg","payload":{"type":"user_message","message":"Keep the tool boundary."}}
{"type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Keep the tool boundary."}]}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Keep the system boundary."}}
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Keep the system boundary."}]}}
`);

  expect(parsed.turns).toEqual([
    { role: "user", text: "Keep the tool boundary.", rawText: "Keep the tool boundary." },
    {
      role: "tool",
      text: 'read_file {"path":"README.md"}',
      rawText: 'read_file {"path":"README.md"}',
    },
    { role: "user", text: "Keep the tool boundary.", rawText: "Keep the tool boundary." },
    {
      role: "assistant",
      text: "Keep the system boundary.",
      rawText: "Keep the system boundary.",
    },
    { role: "system", text: "Task started", rawText: "Task started" },
    {
      role: "assistant",
      text: "Keep the system boundary.",
      rawText: "Keep the system boundary.",
    },
  ]);
});

test("parseCodexRolloutText rejects invalid json lines", () => {
  expect(() => parseCodexRolloutText(readFixture("codex-invalid.jsonl"))).toThrow(
    CodexRolloutParseError,
  );
});

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}
