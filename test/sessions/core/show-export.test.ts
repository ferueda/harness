import { expect, test } from "vitest";
import { exportTranscript } from "../../../lib/sessions/core/export.ts";
import { renderTranscriptMarkdown } from "../../../lib/sessions/core/show.ts";
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

test("exportTranscript supports markdown, json, and jsonl", () => {
  const sample = transcript({ sessionId: "export-session" });

  expect(exportTranscript(sample, "md")).toContain("# Session export-session");
  expect(JSON.parse(exportTranscript(sample, "json")).session.sessionId).toBe("export-session");
  expect(exportTranscript(sample, "jsonl").trim().split("\n")).toHaveLength(2);
});
