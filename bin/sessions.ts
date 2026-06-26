#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { exportTranscript } from "../lib/sessions/core/export.ts";
import { createSessionProvider } from "../lib/sessions/core/factory.ts";
import type {
  ExportFormat,
  IndexSnapshot,
  SessionFilters,
  SessionRecord,
} from "../lib/sessions/core/types.ts";
import { getCursorIndexStats, type IndexStats } from "../lib/sessions/cursor/stats.ts";
import { defaultSessionEnvironment } from "../lib/sessions/core/env.ts";
import { renderTranscriptMarkdown } from "../lib/sessions/core/show.ts";

const EXPORT_FORMATS = ["json", "jsonl", "md"] as const;
const STATS_FORMATS = ["table", "json"] as const;
const sessionEnv = defaultSessionEnvironment();
const cursorProvider = createSessionProvider("cursor", sessionEnv);

type ListOptions = {
  limit: number;
  days?: number;
  workspace?: string;
  query?: string;
  includeAutomation: boolean;
};

type ShowOptions = {
  maxToolChars: number;
};

type ExportOptions = {
  format: ExportFormat;
};

type StatsOptions = {
  format: "table" | "json";
};

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

function makeEnumParser<const T extends readonly string[]>(
  values: T,
): (value: string) => T[number] {
  return (value: string): T[number] => {
    if (values.includes(value)) return value;
    throw new InvalidArgumentError(`must be one of: ${values.join(", ")}`);
  };
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("sessions")
    .description("Browse local agent sessions")
    .showHelpAfterError()
    .exitOverride();
  program.action(() => {
    program.outputHelp();
    process.exitCode = 1;
  });

  const cursor = program.command("cursor").description("Browse Cursor sessions");
  cursor
    .command("reindex")
    .description("Rebuild the Cursor session cache")
    .option("--force", "accepted for compatibility; reindex always rebuilds", false)
    .action(async () => {
      const snapshot = await cursorProvider.reindex();
      console.log(JSON.stringify(snapshotSummary(snapshot), null, 2));
    });

  cursor
    .command("list")
    .description("List Cursor sessions")
    .option("--limit <n>", "maximum rows", positiveInteger, 25)
    .option("--days <n>", "only sessions updated in the last N days", positiveInteger)
    .option("--workspace <path-or-key>", "workspace path prefix or key")
    .option("--query <text>", "search title, session id, workspace, or first query")
    .option("--include-automation", "include automation sessions", false)
    .action((options: ListOptions) => {
      const sessions = cursorProvider.list(toFilters(options));
      console.log(renderSessionTable(sessions));
    });

  cursor
    .command("show")
    .description("Render a Cursor session transcript")
    .argument("<sessionId>", "session id")
    .option("--max-tool-chars <n>", "maximum chars per long turn", positiveInteger, 2_000)
    .action((sessionId: string, options: ShowOptions) => {
      const transcript = cursorProvider.getTranscript(sessionId);
      console.log(renderTranscriptMarkdown(transcript, { maxToolChars: options.maxToolChars }));
    });

  cursor
    .command("export")
    .description("Export a Cursor session transcript")
    .argument("<sessionId>", "session id")
    .option("--format <format>", "json, jsonl, or md", makeEnumParser(EXPORT_FORMATS), "json")
    .action((sessionId: string, options: ExportOptions) => {
      const transcript = cursorProvider.getTranscript(sessionId);
      process.stdout.write(exportTranscript(transcript, options.format));
    });

  cursor
    .command("stats")
    .description("Show Cursor session index stats")
    .option("--format <format>", "table or json", makeEnumParser(STATS_FORMATS), "table")
    .action((options: StatsOptions) => {
      const stats = getCursorIndexStats(sessionEnv);
      if (options.format === "json") {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }
      console.log(renderStats(stats));
    });

  return program;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exit(error.exitCode === 0 ? 0 : 2);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function toFilters(options: ListOptions): SessionFilters {
  const workspace = options.workspace?.trim();
  return {
    limit: options.limit,
    days: options.days,
    workspaceKey: workspace && !workspace.startsWith("/") ? workspace : undefined,
    workspacePathPrefix: workspace?.startsWith("/") ? workspace : undefined,
    query: options.query,
    excludeAutomation: !options.includeAutomation,
    excludeSubagent: !options.includeAutomation,
  };
}

function renderSessionTable(sessions: SessionRecord[]): string {
  if (sessions.length === 0) return "No sessions found. Run `sessions cursor reindex` first.";
  const rows = sessions.map((session) => [
    formatDate(session.updatedAtMs),
    shorten(session.workspacePath, 32),
    shorten(session.title ?? session.firstUserQuery ?? "", 36),
    session.sessionId,
    session.isAutomation ? "yes" : "no",
  ]);
  return renderTable(["updated", "workspace", "title/name", "sessionId", "automation"], rows);
}

function renderStats(stats: IndexStats): string {
  return [
    "Cursor session index stats",
    `  last reindex:     ${stats.lastReindexAt ?? "n/a"}`,
    `  transcripts:      ${stats.transcriptsFound} found / ${stats.indexedSessions} indexed / ${stats.skipped} skipped (${stats.skippedUnparseable} unparseable)`,
    `  user queries:     ${stats.withUserQuery}`,
    `  automation:       ${stats.automationSessions}  subagent: ${stats.subagentSessions}  real-user: ${stats.realUserSessions}`,
    `  workspaces:       ${stats.workspaces}`,
    `  range:            ${stats.oldestSessionAt ?? "n/a"} .. ${stats.newestSessionAt ?? "n/a"}`,
  ].join("\n");
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [headers, ...rows]
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function snapshotSummary(snapshot: IndexSnapshot): {
  provider: string;
  lastReindexAt: string;
  transcriptsFound: number;
  indexedSessions: number;
  skipped: number;
  skippedUnparseable: number;
} {
  return {
    provider: snapshot.provider,
    lastReindexAt: snapshot.lastReindexAt,
    transcriptsFound: snapshot.transcriptsFound,
    indexedSessions: snapshot.indexedSessions,
    skipped: snapshot.skipped,
    skippedUnparseable: snapshot.skippedUnparseable,
  };
}

function formatDate(ms: number | undefined): string {
  if (!ms) return "n/a";
  return new Date(ms).toISOString().slice(0, 10);
}

function shorten(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

await main();
