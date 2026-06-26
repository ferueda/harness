import {
  hasText,
  normalizeSnippet,
  NOISE_MARKERS,
  phraseMatches,
  PREFERENCE_MARKERS,
} from "./analyze.ts";
import type {
  SessionProviderId,
  UserTurn,
  WorkspacePathConfidence,
  WorkspacePathSource,
} from "./types.ts";

export type EvidenceBucket =
  | "review"
  | "planning"
  | "implementation"
  | "testing"
  | "debugging"
  | "git-pr"
  | "research"
  | "preference"
  | "noise"
  | "other";

export type EvidenceArtifactType =
  | "path"
  | "plan-file"
  | "pull-request"
  | "branch"
  | "command"
  | "url";

export type EvidenceArtifact = {
  type: EvidenceArtifactType;
  value: string;
  sessionId: string;
};

export type EvidenceExample = {
  sessionId: string;
  workspacePath: string;
  workspacePathConfidence: WorkspacePathConfidence;
  workspacePathSource?: WorkspacePathSource;
  turnIndex: number;
  isFirstUserTurn: boolean;
  text: string;
};

export type EvidencePattern = {
  id: string;
  bucket: EvidenceBucket;
  groupKey: string;
  label: string;
  support: number;
  signals: string[];
  artifacts: EvidenceArtifact[];
  examples: EvidenceExample[];
};

export type EvidenceMatch = {
  sessionId: string;
  workspacePath: string;
  workspacePathConfidence: WorkspacePathConfidence;
  workspacePathSource?: WorkspacePathSource;
  turnIndex: number;
  isFirstUserTurn: boolean;
  updatedAtMs?: number;
  text: string;
  query?: string;
  matchedQueries: string[];
  artifacts: EvidenceArtifact[];
};

export type SessionEvidenceReport = {
  schemaVersion: 1;
  provider: SessionProviderId;
  scannedSessions: number;
  scannedUserTurns: number;
  skippedUserTurns: number;
  excludedFragments: number;
  matches: EvidenceMatch[];
  patterns: EvidencePattern[];
  artifacts: Record<EvidenceArtifactType, EvidenceArtifact[]>;
};

export type ExtractSessionEvidenceOptions = {
  provider: SessionProviderId;
  evidenceLimit?: number;
  patternLimit?: number;
  minSupport?: number;
  snippetLength?: number;
  turnQuery?: string;
  turnQueries?: readonly string[];
  includePatterns?: boolean;
};

export const DEFAULT_EVIDENCE_LIMIT = 3;
export const DEFAULT_PATTERN_LIMIT = 10;
export const DEFAULT_MIN_SUPPORT = 2;
const DEFAULT_SNIPPET_LENGTH = 180;
const MIN_FRAGMENT_LENGTH = 12;
const MAX_FRAGMENT_LENGTH = 240;
const MAX_FRAGMENTS_PER_TURN = 20;
const GROUP_SNIPPET_LENGTH = 80;
const URL_PUNCTUATION = {
  question: "__SESSION_EVIDENCE_URL_QUESTION__",
  bang: "__SESSION_EVIDENCE_URL_BANG__",
} as const;
const GENERIC_METADATA_NOISE = new Set(["diff", "handoff", "review", "workflow"]);
// Transcript evidence keeps broad diff/handoff/review/workflow signals; metadata analysis treats them as noise.
const EVIDENCE_NOISE_MARKERS = NOISE_MARKERS.filter(
  (marker) => !GENERIC_METADATA_NOISE.has(marker),
);

const SIGNALS = {
  noise: ["automated worker", "final answer", "handoff-only", "agents.md instructions"],
  preference: [...PREFERENCE_MARKERS],
  "git-pr": ["pull request", "pr", "branch", "commit", "merge"],
  debugging: ["debug", "failure", "failed", "error", "broken", "investigate"],
  testing: [
    "test",
    "vitest",
    "baseline",
    "coverage",
    "flaky",
    "check",
    "verify",
    "validate",
    "confirm",
  ],
  review: ["review", "code-quality", "implementation review", "review-spec", "audit"],
  planning: [
    "plan",
    "spec",
    "phases",
    "roadmap",
    "next",
    "scope",
    "how to",
    "what should",
    "should we",
    "explain",
  ],
  implementation: ["implement", "build", "add", "refactor", "fix", "patch"],
  research: ["read article", "compare", "understand"],
  other: [],
} satisfies Record<EvidenceBucket, readonly string[]>;

