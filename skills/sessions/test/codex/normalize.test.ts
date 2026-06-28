import { expect, test } from "vitest";
import { cleanCodexUserMessage } from "../../lib/codex/normalize.ts";

test("cleanCodexUserMessage strips leading AGENTS and instructions preambles", () => {
  expect(
    cleanCodexUserMessage(
      "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nIgnore me.\n</INSTRUCTIONS>\n\nKeep this ask.",
    ),
  ).toBe("Keep this ask.");
});

test("cleanCodexUserMessage strips leading system instruction preambles", () => {
  expect(
    cleanCodexUserMessage(
      "<SYSTEM_INSTRUCTION>\nInjected conductor context.\n</SYSTEM_INSTRUCTION>\n\nImplement the plan.",
    ),
  ).toBe("Implement the plan.");
});

test("cleanCodexUserMessage strips consecutive leading injected preambles", () => {
  expect(
    cleanCodexUserMessage(
      "<system_instruction>\nConductor context.\n</system_instruction>\n\n<system_instruction>\nAttached files.\n</system_instruction>\n\nCreate a PR",
    ),
  ).toBe("Create a PR");
});

test("cleanCodexUserMessage preserves non-leading injected-context references", () => {
  expect(cleanCodexUserMessage("Please review AGENTS.md for this repo.")).toBe(
    "Please review AGENTS.md for this repo.",
  );
});
