export type LinearClientLike = {
  issue: (id: string) => Promise<LinearIssueLike>;
  issues: (variables?: unknown) => Promise<LinearConnectionLike<LinearIssueLike>>;
  teams: (variables?: unknown) => Promise<LinearConnectionLike<LinearTeamLike>>;
  updateIssue: (id: string, input: { stateId: string }) => Promise<unknown>;
  createComment: (input: { issueId: string; body: string }) => Promise<unknown>;
};

export type LinearConnectionLike<T> = {
  nodes: T[];
  pageInfo?: {
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
};

export type LinearIssueLike = {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description?: string | null;
  url: string;
  projectId?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  assignee?: Promise<LinearUserLike | undefined> | LinearUserLike | undefined;
  state?: Promise<LinearWorkflowStateLike | undefined> | LinearWorkflowStateLike | undefined;
  team?: Promise<LinearTeamLike | undefined> | LinearTeamLike | undefined;
  project?: Promise<LinearProjectLike | undefined> | LinearProjectLike | undefined;
  labels?: (variables?: unknown) => Promise<LinearConnectionLike<LinearIssueLabelLike>>;
  comments?: (variables?: unknown) => Promise<LinearConnectionLike<LinearCommentLike>>;
};

export type LinearTeamLike = {
  id: string;
  key: string;
  name: string;
  states: (variables?: unknown) => Promise<LinearConnectionLike<LinearWorkflowStateLike>>;
};

export type LinearWorkflowStateLike = {
  id: string;
  name: string;
  type?: string;
};

export type LinearProjectLike = {
  id: string;
  name: string;
  url?: string;
};

export type LinearIssueLabelLike = {
  name: string;
};

export type LinearCommentLike = {
  id?: string;
  body: string;
  createdAt?: Date | string;
};

export type LinearUserLike = {
  id?: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
};
