import { LinearError } from "./error.ts";
import {
  findCommentMarker,
  findIssueById,
  type LinearReadClient,
  type RawIssueRelation,
} from "./read.ts";
import { readLimited } from "./pagination.ts";

type MaybeFetch<T> = T | PromiseLike<T> | null | undefined;
type MutationEntity = { id?: unknown };

type CommentMutationPayload = {
  success: boolean;
  comment?: MaybeFetch<MutationEntity>;
};

type IssueMutationPayload = {
  success: boolean;
  issue?: MaybeFetch<MutationEntity>;
};

type RelationMutationPayload = {
  success: boolean;
  issueRelation?: MaybeFetch<MutationEntity>;
};

export type LinearWriteClient = {
  createComment: (input: { issueId: string; body: string }) => PromiseLike<CommentMutationPayload>;
  updateIssue: (issueId: string, input: { stateId: string }) => PromiseLike<IssueMutationPayload>;
  createIssueRelation: (input: {
    issueId: string;
    relatedIssueId: string;
    type: "blocks" | "duplicate";
  }) => PromiseLike<RelationMutationPayload>;
};

type LinearProjectionClient = LinearReadClient & LinearWriteClient;

export type CreateCommentInput = Readonly<{
  issueId: string;
  body: string;
}>;

export type EnsureCommentInput = CreateCommentInput &
  Readonly<{
    marker: string;
  }>;

export type UpdateIssueStateInput = Readonly<{
  issueId: string;
  expectedStateId: string;
  stateId: string;
}>;

export type EnsureDuplicateRelationInput = Readonly<{
  issueId: string;
  duplicateOfIssueId: string;
}>;

export type EnsureBlockedByRelationInput = Readonly<{
  issueId: string;
  blockerIssueId: string;
}>;

export type LinearCreatedResult = Readonly<{
  created: boolean;
  id: string;
}>;

export async function createComment(
  client: LinearWriteClient,
  input: CreateCommentInput,
): Promise<Readonly<{ id: string }>> {
  const issueId = nonEmptyInput(input.issueId, "issueId");
  const body = nonEmptyBody(input.body);

  try {
    const payload = await client.createComment({ issueId, body });
    const id = await mutationEntityId(payload, payload?.comment, "comment creation", "comment");
    return { id };
  } catch (error) {
    throw writeError(error, `Failed to create a Linear comment on ${issueId}.`);
  }
}

export async function ensureComment(
  client: LinearProjectionClient,
  commentLimit: number,
  input: EnsureCommentInput,
): Promise<LinearCreatedResult> {
  const issueId = nonEmptyInput(input.issueId, "issueId");
  const marker = nonEmptyInput(input.marker, "marker");
  const body = nonEmptyBody(input.body);
  if (!body.includes(marker)) {
    throw new LinearError("invalid-input", "Linear comment body must contain its marker.");
  }

  const existingId = await findCommentMarker(client, commentLimit, { issueId, marker });
  if (existingId) return { created: false, id: existingId };
  const created = await createComment(client, { issueId, body });
  return { created: true, id: created.id };
}

export async function updateIssueState(
  client: LinearProjectionClient,
  input: UpdateIssueStateInput,
): Promise<Readonly<{ changed: boolean; stateId: string }>> {
  const issueId = nonEmptyInput(input.issueId, "issueId");
  const expectedStateId = nonEmptyInput(input.expectedStateId, "expectedStateId");
  const stateId = nonEmptyInput(input.stateId, "stateId");

  try {
    const issue = await findIssueById(client, issueId);
    const currentStateId = responseString(issue.stateId, "issue stateId");
    if (currentStateId === stateId) return { changed: false, stateId };
    if (currentStateId !== expectedStateId) {
      throw new LinearError(
        "conflict",
        `Linear issue ${issueId} is in state ${currentStateId}, not expected state ${expectedStateId}.`,
      );
    }

    const payload = await client.updateIssue(issueId, { stateId });
    const updatedIssueId = await mutationEntityId(payload, payload?.issue, "state update", "issue");
    if (updatedIssueId !== issueId) {
      throw invalidResponse(
        `Linear state update returned issue ${updatedIssueId}, expected ${issueId}.`,
      );
    }
    return { changed: true, stateId };
  } catch (error) {
    throw writeError(error, `Failed to update Linear issue ${issueId} state.`);
  }
}

