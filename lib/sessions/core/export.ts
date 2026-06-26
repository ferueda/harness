import { renderTranscriptMarkdown } from "./show.ts";
import type { ExportFormat, Transcript } from "./types.ts";

export function exportTranscript(transcript: Transcript, format: ExportFormat): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(transcript, null, 2)}\n`;
    case "jsonl":
      return transcript.turns.map((turn) => JSON.stringify(turn)).join("\n") + "\n";
    case "md":
      return renderTranscriptMarkdown(transcript);
  }
}
