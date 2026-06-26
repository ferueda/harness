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

export type SessionEvidenceReport = {
  schemaVersion: 1;
  provider: SessionProviderId;
  scannedSessions: number;
  scannedUserTurns: number;
  skippedUserTurns: number;
  excludedFragments: number;
  patterns: EvidencePattern[];
  artifacts: Record<EvidenceArtifactType, EvidenceArtifact[]>;
};

export type ExtractSessionEvidenceOptions = {
  provider: SessionProviderId;
  evidenceLimit?: number;
  patternLimit?: number;
  minSupport?: number;
  snippetLength?: number;
};

const DEFAULT_EVIDENCE_LIMIT = 3;
const DEFAULT_PATTERN_LIMIT = 10;
const DEFAULT_MIN_SUPPORT = 2;
const DEFAULT_SNIPPET_LENGTH = 180;
const MIN_FRAGMENT_LENGTH = 12;
const MAX_FRAGMENT_LENGTH = 240;
const MAX_FRAGMENTS_PER_TURN = 20;
const GROUP_SNIPPET_LENGTH = 80;
const GENERIC_METADATA_NOISE = new Set(["diff", "review", "workflow"]);
const EVIDENCE_NOISE_MARKERS = NOISE_MARKERS.filter(
  (marker) => !GENERIC_METADATA_NOISE.has(marker),
);

const SIGNALS = {
  noise: ["automated worker", "final answer", "handoff-only", "handoff", "agents.md instructions"],
  preference: [...PREFERENCE_MARKERS],
  "git-pr": ["pull request", "pr", "branch", "commit", "merge"],
  debugging: ["debug", "failure", "failed", "error", "broken", "investigate"],
  testing: ["test", "vitest", "baseline", "coverage", "flaky", "check"],
  review: ["review", "code-quality", "implementation review", "review-spec", "audit", "validate"],
  planning: ["plan", "spec", "phases", "roadmap", "next", "scope"],
  implementation: ["implement", "build", "add", "refactor", "fix", "patch"],
  research: ["read article", "investigate", "compare", "understand"],
  other: [],
} satisfies Record<EvidenceBucket, readonly string[]>;

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

  const scannedSessions = new Set<string>();
  const artifacts = emptyArtifacts();
  const patterns = new Map<string, PatternAccumulator>();
  let scannedUserTurns = 0;
  let skippedUserTurns = 0;
  let excludedFragments = 0;

  for await (const turn of turns) {
    scannedUserTurns += 1;
    scannedSessions.add(turn.sessionId);
    const fragments = fragmentsForTurn(turn.text);
    if (fragments.length === 0) {
      skippedUserTurns += 1;
      continue;
    }

    for (const fragment of fragments) {
      const normalized = normalizeSnippet(fragment);
      const fragmentArtifacts = extractArtifacts(fragment, turn.sessionId);
      addArtifacts(artifacts, fragmentArtifacts, evidenceLimit);

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
    patterns: finalizePatterns(patterns, minSupport, patternLimit),
    artifacts,
  };
}

function fragmentsForTurn(text: string): string[] {
  return text
    .split(/\n{2,}|\n|[!?]/)
    .map((fragment) => boundedFragment(fragment))
    .filter(hasText)
    .filter((fragment) => fragment.length >= MIN_FRAGMENT_LENGTH)
    .slice(0, MAX_FRAGMENTS_PER_TURN);
}

function boundedFragment(fragment: string): string {
  const normalized = fragment.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_FRAGMENT_LENGTH) return normalized;

  const lower = normalized.toLowerCase();
  const signals = BUCKET_PRECEDENCE.flatMap((bucket) => SIGNALS[bucket]);
  const matchIndex = signals
    .map((signal) => lower.indexOf(signal))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (matchIndex === undefined) return normalized.slice(0, MAX_FRAGMENT_LENGTH).trim();

  const start = Math.max(0, matchIndex - Math.floor(MAX_FRAGMENT_LENGTH / 3));
  return normalized.slice(start, start + MAX_FRAGMENT_LENGTH).trim();
}

function bucketForFragment(normalized: string): EvidenceBucket {
  if (matchesAny(normalized, SIGNALS.noise) || matchesAny(normalized, EVIDENCE_NOISE_MARKERS))
    return "noise";

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
  return matchedSignals(normalized, signals).length > 0;
}

function dominantSignal(signals: readonly string[]): string {
  return (
    [...signals].toSorted(
      (left, right) => right.length - left.length || left.localeCompare(right),
    )[0] ?? "other"
  );
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
  if (accumulator.examples.length < evidenceLimit) {
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
  return [
    ...matches(fragment, /\b(?:dev\/plans|plans)\/[^\s`'")]+\.md\b/g, "plan-file", sessionId),
    ...matches(fragment, /\b[^\s`'")]+-plan\.md\b/g, "plan-file", sessionId),
    ...matches(
      fragment,
      /https:\/\/github\.com\/[^\s`'")]+\/pull\/\d+/g,
      "pull-request",
      sessionId,
    ),
    ...matches(fragment, /https?:\/\/[^\s`'")]+/g, "url", sessionId),
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
  const backticked = [...fragment.matchAll(/`([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)`/g)].map(
    (match) => match[1],
  );
  const explicit = [
    ...fragment.matchAll(/\b(?:branch|checkout)\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)/gi),
  ].map((match) => match[1]);
  return [...backticked, ...explicit].filter(hasText).map((value) => ({
    type: "branch",
    value: cleanArtifact(value),
    sessionId,
  }));
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

function snippet(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
