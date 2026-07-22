import { LinearClient } from "@linear/sdk";
import { LinearError } from "./error.ts";
import { getIssueContext } from "./issue-context.ts";
import { normalizeLimits } from "./limits.ts";
import {
  findCommentMarker as findCommentMarkerOperation,
  findWorkflowState as findWorkflowStateOperation,
} from "./lookups.ts";
import { listIssueRevisions as listIssueRevisionsOperation } from "./revisions.ts";
import type { LinearReadClient } from "./sdk-types.ts";
import type {
  FindCommentMarkerInput,
  FindWorkflowStateInput,
  LinearIssueContext,
  LinearReadLimits,
  LinearWorkflowState,
  ListIssueRevisionsInput,
  ListIssueRevisionsResult,
} from "./types.ts";
import {
  createComment as createCommentOperation,
  ensureBlockedByRelation as ensureBlockedByRelationOperation,
  ensureComment as ensureCommentOperation,
  ensureDuplicateRelation as ensureDuplicateRelationOperation,
  updateIssueLabels as updateIssueLabelsOperation,
  updateIssueState as updateIssueStateOperation,
  type CreateCommentInput,
  type EnsureBlockedByRelationInput,
  type EnsureCommentInput,
  type EnsureDuplicateRelationInput,
  type LinearCreatedResult,
  type LinearWriteClient,
  type UpdateIssueLabelsInput,
  type UpdateIssueLabelsResult,
  type UpdateIssueStateInput,
} from "./write.ts";

export { LinearError } from "./error.ts";
export type { LinearErrorCode } from "./error.ts";
export type {
  FindCommentMarkerInput,
  FindWorkflowStateInput,
  LinearCommentActor,
  LinearIssueContext,
  LinearIssueReference,
  LinearIssueRevision,
  LinearReadLimits,
  LinearUser,
  LinearWorkflowState,
  ListIssueRevisionsInput,
  ListIssueRevisionsResult,
} from "./types.ts";
export type { LinearReadClient } from "./sdk-types.ts";
export type {
  CreateCommentInput,
  EnsureBlockedByRelationInput,
  EnsureCommentInput,
  EnsureDuplicateRelationInput,
  LinearCreatedResult,
  LinearWriteClient,
  UpdateIssueLabelsInput,
  UpdateIssueLabelsResult,
  UpdateIssueStateInput,
} from "./write.ts";

export interface LinearClientLike extends LinearReadClient, LinearWriteClient {}

export type LinearService = Readonly<{
  getIssueContext: (issueRef: string) => Promise<LinearIssueContext>;
  listIssueRevisions: (input: ListIssueRevisionsInput) => Promise<ListIssueRevisionsResult>;
  findCommentMarker: (input: FindCommentMarkerInput) => Promise<string | null>;
  findWorkflowState: (input: FindWorkflowStateInput) => Promise<LinearWorkflowState>;
  createComment: (input: CreateCommentInput) => Promise<Readonly<{ id: string }>>;
  ensureComment: (input: EnsureCommentInput) => Promise<LinearCreatedResult>;
  updateIssueState: (
    input: UpdateIssueStateInput,
  ) => Promise<Readonly<{ changed: boolean; stateId: string }>>;
  updateIssueLabels: (input: UpdateIssueLabelsInput) => Promise<UpdateIssueLabelsResult>;
  ensureDuplicateRelation: (input: EnsureDuplicateRelationInput) => Promise<LinearCreatedResult>;
  ensureBlockedByRelation: (input: EnsureBlockedByRelationInput) => Promise<LinearCreatedResult>;
}>;

export function createLinear(input: { apiKey: string; limits: LinearReadLimits }): LinearService {
  if (typeof input.apiKey !== "string" || input.apiKey.trim() === "") {
    throw new LinearError("invalid-config", "Linear apiKey must be a non-empty string.");
  }
  const client = new LinearClient({ apiKey: input.apiKey }) as unknown as LinearClientLike;
  return createLinearForClient({ client, limits: input.limits });
}

export function createLinearForClient(input: {
  client: LinearClientLike;
  limits: LinearReadLimits;
}): LinearService {
  const limits = normalizeLimits(input.limits);
  return {
    getIssueContext: (issueRef) => getIssueContext(input.client, limits, issueRef),
    listIssueRevisions: (listInput) => listIssueRevisionsOperation(input.client, listInput),
    findCommentMarker: (markerInput) =>
      findCommentMarkerOperation(input.client, limits.comments, markerInput),
    findWorkflowState: (stateInput) => findWorkflowStateOperation(input.client, stateInput),
    createComment: (commentInput) => createCommentOperation(input.client, commentInput),
    ensureComment: (commentInput) =>
      ensureCommentOperation(input.client, limits.comments, commentInput),
    updateIssueState: (stateInput) => updateIssueStateOperation(input.client, stateInput),
    updateIssueLabels: (labelsInput) =>
      updateIssueLabelsOperation(input.client, limits.labels, labelsInput),
    ensureDuplicateRelation: (relationInput) =>
      ensureDuplicateRelationOperation(input.client, limits.relations, relationInput),
    ensureBlockedByRelation: (relationInput) =>
      ensureBlockedByRelationOperation(input.client, limits.relations, relationInput),
  };
}
