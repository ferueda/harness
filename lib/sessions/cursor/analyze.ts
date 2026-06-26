import {
  DEFAULT_ANALYSIS_LIMIT,
  NOISE_MARKERS,
  PREFERENCE_MARKERS,
  analyzeSessions,
  hasText,
  normalizeSnippet,
  phraseMatches,
  type SessionAnalysis,
} from "../core/analyze.ts";
import type { CursorSession, SessionRecord } from "../core/types.ts";
import { AUTOMATION_MARKERS } from "./classify.ts";

export type CursorAnalysisSample = {
  sessionId: string;
  workspacePath: string;
  title?: string;
  firstUserQuery?: string;
  reason: string;
};

export type CursorAnalysisSampleSet = {
  total: number;
  samples: CursorAnalysisSample[];
};

export type IndexImprovementCandidate = {
  id: string;
  severity: "high" | "medium" | "low";
  count: number;
  message: string;
};

export type CursorSpecificAnalysis = {
  suspiciousAutomation: CursorAnalysisSampleSet;
  decodedWorkspacePaths: CursorAnalysisSampleSet;
  missingTitles: CursorAnalysisSampleSet;
  preferenceMarkers: CursorAnalysisSampleSet;
  noiseMarkers: CursorAnalysisSampleSet;
};

export type CursorSessionAnalysis = SessionAnalysis & {
  cursor: CursorSpecificAnalysis;
  indexImprovementCandidates: IndexImprovementCandidate[];
};

export type AnalyzeCursorSessionsOptions = {
  limit?: number;
};

const SUSPICIOUS_AUTOMATION_PHRASES = [...AUTOMATION_MARKERS, "automated worker"] as const;

export function analyzeCursorSessions(
  sessions: readonly CursorSession[],
  options: AnalyzeCursorSessionsOptions = {},
): CursorSessionAnalysis {
  const limit = options.limit ?? DEFAULT_ANALYSIS_LIMIT;
  const base = analyzeSessions(sessions, { provider: "cursor", limit });
  const ordered = sortedSessions(sessions);
  const cursor = {
    suspiciousAutomation: suspiciousAutomationSamples(ordered, limit),
    decodedWorkspacePaths: collectSampleSet(ordered, limit, (session) =>
      session.workspacePathConfidence === "decoded"
        ? "workspace path came from lossy Cursor project-key decoding"
        : undefined,
    ),
    missingTitles: collectSampleSet(ordered, limit, (session) =>
      !hasText(session.title) && hasText(session.firstUserQuery)
        ? "session has firstUserQuery but no title metadata"
        : undefined,
    ),
    preferenceMarkers: markerSamples(ordered, PREFERENCE_MARKERS, limit),
    noiseMarkers: markerSamples(ordered, NOISE_MARKERS, limit),
  };

  return {
    ...base,
    cursor,
    indexImprovementCandidates: indexImprovementCandidates(base, cursor),
  };
}

export function cursorSessions(sessions: readonly SessionRecord[]): CursorSession[] {
  return sessions.filter((session): session is CursorSession => session.provider === "cursor");
}

function suspiciousAutomationSamples(
  sessions: readonly CursorSession[],
  limit: number,
): CursorAnalysisSampleSet {
  return collectSampleSet(sessions, limit, (session) => {
    if (session.isAutomation) return undefined;
    const term = matchingTerm(session, SUSPICIOUS_AUTOMATION_PHRASES);
    return term === undefined ? undefined : `query contains automation-like phrase: ${term}`;
  });
}

function markerSamples(
  sessions: readonly CursorSession[],
  markers: readonly string[],
  limit: number,
): CursorAnalysisSampleSet {
  return collectSampleSet(sessions, limit, (session) => {
    const terms = matchingTerms(session, markers);
    return terms.length === 0 ? undefined : `query contains marker: ${terms.join(", ")}`;
  });
}

function collectSampleSet(
  sessions: readonly CursorSession[],
  limit: number,
  reasonFor: (session: CursorSession) => string | undefined,
): CursorAnalysisSampleSet {
  const samples: CursorAnalysisSample[] = [];
  let total = 0;
  for (const session of sessions) {
    const reason = reasonFor(session);
    if (reason === undefined) continue;
    total += 1;
    if (samples.length < limit) {
      samples.push(toSample(session, reason));
    }
  }
  return { total, samples };
}

function indexImprovementCandidates(
  analysis: SessionAnalysis,
  cursor: CursorSpecificAnalysis,
): IndexImprovementCandidate[] {
  const candidates: IndexImprovementCandidate[] = [];
  if (
    analysis.workspacePathSource.transcript === 0 &&
    analysis.workspacePathSource["store-db"] === 0 &&
    analysis.workspacePathSource["project-key"] > 0
  ) {
    candidates.push({
      id: "workspace-path-project-key-only",
      severity: "high",
      count: analysis.workspacePathSource["project-key"],
      message: "All workspace paths came from Cursor project-key decoding.",
    });
  }

  if (analysis.totalSessions > 0 && analysis.missing.title / analysis.totalSessions > 0.25) {
    candidates.push({
      id: "missing-title-metadata",
      severity: "medium",
      count: analysis.missing.title,
      message: "More than 25% of indexed sessions are missing title metadata.",
    });
  }

  const suspiciousTotal = cursor.suspiciousAutomation.total;
  candidates.push({
    id: "suspicious-automation-classification",
    severity: suspiciousTotal > 0 ? "high" : "low",
    count: suspiciousTotal,
    message:
      suspiciousTotal > 0
        ? "Some non-automation sessions contain classifier automation phrases."
        : "No suspicious automation classifier misses found.",
  });

  return candidates;
}

function matchingTerm(session: CursorSession, terms: readonly string[]): string | undefined {
  return matchingTerms(session, terms)[0];
}

function matchingTerms(session: CursorSession, terms: readonly string[]): string[] {
  const query = normalizeSnippet(session.firstUserQuery ?? "");
  return terms
    .map((term) => normalizeSnippet(term))
    .filter(hasText)
    .toSorted((left, right) => right.length - left.length || left.localeCompare(right))
    .filter((term) => phraseMatches(query, term));
}

function sortedSessions(sessions: readonly CursorSession[]): CursorSession[] {
  return sessions.toSorted(
    (left, right) =>
      (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) ||
      left.sessionId.localeCompare(right.sessionId),
  );
}

function toSample(session: CursorSession, reason: string): CursorAnalysisSample {
  return {
    sessionId: session.sessionId,
    workspacePath: session.workspacePath,
    title: session.title,
    firstUserQuery: snippet(session.firstUserQuery),
    reason,
  };
}

function snippet(value: string | undefined): string | undefined {
  if (!hasText(value)) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}