const TRANSCRIPT_NOISE_SIGNALS = [...new Set([...SIGNALS.noise, ...EVIDENCE_NOISE_MARKERS])];

const BUCKET_PRECEDENCE = [
  "noise",
  "preference",
  "git-pr",
  "debugging",
  "testing",
  "review",
  "planning",
  "implementation",
  "research",
  "other",
] as const satisfies readonly EvidenceBucket[];

const ALL_BUCKET_SIGNALS = BUCKET_PRECEDENCE.flatMap((bucket) => SIGNALS[bucket]);

type FragmentEvidence = {
  turn: UserTurn;
  fragment: string;
  normalized: string;
  bucket: EvidenceBucket;
  dominantSignal: string;
  signals: string[];
  artifacts: EvidenceArtifact[];
};

type PatternAccumulator = {
  groupKey: string;
  bucket: EvidenceBucket;
  label: string;
  sessions: Set<string>;
  signals: Set<string>;
  artifacts: EvidenceArtifact[];
  examples: EvidenceExample[];
};

export async function extractSessionEvidence(
  turns: AsyncIterable<UserTurn> | Iterable<UserTurn>,
  options: ExtractSessionEvidenceOptions,
): Promise<SessionEvidenceReport> {
  const evidenceLimit = options.evidenceLimit ?? DEFAULT_EVIDENCE_LIMIT;
  const patternLimit = options.patternLimit ?? DEFAULT_PATTERN_LIMIT;
  const minSupport = options.minSupport ?? DEFAULT_MIN_SUPPORT;
  const snippetLength = options.snippetLength ?? DEFAULT_SNIPPET_LENGTH;
  const turnQueries = normalizeTurnQueries(options);
  const includePatterns = options.includePatterns ?? true;

  const scannedSessions = new Set<string>();
  const artifacts = emptyArtifacts();
  const matches: EvidenceMatch[] = [];
  const patterns = new Map<string, PatternAccumulator>();
  let scannedUserTurns = 0;
  let skippedUserTurns = 0;
  let excludedFragments = 0;

  for await (const turn of turns) {
    scannedUserTurns += 1;
    scannedSessions.add(turn.sessionId);
    const normalizedTurnText = normalizeSnippet(turn.text);
    const turnArtifacts = extractArtifacts(turn.text, turn.sessionId);
    const matchedQueries = matchingTurnQueries(normalizedTurnText, turnQueries);
    const includeTurnArtifacts =
      includePatterns || turnQueries.length === 0 || matchedQueries.length > 0;
    if (includeTurnArtifacts) addArtifacts(artifacts, turnArtifacts, evidenceLimit);

    if (matchedQueries.length > 0) {
      matches.push(matchForTurn(turn, matchedQueries, turnArtifacts, snippetLength));
    }

    if (!includePatterns) {
      continue;
    }

    const fragments = fragmentsForTurn(turn.text);
    if (fragments.length === 0) {
      skippedUserTurns += 1;
      continue;
    }

    for (const fragment of fragments) {
      const normalized = normalizeSnippet(fragment);
      const fragmentArtifacts = extractArtifacts(fragment, turn.sessionId);

      const bucket = bucketForFragment(normalized);
      if (bucket === "noise") {
        excludedFragments += 1;
        continue;
      }

      const signals = matchedSignals(normalized, SIGNALS[bucket]);
      if (signals.length === 0) {
        excludedFragments += 1;
        continue;
      }

      addPattern(
        patterns,
        {
          turn,
          fragment,
          normalized,
          bucket,
          dominantSignal: dominantSignal(signals),
          signals,
          artifacts: fragmentArtifacts,
        },
        evidenceLimit,
        snippetLength,
      );
    }
  }

  return {
    schemaVersion: 1,
    provider: options.provider,
    scannedSessions: scannedSessions.size,
    scannedUserTurns,
    skippedUserTurns,
    excludedFragments,
    matches,
    patterns: includePatterns ? finalizePatterns(patterns, minSupport, patternLimit) : [],
    artifacts,
  };
}

