import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseTranscriptText } from "../../lib/cursor/transcript.ts";
import { FIXTURES } from "../helpers.ts";

test("parses roles and extracts user_query", () => {
  const parsed = parseTranscriptText(
    readFileSync(join(FIXTURES, "cursor-real-user.jsonl"), "utf8"),
  );
  expect(parsed.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(parsed.firstUserQuery).toBe("Please prefer concise status updates in this repo.");
  expect(parsed.turns[0]?.text).toBe("Please prefer concise status updates in this repo.");
});

test("extracts explicit workspace path from user_info", () => {
  const parsed = parseTranscriptText(
    readFileSync(join(FIXTURES, "cursor-hyphenated-workspace.jsonl"), "utf8"),
  );
  expect(parsed.workspacePath).toEqual({
    path: "/Users/alice/dev/my-repo",
    confidence: "explicit",
    source: "transcript",
  });
});

test("handles user messages without user_query tags", () => {
  const parsed = parseTranscriptText(
    '{"role":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n',
  );
  expect(parsed.firstUserQuery).toBe("hello");
  expect(parsed.turns[0]?.text).toBe("hello");
});
