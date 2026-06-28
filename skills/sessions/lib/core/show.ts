import type { Transcript, Turn } from "./types.ts";

export type RenderTranscriptOptions = {
  maxToolChars?: number;
};

export function renderTranscriptMarkdown(
  transcript: Transcript,
  options: RenderTranscriptOptions = {},
): string {
  const maxToolChars = options.maxToolChars ?? 2_000;
  const lines = [
    `# Session ${transcript.session.sessionId}`,
    "",
    `- provider: ${transcript.session.provider}`,
    `- workspace: ${transcript.session.workspacePath} (${transcript.session.workspacePathConfidence})`,
    `- automation: ${String(transcript.session.isAutomation)}`,
    `- subagent: ${String(transcript.session.isSubagent)}`,
    "",
  ];

  for (const turn of transcript.turns) {
    lines.push(`## ${turn.role}`, "", renderTurnText(turn, maxToolChars), "");
  }

  return `${lines.join("\n").trim()}\n`;
}

function renderTurnText(turn: Turn, maxToolChars: number): string {
  if (turn.text.length <= maxToolChars) return turn.text;
  return `${turn.text.slice(0, maxToolChars)}\n\n[truncated ${turn.text.length - maxToolChars} chars]`;
}
