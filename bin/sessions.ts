#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { readCachedSessions } from "../lib/sessions/core/cache.ts";
import { exportTranscript } from "../lib/sessions/core/export.ts";
import { createSessionProvider } from "../lib/sessions/core/factory.ts";
import type {
  ExportFormat,
  IndexSnapshot,
  SessionFilters,
  SessionRecord,
} from "../lib/sessions/core/types.ts";
import type { PhraseCount, SessionClassAnalysis } from "../lib/sessions/core/analyze.ts";
import {
  analyzeCursorSessions,
  cursorSessions,
  type CursorAnalysisSampleSet,
  type IndexImprovementCandidate,
  type CursorSessionAnalysis,
} from "../lib/sessions/cursor/analyze.ts";
import { getCursorIndexStats, type IndexStats } from "../lib/sessions/cursor/stats.ts";
import { defaultSessionEnvironment } from "../lib/sessions/core/env.ts";
import { renderTranscriptMarkdown } from "../lib/sessions/core/show.ts";

const ANALYZE_PROVIDERS = ["cursor"] as const;
const TABLE_JSON_FORMATS = ["table", "json"] as const;
const EXPORT_FORMATS = ["json", "jsonl", "md"] as const;
const sessionEnv = defaultSessionEnvironment();
const cursorProvider = createSessionProvider("cursor", sessionEnv);

type AnalyzeOptions = {
  provider: (typeof ANALYZE_PROVIDERS)[number];
  format: (typeof TABLE_JSON_FORMATS)[number];
  limit: number;
};

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
  format: (typeof TABLE_JSON_FORMATS)[number];
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

  program
    .command("analyze")
    .description("Analyze indexed session metadata")
    .option("--provider <provider>", "cursor", makeEnumParser(ANALYZE_PROVIDERS), "cursor")
    .option("--format <format>", "table or json", makeEnumParser(TABLE_JSON_FORMATS), "table")
    .option("--limit <n>", "maximum rows per analysis section", positiveInteger, 10)
    .action((options: AnalyzeOptions) => {
      const analysis = analyzeIndexedSessions(options);
      if (options.format === "json") {
        console.log(JSON.stringify(analysis, null, 2));
        return;
      }
      console.log(renderCursorAnalysis(analysis));
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
    .option("--format <format>", "table or json", makeEnumParser(TABLE_JSON_FORMATS), "table")
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

function analyzeIndexedSessions(options: AnalyzeOptions): CursorSessionAnalysis {
  switch (options.provider) {
    case "cursor":
      return analyzeCursorSessions(cursorSessions(readCachedSessions(sessionEnv)), {
        limit: options.limit,
      });
  }
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

function renderCursorAnalysis(analysis: CursorSessionAnalysis): string {
  return [
    "Session index analysis",
    `  provider:         ${analysis.provider}`,
    `  sessions:         ${analysis.totalSessions}`,
    `  missing title:    ${analysis.missing.title} any`,
    `  missing query:    ${analysis.missing.firstUserQuery}`,
    `  missing updated:  ${analysis.missing.updatedAtMs}`,
    `  automation:       ${analysis.classifications.automation}`,
    `  subagent:         ${analysis.classifications.subagent}`,
    `  non-automation:   ${analysis.classifications.realUser}`,
    `  workspace paths:  ${analysis.workspacePathConfidence.explicit} explicit / ${analysis.workspacePathConfidence.decoded} decoded`,
    "",
    "Top first-query prefixes",
    renderPhraseCounts(analysis.topFirstQueryPrefixes),
    "",
    "Top first-query words",
    renderPhraseCounts(analysis.topFirstQueryWords),
    "",
    renderClassMarkers(
      "Self-improve marker candidates (all sessions; informational only)",
      analysis.classBreakdown.all,
      false,
    ),
    "",
    "Class-scoped marker candidates (buckets can overlap; non-automation excludes automation-classified sessions)",
    renderClassMarkers("Non-automation sessions", analysis.classBreakdown.realUser),
    "",
    renderClassMarkers("Automation sessions", analysis.classBreakdown.automation),
    "",
    renderClassMarkers("Subagent sessions", analysis.classBreakdown.subagent),
    "",
    "Cursor samples",
    renderSamples("Suspicious automation", analysis.cursor.suspiciousAutomation),
    renderSamples("Decoded workspace paths", analysis.cursor.decodedWorkspacePaths),
    renderSamples("Missing titles with query", analysis.cursor.missingTitles),
    renderSamples("Preference marker samples", analysis.cursor.preferenceMarkers),
    renderSamples("Noise marker samples", analysis.cursor.noiseMarkers),
    "",
    "Index improvement candidates",
    renderIndexImprovementCandidates(analysis.indexImprovementCandidates),
  ].join("\n");
}

function renderClassMarkers(
  title: string,
  analysis: SessionClassAnalysis,
  includeSessionCount = true,
): string {
  const suffix = includeSessionCount
    ? ` (${analysis.totalSessions} session${analysis.totalSessions === 1 ? "" : "s"})`
    : "";
  return [
    `${title}${suffix}`,
    "  Preference-like markers",
    renderPhraseCounts(analysis.candidatePreferenceMarkers),
    "  Noise/skip markers",
    renderPhraseCounts(analysis.candidateNoiseMarkers),
  ].join("\n");
}

function renderSamples(title: string, section: CursorAnalysisSampleSet): string {
  const titleWithTotal = `${title} (${section.total} total)`;
  const samples = section.samples;
  if (samples.length === 0) return `${titleWithTotal}\n  none`;
  const rows = samples.map((sample) => [
    sample.sessionId,
    shorten(sample.workspacePath, 30),
    shorten(sample.title ?? sample.firstUserQuery ?? "", 54),
    sample.reason,
  ]);
  return `${titleWithTotal}\n${renderTable(["sessionId", "workspace", "title/query", "reason"], rows)}`;
}

function renderIndexImprovementCandidates(
  candidates: readonly IndexImprovementCandidate[],
): string {
  if (candidates.length === 0) return "  none";
  return candidates
    .map(
      (candidate) =>
        `  ${candidate.severity.padEnd(6)} ${candidate.count.toString().padStart(4)}  ${candidate.id}: ${candidate.message}`,
    )
    .join("\n");
}

function renderPhraseCounts(items: readonly PhraseCount[]): string {
  if (items.length === 0) return "  none";
  return items.map((item) => `  ${item.count.toString().padStart(3)}  ${item.phrase}`).join("\n");
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