export async function ensureDuplicateRelation(
  client: LinearProjectionClient,
  relationLimit: number,
  input: EnsureDuplicateRelationInput,
): Promise<LinearCreatedResult> {
  const issueId = nonEmptyInput(input.issueId, "issueId");
  const duplicateOfIssueId = nonEmptyInput(input.duplicateOfIssueId, "duplicateOfIssueId");
  rejectSelfRelation(issueId, duplicateOfIssueId, "duplicate");

  try {
    const issue = await findIssueById(client, issueId);
    const relations = await readLimited(
      relationLimit,
      (variables) => issue.relations(variables),
      "relations",
    );
    const duplicates = relations.nodes.filter((relation) => relation.type === "duplicate");
    const conflicting = duplicates.find(
      (relation) => relationTargetId(relation, "duplicate") !== duplicateOfIssueId,
    );
    if (conflicting) {
      throw new LinearError(
        "conflict",
        `Linear issue ${issueId} already duplicates ${relationTargetId(conflicting, "duplicate")}.`,
      );
    }
    const existing = duplicates.find(
      (relation) => relationTargetId(relation, "duplicate") === duplicateOfIssueId,
    );
    if (existing) {
      return { created: false, id: responseString(existing.id, "relation id") };
    }
    if (relations.truncated) {
      throw incompleteRelationScan(issueId);
    }
    return await createRelation(client, {
      issueId,
      relatedIssueId: duplicateOfIssueId,
      type: "duplicate",
    });
  } catch (error) {
    throw writeError(error, `Failed to ensure a Linear duplicate relation for ${issueId}.`);
  }
}

export async function ensureBlockedByRelation(
  client: LinearProjectionClient,
  relationLimit: number,
  input: EnsureBlockedByRelationInput,
): Promise<LinearCreatedResult> {
  const issueId = nonEmptyInput(input.issueId, "issueId");
  const blockerIssueId = nonEmptyInput(input.blockerIssueId, "blockerIssueId");
  rejectSelfRelation(issueId, blockerIssueId, "blocked-by");

  try {
    const issue = await findIssueById(client, issueId);
    const relations = await readLimited(
      relationLimit,
      (variables) => issue.inverseRelations(variables),
      "inverse relations",
    );
    const existing = relations.nodes.find(
      (relation) => relation.type === "blocks" && relationSourceId(relation) === blockerIssueId,
    );
    if (existing) {
      return { created: false, id: responseString(existing.id, "relation id") };
    }
    if (relations.truncated) {
      throw incompleteRelationScan(issueId);
    }
    return await createRelation(client, {
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });
  } catch (error) {
    throw writeError(error, `Failed to ensure a Linear blocker relation for ${issueId}.`);
  }
}

async function createRelation(
  client: LinearWriteClient,
  input: {
    issueId: string;
    relatedIssueId: string;
    type: "blocks" | "duplicate";
  },
): Promise<LinearCreatedResult> {
  const payload = await client.createIssueRelation(input);
  const id = await mutationEntityId(
    payload,
    payload?.issueRelation,
    "relation creation",
    "issue relation",
  );
  return { created: true, id };
}

async function mutationEntityId(
  payload: { success: boolean } | null | undefined,
  entity: MaybeFetch<MutationEntity>,
  operation: string,
  entityLabel: string,
): Promise<string> {
  if (!payload || typeof payload.success !== "boolean") {
    throw invalidResponse(`Linear ${operation} returned an invalid payload.`);
  }
  if (!payload.success) {
    throw new LinearError("rejected", `Linear ${operation} was rejected.`);
  }
  const resolved = await entity;
  if (!resolved) {
    throw invalidResponse(`Linear ${operation} did not return a ${entityLabel}.`);
  }
  return responseString(resolved.id, `${entityLabel} id`);
}

function relationTargetId(relation: RawIssueRelation, label: string): string {
  return responseString(relation.relatedIssueId, `${label} target issueId`);
}

function relationSourceId(relation: RawIssueRelation): string {
  return responseString(relation.issueId, "blocking source issueId");
}

function rejectSelfRelation(issueId: string, relatedIssueId: string, label: string): void {
  if (issueId === relatedIssueId) {
    throw new LinearError("invalid-input", `Linear ${label} relation cannot reference itself.`);
  }
}

function incompleteRelationScan(issueId: string): LinearError {
  return new LinearError(
    "incomplete",
    `Linear relation scan for issue ${issueId} reached its configured limit.`,
  );
}

function nonEmptyInput(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LinearError("invalid-input", `Linear ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function nonEmptyBody(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LinearError("invalid-input", "Linear comment body must be a non-empty string.");
  }
  return value;
}

function responseString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidResponse(`Linear response has invalid ${label}.`);
  }
  return value;
}

function invalidResponse(message: string): LinearError {
  return new LinearError("invalid-response", message);
}

function writeError(error: unknown, message: string): LinearError {
  if (error instanceof LinearError) return error;
  return new LinearError("upstream", message, { cause: error });
}
