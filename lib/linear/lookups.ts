import { LinearError } from "./error.ts";
import { assertPage, readLimited } from "./pagination.ts";
import { nonEmptyInput, normalizeState, requiredString } from "./read-values.ts";
import type { LinearReadClient, RawIssue } from "./sdk-types.ts";
import type {
  FindCommentMarkerInput,
  FindWorkflowStateInput,
  LinearWorkflowState,
} from "./types.ts";

export async function findCommentMarker(
  client: LinearReadClient,
  commentLimit: number,
  input: FindCommentMarkerInput,
): Promise<string | null> {
  const issueId = nonEmptyInput(input.issueId, "issueId");
  const marker = nonEmptyInput(input.marker, "marker");

  try {
    const issue = await findIssueById(client, issueId);
    const comments = await readLimited(
      commentLimit,
      (variables) => issue.comments(variables),
      "comments",
    );
    const match = comments.nodes.find((comment) =>
      requiredString(comment.body, "comment body").includes(marker),
    );
    if (match) return requiredString(match.id, "comment id");
    if (comments.truncated) {
      throw new LinearError(
        "incomplete",
        `Linear comment scan for issue ${issueId} reached its configured limit.`,
      );
    }
    return null;
  } catch (error) {
    if (error instanceof LinearError) throw error;
    throw new LinearError("upstream", `Failed to find a Linear comment marker on ${issueId}.`, {
      cause: error,
    });
  }
}

export async function findWorkflowState(
  client: LinearReadClient,
  input: FindWorkflowStateInput,
): Promise<LinearWorkflowState> {
  const teamId = nonEmptyInput(input.teamId, "teamId");
  const name = nonEmptyInput(input.name, "name");

  try {
    const connection = await client.workflowStates({
      filter: {
        team: { id: { eq: teamId } },
        name: { eq: name },
      },
      first: 2,
    });
    assertPage(connection, "workflow state lookup");
    const matches = connection.nodes.filter(
      (state) =>
        requiredString(state.name, "workflow state name") === name &&
        requiredString(state.id, "workflow state id") !== "",
    );
    if (matches.length === 0) {
      throw new LinearError(
        "not-found",
        `Linear workflow state not found for team ${teamId}: ${name}.`,
      );
    }
    if (matches.length > 1 || connection.pageInfo.hasNextPage) {
      throw new LinearError(
        "ambiguous-reference",
        `Linear workflow state is ambiguous for team ${teamId}: ${name}.`,
      );
    }
    return normalizeState(matches[0]);
  } catch (error) {
    if (error instanceof LinearError) throw error;
    throw new LinearError(
      "upstream",
      `Failed to find Linear workflow state ${name} for team ${teamId}.`,
      { cause: error },
    );
  }
}

export async function findIssueById(client: LinearReadClient, issueId: string): Promise<RawIssue> {
  const connection = await client.issues({
    filter: { id: { eq: issueId } },
    first: 2,
  });
  assertPage(connection, "issue lookup");
  const matches = connection.nodes.filter(
    (issue) => requiredString(issue.id, "lookup issue id") === issueId,
  );
  if (matches.length === 0) {
    throw new LinearError("not-found", `Linear issue not found: ${issueId}.`);
  }
  if (matches.length > 1 || connection.pageInfo.hasNextPage) {
    throw new LinearError(
      "ambiguous-reference",
      `Linear issue reference is ambiguous: ${issueId}.`,
    );
  }
  return matches[0];
}
