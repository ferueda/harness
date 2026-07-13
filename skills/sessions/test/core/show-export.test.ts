import { expect, test } from "vitest";
import { exportTranscript } from "../../lib/core/export.ts";
import { renderTranscriptMarkdown } from "../../lib/core/show.ts";
import { transcript } from "../helpers.ts";

test("renderTranscriptMarkdown includes metadata and truncates long turns", () => {
  const rendered = renderTranscriptMarkdown(
    {
      ...transcript({ sessionId: "show-session" }),
      turns: [{ role: "tool", text: "abcdef", rawText: "abcdef" }],
    },
    { maxToolChars: 3 },
  );

  expect(rendered).toContain("# Session show-session");
  expect(rendered).toContain("- provider: cursor");
  expect(rendered).toContain("abc\n\n[truncated 3 chars]");
});

test("renderTranscriptMarkdown renders bounded context with canonical turn indices", () => {
  const rendered = renderTranscriptMarkdown(
    {
      ...transcript({ sessionId: "show-session" }),
      turns: [
        { role: "user", text: "first", rawText: "first" },
        { role: "assistant", text: "second", rawText: "second" },
        { role: "tool", text: "abcdef", rawText: "abcdef" },
        { role: "user", text: "fourth", rawText: "fourth" },
      ],
    },
    { turn: 2, context: 1, maxToolChars: 3 },
  );

  expect(rendered).toContain("## turn 1: assistant");
  expect(rendered).toContain("## turn 2: tool\n\nabc\n\n[truncated 3 chars]");
  expect(rendered).toContain("## turn 3: user");
  expect(rendered).not.toContain("## turn 0:");
});

test("renderTranscriptMarkdown rejects an out-of-range turn", () => {
  expect(() =>
    renderTranscriptMarkdown(transcript({ sessionId: "show-session" }), { turn: 2 }),
  ).toThrow("Turn 2 is out of range for session show-session");
  expect(() =>
    renderTranscriptMarkdown(transcript({ sessionId: "show-session" }), { turn: -1 }),
  ).toThrow("Turn -1 is out of range for session show-session");
});

test("exportTranscript supports markdown, json, and jsonl", () => {
  const sample = transcript({ sessionId: "export-session" });

  expect(exportTranscript(sample, "md")).toContain("# Session export-session");
  expect(JSON.parse(exportTranscript(sample, "json")).session.sessionId).toBe("export-session");
  expect(exportTranscript(sample, "jsonl").trim().split("\n")).toHaveLength(2);
});
