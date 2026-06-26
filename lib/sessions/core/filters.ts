import type { SessionFilters, SessionRecord } from "./types.ts";

export function applySessionFilters(
  sessions: readonly SessionRecord[],
  filters: SessionFilters = {},
  now: Date = new Date(),
): SessionRecord[] {
  const excludeAutomation = filters.excludeAutomation ?? true;
  const excludeSubagent = filters.excludeSubagent ?? true;
  const query = filters.query?.trim().toLowerCase();
  const cutoffMs = filters.days ? now.getTime() - filters.days * 24 * 60 * 60 * 1000 : undefined;

  const filtered = sessions.filter((session) => {
    if (excludeAutomation && session.isAutomation) return false;
    if (excludeSubagent && session.isSubagent) return false;
    if (filters.workspaceKey && session.workspaceKey !== filters.workspaceKey) return false;
    if (
      filters.workspacePathPrefix &&
      !session.workspacePath.startsWith(filters.workspacePathPrefix)
    ) {
      return false;
    }
    if (cutoffMs !== undefined && (session.updatedAtMs ?? 0) < cutoffMs) return false;
    if (query && !sessionMatchesQuery(session, query)) return false;
    return true;
  });

  const sorted = filtered.toSorted(
    (left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0),
  );
  return filters.limit ? sorted.slice(0, filters.limit) : sorted;
}

function sessionMatchesQuery(session: SessionRecord, query: string): boolean {
  const haystack = [
    session.sessionId,
    session.workspaceKey,
    session.workspacePath,
    session.title,
    session.firstUserQuery,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}
