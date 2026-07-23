import type { RepositoryChange, RepositoryRun } from "../repository/types.ts";

export type GitHubRepositoryIdentity = Readonly<{
  owner: string;
  repository: string;
  httpsRemote: string;
}>;

export type PublishedPullRequest = Readonly<{
  url: string;
  number: number;
  owner: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  state: "open" | "closed";
  merged: boolean;
}>;

export type PublishPullRequestInput = Readonly<{
  run: RepositoryRun;
  expectedChanges: readonly RepositoryChange[];
  baseBranch: string;
  commitMessage: string;
  title: string;
  body: string;
}>;

export type GitHubPublicationService = Readonly<{
  publishPullRequest(input: PublishPullRequestInput): Promise<PublishedPullRequest>;
}>;

export type GitHubPullRequestRecord = Readonly<{
  url: string;
  number: number;
  state: "open" | "closed";
  merged: boolean;
  owner: string;
  repository: string;
  baseBranch: string;
  headOwner: string;
  headRepository: string;
  headBranch: string;
  headSha: string;
}>;

export type GitHubPullRequestLookup = Readonly<{
  repository: GitHubRepositoryIdentity;
  baseBranch: string;
  headBranch: string;
}>;

export type GitHubPullRequestClient = Readonly<{
  listPullRequests(input: GitHubPullRequestLookup): Promise<readonly GitHubPullRequestRecord[]>;
  createPullRequest(
    input: GitHubPullRequestLookup & Readonly<{ title: string; body: string }>,
  ): Promise<GitHubPullRequestRecord>;
}>;

export type GitRemoteBranchInput = Readonly<{
  workspace: string;
  remote: string;
  branch: string;
  token: string;
}>;

export type GitPushInput = GitRemoteBranchInput & Readonly<{ commitSha: string }>;

export type GitPushTransport = Readonly<{
  readRemoteBranch(input: GitRemoteBranchInput): Promise<string | null>;
  pushBranch(input: GitPushInput): Promise<void>;
}>;

export type GitHubPublicationAuthor = Readonly<{
  name: string;
  email: string;
}>;

export type CreateGitHubPublicationOptions = Readonly<{
  token: string;
  author: GitHubPublicationAuthor;
  fetch?: typeof globalThis.fetch;
}>;
