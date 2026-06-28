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

test("parseCodexRolloutText rejects invalid json lines", () => {
  expect(() => parseCodexRolloutText(readFixture("codex-invalid.jsonl"))).toThrow(
    CodexRolloutParseError,
  );
});

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}
