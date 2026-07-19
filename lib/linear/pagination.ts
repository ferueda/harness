import { LinearError } from "./error.ts";

export const LINEAR_PAGE_SIZE = 50;

export type LinearPage<T> = {
  nodes: T[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor?: string | null;
  };
};

export type PageVariables = { first: number; after?: string };

export type LimitedResult<T> = { nodes: T[]; truncated: boolean };

export async function readLimited<T>(
  limit: number,
  load: (variables: PageVariables) => PromiseLike<LinearPage<T>>,
  label: string,
): Promise<LimitedResult<T>> {
  const nodes: T[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;

  while (nodes.length < limit) {
    const page = await load({
      first: Math.min(LINEAR_PAGE_SIZE, limit - nodes.length),
      ...(after ? { after } : {}),
    });
    assertPage(page, label);
    nodes.push(...page.nodes.slice(0, limit - nodes.length));
    if (nodes.length === limit) return { nodes, truncated: true };
    if (!page.pageInfo.hasNextPage) return { nodes, truncated: false };
    const next = page.pageInfo.endCursor;
    if (!next || seenCursors.has(next)) {
      throw invalidResponse(`Linear ${label} pagination did not advance.`);
    }
    seenCursors.add(next);
    after = next;
  }

  return { nodes, truncated: true };
}

export function assertPage<T>(value: LinearPage<T>, label: string): void {
  if (!value || !Array.isArray(value.nodes) || !value.pageInfo) {
    throw invalidResponse(`Linear returned an invalid ${label} page.`);
  }
}

function invalidResponse(message: string): LinearError {
  return new LinearError("invalid-response", message);
}
