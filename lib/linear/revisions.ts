import { LinearError } from "./error.ts";
import { readLimited } from "./pagination.ts";
import { comparePair, nonEmptyInput, normalizeIssueRevision } from "./read-values.ts";
import type { LinearReadClient } from "./sdk-types.ts";
import type {
  LinearIssueRevision,
  ListIssueRevisionsInput,
  ListIssueRevisionsResult,
} from "./types.ts";

export async function listIssueRevisions(
  client: LinearReadClient,
  input: ListIssueRevisionsInput,
): Promise<ListIssueRevisionsResult> {
  const teamId = nonEmptyInput(input.teamId, "teamId");
  const projectId = nonEmptyInput(input.projectId, "projectId");
  const stateId = nonEmptyInput(input.stateId, "stateId");
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit >= Number.MAX_SAFE_INTEGER
  ) {
    throw new LinearError(
      "invalid-input",
      "Linear revision limit must be a positive safe integer.",
    );
  }

  try {
    // Read one extra record so an exact limit is complete while limit + 1 is truncated.
    const result = await readLimited(
      input.limit + 1,
      (variables) =>
        client.issues({
          filter: {
            team: { id: { eq: teamId } },
            project: { id: { eq: projectId } },
            state: { id: { eq: stateId } },
          },
          ...variables,
        }),
      "issue revision list",
    );
    const revisions = result.nodes
      .slice(0, input.limit)
      .map(normalizeIssueRevision)
      .sort(compareIssueRevisions);
    return {
      revisions,
      truncated: result.nodes.length > input.limit,
    };
  } catch (error) {
    if (error instanceof LinearError) throw error;
    throw new LinearError("upstream", "Failed to list Linear issue revisions.", { cause: error });
  }
}

function compareIssueRevisions(left: LinearIssueRevision, right: LinearIssueRevision): number {
  return comparePair(left.identifier, left.id, right.identifier, right.id);
}
