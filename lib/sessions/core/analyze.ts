import type {
  SessionProviderId,
  SessionRecord,
  WorkspacePathConfidence,
  WorkspacePathSource,
} from "./types.ts";

export type PhraseCount = {
  phrase: string;
  count: number;
};

export type SessionClassId = "all" | "realUser" | "automation" | "subagent";

export type SessionClassAnalysis = {
  totalSessions: number;
  // Prefixes and words are exposed for JSON consumers; table output renders marker counts only.
  topFirstQueryPrefixes: PhraseCount[];
  topFirstQueryWords: PhraseCount[];
  candidatePreferenceMarkers: PhraseCount[];
  candidateNoiseMarkers: PhraseCount[];
};

export type SessionAnalysis = {
  provider: SessionProviderId | "all";
  totalSessions: number;
  missing: {
    title: number;
    firstUserQuery: number;
    updatedAtMs: number;
  };
  classifications: {
    automation: number;
    subagent: number;
    realUser: number;
  };
  workspacePathConfidence: Record<WorkspacePathConfidence, number>;
  workspacePathSource: Record<WorkspacePathSource, number>;
  topFirstQueryPrefixes: PhraseCount[];
  topFirstQueryWords: PhraseCount[];
  candidatePreferenceMarkers: PhraseCount[];
  candidateNoiseMarkers: PhraseCount[];
  classBreakdown: Record<SessionClassId, SessionClassAnalysis>;
};

export type AnalyzeSessionsOptions = {
  provider?: SessionProviderId | "all";
  limit?: number;
};

export const DEFAULT_ANALYSIS_LIMIT = 10;
const PREFIX_LENGTH = 120;
const STOP_WORDS = new Set([
  "and",
  "are",
  "but",
  "can",
  "for",
  "from",
  "have",
  "that",
  "the",
  "this",
  "with",
  "you",
  "your",
]);

export const PREFERENCE_MARKERS = [
  "prefer",
  "always",
  "never",
  "default to",
  "make sure",
  "i want you to",
  "don't",
  "do not",
] as const;

export const NOISE_MARKERS = [
  "diff",
  "review",
  "workflow",
  "handoff",
  "automated worker",
  "final answer",
  "agents.md instructions",
] as const;

export function analyzeSessions(
  sessions: readonly SessionRecord[],
  options: AnalyzeSessionsOptions = {},
): SessionAnalysis {
  const limit = options.limit ?? DEFAULT_ANALYSIS_LIMIT;
  const provider = options.provider ?? "all";
  const scopedSessions =
    provider === "all" ? sessions : sessions.filter((session) => session.provider === provider);
  const classBreakdown = analyzeSessionClasses(scopedSessions, limit);

  return {
    provider,
    totalSessions: scopedSessions.length,
    missing: {
      title: countWhere(scopedSessions, (session) => !hasText(session.title)),
      firstUserQuery: countWhere(scopedSessions, (session) => !hasText(session.firstUserQuery)),
      updatedAtMs: countWhere(scopedSessions, (session) => !Number.isFinite(session.updatedAtMs)),
    },
    classifications: {
      automation: classBreakdown.automation.totalSessions,
      subagent: classBreakdown.subagent.totalSessions,
      realUser: classBreakdown.realUser.totalSessions,
    },
    workspacePathConfidence: {
      explicit: countWhere(
        scopedSessions,
        (session) => session.workspacePathConfidence === "explicit",
      ),
      decoded: countWhere(
        scopedSessions,
        (session) => session.workspacePathConfidence === "decoded",
      ),
    },
    workspacePathSource: {
      transcript: countWhere(
        scopedSessions,
        (session) => effectiveWorkspacePathSource(session) === "transcript",
      ),
      "store-db": countWhere(
        scopedSessions,
        (session) => effectiveWorkspacePathSource(session) === "store-db",
      ),
      "project-key": countWhere(
        scopedSessions,
        (session) => effectiveWorkspacePathSource(session) === "project-key",
      ),
    },
    topFirstQueryPrefixes: classBreakdown.all.topFirstQueryPrefixes,
    topFirstQueryWords: classBreakdown.all.topFirstQueryWords,
    candidatePreferenceMarkers: classBreakdown.all.candidatePreferenceMarkers,
    candidateNoiseMarkers: classBreakdown.all.candidateNoiseMarkers,
    classBreakdown,
  };
}

export function normalizeSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function firstQueryPrefixes(sessions: readonly SessionRecord[]): string[] {
  return sessions
    .map((session) => normalizedQuery(session).slice(0, PREFIX_LENGTH).trim())
    .filter(hasText);
}

function analyzeSessionClasses(
  sessions: readonly SessionRecord[],
  limit: number,
): Record<SessionClassId, SessionClassAnalysis> {
  return {
    all: analyzeSessionClass(sessions, limit),
    // `realUser` means not automation. It may still include non-automation subagent edge cases.
    realUser: analyzeSessionClass(
      sessions.filter((session) => !session.isAutomation),
      limit,
    ),
    automation: analyzeSessionClass(
      sessions.filter((session) => session.isAutomation),
      limit,
    ),
    subagent: analyzeSessionClass(
      sessions.filter((session) => session.isSubagent),
      limit,
    ),
  };
}

function analyzeSessionClass(
  sessions: readonly SessionRecord[],
  limit: number,
): SessionClassAnalysis {
  return {
    totalSessions: sessions.length,
    topFirstQueryPrefixes: topCounts(firstQueryPrefixes(sessions), limit),
    topFirstQueryWords: topCounts(firstQueryWords(sessions), limit),
    candidatePreferenceMarkers: markerCounts(sessions, PREFERENCE_MARKERS, limit),
    candidateNoiseMarkers: markerCounts(sessions, NOISE_MARKERS, limit),
  };
}

function firstQueryWords(sessions: readonly SessionRecord[]): string[] {
  return sessions.flatMap((session) =>
    normalizedQuery(session)
      .split(/[^a-z0-9']+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );
}

function markerCounts(
  sessions: readonly SessionRecord[],
  markers: readonly string[],
  limit: number,
): PhraseCount[] {
  const found: string[] = [];
  for (const session of sessions) {
    const query = normalizedQuery(session);
    for (const marker of markers) {
      if (phraseMatches(query, normalizeSnippet(marker))) found.push(marker);
    }
  }
  return topCounts(found, limit);
}

function normalizedQuery(session: SessionRecord): string {
  return normalizeSnippet(session.firstUserQuery ?? "");
}

function topCounts(values: readonly string[], limit: number): PhraseCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!hasText(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([phrase, count]) => ({ phrase, count }))
    .toSorted((left, right) => right.count - left.count || left.phrase.localeCompare(right.phrase))
    .slice(0, limit);
}

function countWhere<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.filter(predicate).length;
}

function effectiveWorkspacePathSource(session: SessionRecord): WorkspacePathSource {
  return (
    session.workspacePathSource ??
    (session.workspacePathConfidence === "explicit" ? "transcript" : "project-key")
  );
}

export function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function phraseMatches(query: string, term: string): boolean {
  if (!hasText(term)) return false;
  // Single-word markers use word boundaries to avoid substring false positives like preview/review.
  if (/^[a-z0-9']+$/.test(term)) {
    return new RegExp(`\\b${escapeRegExp(term)}\\b`).test(query);
  }
  return query.includes(term);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
