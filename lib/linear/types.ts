export type LinearReadLimits = Readonly<{
  comments: number;
  labels: number;
  relations: number;
  attachments: number;
  children: number;
}>;

export type LinearUser = Readonly<{
  id: string;
  name: string;
  displayName: string;
}>;

export type LinearCommentActor =
  | Readonly<{ kind: "user"; id: string; name: string; displayName: string }>
  | Readonly<{ kind: "bot"; id: string | null; name: string | null }>
  | Readonly<{ kind: "external"; id: string; name: null }>
  | null;

export type LinearWorkflowState = Readonly<{
  id: string;
  name: string;
  type: string;
}>;

export type LinearIssueReference = Readonly<{
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: LinearWorkflowState;
}>;

export type LinearIssueContext = Readonly<{
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: LinearWorkflowState;
  team: Readonly<{ id: string; key: string; name: string }>;
  project: Readonly<{ id: string; name: string; url: string | null }> | null;
  assignee: LinearUser | null;
  creator: LinearUser | null;
  labels: ReadonlyArray<Readonly<{ id: string; name: string }>>;
  comments: ReadonlyArray<
    Readonly<{
      id: string;
      body: string;
      author: LinearCommentActor;
      parentId: string | null;
      quotedText: string | null;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  parent: LinearIssueReference | null;
  children: ReadonlyArray<LinearIssueReference>;
  duplicateOf: LinearIssueReference | null;
  blockedBy: ReadonlyArray<LinearIssueReference>;
  related: ReadonlyArray<LinearIssueReference>;
  attachments: ReadonlyArray<
    Readonly<{
      id: string;
      title: string;
      subtitle: string | null;
      url: string;
      sourceType: string | null;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  createdAt: string;
  updatedAt: string;
  completeness: Readonly<{
    commentsTruncated: boolean;
    labelsTruncated: boolean;
    relationsTruncated: boolean;
    attachmentsTruncated: boolean;
    childrenTruncated: boolean;
  }>;
}>;

export type LinearIssueRevision = Readonly<{
  id: string;
  identifier: string;
  updatedAt: string;
}>;

export type ListIssueRevisionsInput = Readonly<{
  teamId: string;
  projectId: string;
  stateId: string;
  limit: number;
}>;

export type ListIssueRevisionsResult = Readonly<{
  revisions: ReadonlyArray<LinearIssueRevision>;
  truncated: boolean;
}>;

export type FindCommentMarkerInput = Readonly<{
  issueId: string;
  marker: string;
}>;

export type FindWorkflowStateInput = Readonly<{
  teamId: string;
  name: string;
}>;
