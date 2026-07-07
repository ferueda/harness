import { expect, test } from "vitest";

// The proxy is a runnable .mjs script; import only exported pure helpers here.
// @ts-expect-error no declaration file for this local script
const { auditRequest, decodeResponse, renderAudit } = await import("../scripts/codex-proxy.mjs");

const sseResponse = [
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"Ready."}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":17862,"input_tokens_details":{"cached_tokens":17792},"output_tokens":6,"total_tokens":17868}}}',
  "",
].join("\n");

test("decodeResponse extracts usage from SSE even when content-type is not event-stream", () => {
  const decoded = decodeResponse(sseResponse, "text/plain");

  expect(decoded.usage).toEqual({
    input_tokens: 17862,
    input_tokens_details: { cached_tokens: 17792 },
    output_tokens: 6,
    total_tokens: 17868,
  });
  expect(decoded.markdown).toContain("Ready.");
});

test("renderAudit reports cached tokens and input byte contributors", () => {
  const audit = auditRequest(
    {
      instructions: "system prompt",
      tools: [{ type: "function", name: "exec_command", description: "Run shell command" }],
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "large developer context" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "test\n" }],
        },
      ],
    },
    {
      input_tokens: 17862,
      input_tokens_details: { cached_tokens: 17792 },
    },
  );

  const rendered = renderAudit(audit);

  expect(rendered).toContain("17,862 input tokens");
  expect(rendered).toContain("17,792 cached, 70 uncached");
  expect(rendered).toContain("| input | role | json bytes | text bytes | text parts |");
  expect(rendered).toContain("| 1 | developer |");
  expect(rendered).toContain("| 2 | user |");
  expect(rendered).toContain("large developer context");
});
