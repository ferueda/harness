import type { Transcript, Turn } from "./types.ts";

export type RenderTranscriptOptions = {
  maxToolChars?: number;
  turn?: number;
  context?: number;
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

  if (options.turn === undefined) {
    for (const turn of transcript.turns) {
      lines.push(`## ${turn.role}`, "", renderTurnText(turn, maxToolChars), "");
    }
    return `${lines.join("\n").trim()}\n`;
  }

  const selectedTurn = options.turn;
  if (selectedTurn >= transcript.turns.length) {
    throw new Error(
      `Turn ${selectedTurn} is out of range for session ${transcript.session.sessionId}; valid indices are 0-${Math.max(0, transcript.turns.length - 1)}`,
    );
  }
  const context = options.context ?? 0;
  const start = Math.max(0, selectedTurn - context);
  const end = Math.min(transcript.turns.length, selectedTurn + context + 1);
  for (const [turnIndex, turn] of transcript.turns.slice(start, end).entries()) {
    const originalIndex = start + turnIndex;
    lines.push(
      `## turn ${originalIndex}: ${turn.role}`,
      "",
      renderTurnText(turn, maxToolChars),
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderTurnText(turn: Turn, maxToolChars: number): string {
  if (turn.text.length <= maxToolChars) return turn.text;
  return `${turn.text.slice(0, maxToolChars)}\n\n[truncated ${turn.text.length - maxToolChars} chars]`;
}
