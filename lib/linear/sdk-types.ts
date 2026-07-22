import type { LinearPage, PageVariables } from "./pagination.ts";

type MaybeFetch<T> = T | PromiseLike<T> | null | undefined;

export type RawWorkflowState = { id: string; name: string; type: string };
export type RawTeam = { id: string; key: string; name: string };
export type RawProject = { id: string; name: string; url?: string | null };
export type RawUser = { id: string; name: string; displayName: string };
export type RawLabel = { id: string; name: string };
type RawBotActor = { id?: string | null; name?: string | null };

export type RawComment = {
  id: string;
  body: string;
  userId?: string | null;
  externalUserId?: string | null;
  botActor?: RawBotActor | null;
  parentId?: string | null;
  quotedText?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type RawIssueRelation = {
  id: string;
  type: string;
  issueId?: string | null;
  relatedIssueId?: string | null;
};

export type RawAttachment = {
  id: string;
  title: string;
  subtitle?: string | null;
  url: string;
  sourceType?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type RawIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  stateId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  assigneeId?: string | null;
  creatorId?: string | null;
  parentId?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  state?: MaybeFetch<RawWorkflowState>;
  team?: MaybeFetch<RawTeam>;
  project?: MaybeFetch<RawProject>;
  comments: (variables: PageVariables) => PromiseLike<LinearPage<RawComment>>;
  labels: (variables: PageVariables) => PromiseLike<LinearPage<RawLabel>>;
  relations: (variables: PageVariables) => PromiseLike<LinearPage<RawIssueRelation>>;
  inverseRelations: (variables: PageVariables) => PromiseLike<LinearPage<RawIssueRelation>>;
  attachments: (variables: PageVariables) => PromiseLike<LinearPage<RawAttachment>>;
  children: (variables: PageVariables) => PromiseLike<LinearPage<RawIssue>>;
};

export type LinearReadClient = {
  issues: (variables?: unknown) => PromiseLike<LinearPage<RawIssue>>;
  users: (variables?: unknown) => PromiseLike<LinearPage<RawUser>>;
  workflowStates: (variables?: unknown) => PromiseLike<LinearPage<RawWorkflowState>>;
};