function matchForTurn(
  turn: UserTurn,
  matchedQueries: string[],
  artifacts: EvidenceArtifact[],
  snippetLength: number,
): EvidenceMatch {
  const query = matchedQueries[0];
  return {
    sessionId: turn.sessionId,
    workspacePath: turn.workspacePath,
    workspacePathConfidence: turn.workspacePathConfidence,
    workspacePathSource: turn.workspacePathSource,
    turnIndex: turn.turnIndex,
    isFirstUserTurn: turn.isFirstUserTurn,
    updatedAtMs: turn.session.updatedAtMs,
    text: query
      ? snippetAroundQuery(turn.text, query, snippetLength)
      : snippet(turn.text, snippetLength),
    query,
    matchedQueries,
    artifacts,
  };
}

type NormalizedTurnQuery = {
  value: string;
  normalized: string;
};

function normalizeTurnQueries(options: ExtractSessionEvidenceOptions): NormalizedTurnQuery[] {
  const values = [...(options.turnQueries ?? []), ...(options.turnQuery ? [options.turnQuery] : [])]
    .map((query) => query.trim())
    .filter(hasText);
  const seen = new Set<string>();
  const queries: NormalizedTurnQuery[] = [];
  for (const value of values) {
    const normalized = normalizeSnippet(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    queries.push({ value, normalized });
  }
  return queries;
}

function matchingTurnQueries(
  normalizedTurnText: string,
  queries: readonly NormalizedTurnQuery[],
): string[] {
  return queries
    .filter((query) => phraseMatches(normalizedTurnText, query.normalized))
    .map((query) => query.value);
}

function fragmentsForTurn(text: string): string[] {
  return protectUrlPunctuation(text)
    .split(/\n{2,}|\n|[!?]/)
    .map(restoreUrlPunctuation)
    .map((fragment) => boundedFragment(fragment))
    .filter(hasText)
    .filter((fragment) => fragment.length >= MIN_FRAGMENT_LENGTH)
    .slice(0, MAX_FRAGMENTS_PER_TURN);
}

function protectUrlPunctuation(text: string): string {
  return text.replace(/https?:\/\/[^\s`'")]+/g, (url) =>
    url.replace(/\?/g, URL_PUNCTUATION.question).replace(/!/g, URL_PUNCTUATION.bang),
  );
}

function restoreUrlPunctuation(text: string): string {
  return text.replaceAll(URL_PUNCTUATION.question, "?").replaceAll(URL_PUNCTUATION.bang, "!");
}

function boundedFragment(fragment: string): string {
  const normalized = fragment.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_FRAGMENT_LENGTH) return normalized;

  const lower = normalized.toLowerCase();
  const matchIndex = ALL_BUCKET_SIGNALS.map((signal) => lower.indexOf(signal))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (matchIndex === undefined) return normalized.slice(0, MAX_FRAGMENT_LENGTH).trim();

  const start = Math.max(0, matchIndex - Math.floor(MAX_FRAGMENT_LENGTH / 3));
  return normalized.slice(start, start + MAX_FRAGMENT_LENGTH).trim();
}

function bucketForFragment(normalized: string): EvidenceBucket {
  if (matchesAny(normalized, TRANSCRIPT_NOISE_SIGNALS)) return "noise";

  for (const bucket of BUCKET_PRECEDENCE) {
    if (bucket === "noise" || bucket === "other") continue;
    if (matchesAny(normalized, SIGNALS[bucket])) return bucket;
  }
  return "other";
}

function matchedSignals(normalized: string, signals: readonly string[]): string[] {
  return signals.filter((signal) => phraseMatches(normalized, normalizeSnippet(signal))).sort();
}

function matchesAny(normalized: string, signals: readonly string[]): boolean {
  return signals.some((signal) => phraseMatches(normalized, normalizeSnippet(signal)));
}

function dominantSignal(signals: readonly string[]): string {
  if (signals.length === 0) throw new Error("dominantSignal requires at least one signal");
  return [...signals].toSorted(
    (left, right) => right.length - left.length || left.localeCompare(right),
  )[0] as string;
}

function addPattern(
  patterns: Map<string, PatternAccumulator>,
  evidence: FragmentEvidence,
  evidenceLimit: number,
  snippetLength: number,
): void {
  const groupKey = [
    evidence.bucket,
    evidence.dominantSignal,
    evidence.normalized.slice(0, GROUP_SNIPPET_LENGTH),
  ].join(":");
  const existing = patterns.get(groupKey);
  const accumulator = existing ?? {
    groupKey,
    bucket: evidence.bucket,
    label: snippet(evidence.normalized, GROUP_SNIPPET_LENGTH),
    sessions: new Set<string>(),
    signals: new Set<string>(),
    artifacts: [],
    examples: [],
  };

  accumulator.sessions.add(evidence.turn.sessionId);
  for (const signal of evidence.signals) accumulator.signals.add(signal);
  addBoundedArtifacts(accumulator.artifacts, evidence.artifacts, evidenceLimit);
  if (
    accumulator.examples.length < evidenceLimit &&
    !accumulator.examples.some((example) => example.sessionId === evidence.turn.sessionId)
  ) {
    accumulator.examples.push({
      sessionId: evidence.turn.sessionId,
      workspacePath: evidence.turn.workspacePath,
      workspacePathConfidence: evidence.turn.workspacePathConfidence,
      workspacePathSource: evidence.turn.workspacePathSource,
      turnIndex: evidence.turn.turnIndex,
      isFirstUserTurn: evidence.turn.isFirstUserTurn,
      text: snippet(evidence.fragment, snippetLength),
    });
  }

  patterns.set(groupKey, accumulator);
}

function finalizePatterns(
  patterns: Map<string, PatternAccumulator>,
  minSupport: number,
  patternLimit: number,
): EvidencePattern[] {
  return [...patterns.values()]
    .map((pattern) => ({
      id: patternId(pattern.groupKey),
      bucket: pattern.bucket,
      groupKey: pattern.groupKey,
      label: pattern.label,
      support: pattern.sessions.size,
      signals: [...pattern.signals].sort(),
      artifacts: pattern.artifacts,
      examples: pattern.examples,
    }))
    .filter((pattern) => pattern.support >= minSupport)
    .toSorted(
      (left, right) =>
        right.support - left.support ||
        left.bucket.localeCompare(right.bucket) ||
        left.label.localeCompare(right.label),
    )
    .slice(0, patternLimit);
}

function patternId(groupKey: string): string {
  return groupKey
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function extractArtifacts(fragment: string, sessionId: string): EvidenceArtifact[] {
  const prUrls = matches(
    fragment,
    /https:\/\/github\.com\/[^\s`'")]+\/pull\/\d+/g,
    "pull-request",
    sessionId,
  );
  const genericUrlText = prUrls.reduce(
    (text, artifact) => text.replace(artifact.value, ""),
    fragment,
  );
  return [
    ...matches(fragment, /\b(?:dev\/plans|plans)\/[^\s`'")]+\.md\b/g, "plan-file", sessionId),
    ...matches(fragment, /\b[^\s`'")]+-plan\.md\b/g, "plan-file", sessionId),
    ...prUrls,
    ...matches(genericUrlText, /https?:\/\/[^\s`'")]+/g, "url", sessionId),
    ...commands(fragment, sessionId),
    ...paths(fragment, sessionId),
    ...branches(fragment, sessionId),
  ];
}

function matches(
  fragment: string,
  pattern: RegExp,
  type: EvidenceArtifactType,
  sessionId: string,
): EvidenceArtifact[] {
  return [...fragment.matchAll(pattern)].map((match) => ({
    type,
    value: cleanArtifact(match[0]),
    sessionId,
  }));
}

function commands(fragment: string, sessionId: string): EvidenceArtifact[] {
  const commandPrefixes = "(?:pnpm|npm|node|git|make|harness|sessions)";
  const backtickCommands = [
    ...fragment.matchAll(new RegExp("`(" + commandPrefixes + "[^`]*)`", "g")),
  ]
    .map((match) => match[1])
    .filter(hasText);
  const lineCommands = fragment
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => new RegExp("^" + commandPrefixes + "\\b").test(line));
  return [...backtickCommands, ...lineCommands].map((value) => ({
    type: "command",
    value: cleanArtifact(value),
    sessionId,
  }));
}

function paths(fragment: string, sessionId: string): EvidenceArtifact[] {
  const extension = "(?:md|ts|tsx|js|mjs|json|yaml|yml|sh|txt)";
  const absolute = new RegExp("\\/[A-Za-z0-9._~/-]+\\." + extension + "\\b", "g");
  const relative = new RegExp(
    "\\b(?:[A-Za-z0-9._-]+\\/)+[A-Za-z0-9._-]+\\." + extension + "\\b",
    "g",
  );
  return [
    ...matches(fragment, absolute, "path", sessionId),
    ...matches(fragment, relative, "path", sessionId),
  ];
}

function branches(fragment: string, sessionId: string): EvidenceArtifact[] {
  const backticked = [...fragment.matchAll(/`([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)`/g)]
    .map((match) => match[1])
    .filter((value): value is string => hasText(value) && !hasKnownFileExtension(value));
  const explicit = [
    ...fragment.matchAll(/\b(?:branch|checkout)\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)/gi),
  ].map((match) => match[1]);
  return [...backticked, ...explicit].filter(hasText).map((value) => ({
    type: "branch",
    value: cleanArtifact(value),
    sessionId,
  }));
}

function hasKnownFileExtension(value: string): boolean {
  return /\.(?:md|ts|tsx|js|mjs|json|yaml|yml|sh|txt)\b/.test(value);
}

function addArtifacts(
  target: Record<EvidenceArtifactType, EvidenceArtifact[]>,
  artifacts: readonly EvidenceArtifact[],
  limit: number,
): void {
  for (const artifact of artifacts) {
    addBoundedArtifacts(target[artifact.type], [artifact], limit);
  }
}

function addBoundedArtifacts(
  target: EvidenceArtifact[],
  artifacts: readonly EvidenceArtifact[],
  limit: number,
): void {
  for (const artifact of artifacts) {
    if (target.length >= limit) return;
    if (target.some((existing) => artifactKey(existing) === artifactKey(artifact))) continue;
    target.push(artifact);
  }
}

function emptyArtifacts(): Record<EvidenceArtifactType, EvidenceArtifact[]> {
  return {
    path: [],
    "plan-file": [],
    "pull-request": [],
    branch: [],
    command: [],
    url: [],
  };
}

function artifactKey(artifact: EvidenceArtifact): string {
  return `${artifact.type}:${artifact.value}:${artifact.sessionId}`;
}

function cleanArtifact(value: string): string {
  return value.replace(/[),.;:]+$/g, "").trim();
}

function snippetAroundQuery(value: string, query: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;

  const lower = normalized.toLowerCase();
  const index = lower.indexOf(query.toLowerCase());
  if (index < 0) return snippet(normalized, maxLength);

  const start = Math.max(0, index - Math.floor((maxLength - query.length) / 2));
  const end = Math.min(normalized.length, start + maxLength);
  const adjustedStart = Math.max(0, end - maxLength);
  const prefix = adjustedStart > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  const bodyLength = maxLength - prefix.length - suffix.length;
  return `${prefix}${normalized.slice(adjustedStart, adjustedStart + bodyLength)}${suffix}`;
}

function snippet(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
