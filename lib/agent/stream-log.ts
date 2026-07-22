import { mkdirSync, createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";

export type AgentStreamProvider = "cursor" | "codex";
export type AgentStreamFormat = "cursor-sdk-message" | "codex-thread-event";

export type AgentStreamLogSummary = {
  path: string;
  status: "written" | "missing" | "unsupported" | "error";
  provider: AgentStreamProvider;
  format: AgentStreamFormat;
  error?: string;
  agentMessageCount?: number;
  finalAgentMessageId?: string;
};

export type AgentStreamWriter = {
  write(event: unknown): void;
  close(): Promise<AgentStreamLogSummary>;
};

type AgentStreamWriterMetadata = {
  provider: AgentStreamProvider;
  format: AgentStreamFormat;
};

export function createAgentStreamWriter(
  logPath: string,
  metadata: AgentStreamWriterMetadata,
): AgentStreamWriter {
  mkdirSync(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: "a", encoding: "utf8" });
  let sequence = 0;
  let writeError: Error | undefined;

  stream.on("error", (error) => {
    writeError ??= error;
  });

  return {
    write(event) {
      if (writeError) return;
      try {
        sequence += 1;
        stream.write(
          `${JSON.stringify({
            ...metadata,
            sequence,
            timestamp: new Date().toISOString(),
            event,
          })}\n`,
        );
      } catch (error) {
        writeError = error instanceof Error ? error : new Error(String(error));
      }
    },
    async close() {
      stream.end();
      try {
        await finished(stream);
      } catch (error) {
        writeError ??= error instanceof Error ? error : new Error(String(error));
      }

      if (writeError) {
        return {
          path: logPath,
          ...metadata,
          status: "error",
          error: writeError.message,
        };
      }

      return {
        path: logPath,
        ...metadata,
        status: sequence > 0 ? "written" : "missing",
      };
    },
  };
}
