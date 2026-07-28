import { z } from "zod";
import { createGitHubPullRequestClient } from "./client.ts";
import { errorMessage, GitHubPublicationError } from "./error.ts";
import {
  assertBranchName,
  createAuthenticatedGitTransport,
  preparePublicationCommit,
} from "./git.ts";
import { parseGitHubRemote } from "./remote.ts";
import { verifyRepositoryCheckpoint } from "../repository/checkpoint.ts";
import { RepositoryError } from "../repository/error.ts";
import type { RepositoryCheckpoint, RepositoryRun } from "../repository/types.ts";
import type {
  CreateGitHubPublicationOptions,
  GitHubPublicationAuthor,
  GitHubPublicationService,
  GitHubPullRequestClient,
  GitHubPullRequestLookup,
  GitHubPullRequestRecord,
  GitPushTransport,
  PublishedPullRequest,
  PublishCheckpointPullRequestInput,
  PublishPullRequestInput,
} from "./types.ts";

const FullGitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const ChangeSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    status: z.enum([
      "added",
      "modified",
      "deleted",
      "renamed",
      "copied",
      "untracked",
      "conflicted",
    ]),
  })
  .strict();

const RepositoryRunSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    workspace: z.string().min(1),
    remote: z.string().min(1),
    baseRef: z.string().min(1),
    baseSha: FullGitShaSchema,
    branch: z.string().min(1),
  })
  .strict();

const RepositoryCheckpointSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    runId: z.string().min(1),
    baseSha: FullGitShaSchema,
    parentRevision: FullGitShaSchema,
    revision: FullGitShaSchema,
    branch: z.string().min(1),
    changes: z.array(ChangeSchema).min(1),
  })
  .strict();

const PublishPullRequestInputSchema = z
  .object({
    run: RepositoryRunSchema,
    expectedChanges: z.array(ChangeSchema).min(1),
    baseBranch: z.string().min(1),
    commitMessage: z.string().min(1),
    title: z.string().trim().min(1),
    body: z.string(),
  })
  .strict();

const PublishCheckpointPullRequestInputSchema = z
  .object({
    run: RepositoryRunSchema,
    checkpoint: RepositoryCheckpointSchema,
    baseBranch: z.string().min(1),
    title: z.string().trim().min(1),
    body: z.string(),
  })
  .strict();

const AuthorSchema = z
  .object({
    name: z.string().trim().min(1),
    email: z.email(),
  })
  .strict();

export function createGitHubPublication(
  options: CreateGitHubPublicationOptions,
): GitHubPublicationService {
  const token = options.token?.trim();
  const author = AuthorSchema.safeParse(options.author);
  if (!token || !author.success) {
    throw new GitHubPublicationError(
      "invalid-input",
      "GitHub publication requires a token and an explicit commit author name and email.",
    );
  }
  return createGitHubPublicationForClient({
    token,
    author: Object.freeze(author.data),
    client: createGitHubPullRequestClient({ token, fetch: options.fetch }),
    gitTransport: createAuthenticatedGitTransport(),
  });
}

export function createGitHubPublicationForClient(input: {
  token: string;
  author: GitHubPublicationAuthor;
  client: GitHubPullRequestClient;
  gitTransport: GitPushTransport;
}): GitHubPublicationService {
  const token = input.token.trim();
  const author = AuthorSchema.safeParse(input.author);
  if (!token || !author.success) {
    throw new GitHubPublicationError(
      "invalid-input",
      "GitHub publication requires a token and an explicit commit author name and email.",
    );
  }

  return Object.freeze({
    async publishPullRequest(request: PublishPullRequestInput): Promise<PublishedPullRequest> {
      const parsed = PublishPullRequestInputSchema.safeParse(request);
      if (!parsed.success) {
        throw invalidPublicationInput(parsed.error);
      }

      const repository = parseGitHubRemote(parsed.data.run.remote);
      await assertBranchName(parsed.data.baseBranch, "base branch");
      const headSha = await preparePublicationCommit({
        run: parsed.data.run,
        expectedChanges: parsed.data.expectedChanges,
        author: author.data,
        commitMessage: parsed.data.commitMessage,
      });
      return publishExactPullRequest({
        client: input.client,
        gitTransport: input.gitTransport,
        token,
        repository,
        run: parsed.data.run,
        baseBranch: parsed.data.baseBranch,
        title: parsed.data.title,
        body: parsed.data.body,
        headSha,
      });
    },

    async publishCheckpointPullRequest(
      request: PublishCheckpointPullRequestInput,
    ): Promise<PublishedPullRequest> {
      const parsed = PublishCheckpointPullRequestInputSchema.safeParse(request);
      if (!parsed.success) {
        throw invalidPublicationInput(parsed.error);
      }

      const repository = parseGitHubRemote(parsed.data.run.remote);
      await assertBranchName(parsed.data.baseBranch, "base branch");
      await assertPublishableCheckpoint(parsed.data.run, parsed.data.checkpoint);
      return publishExactPullRequest({
        client: input.client,
        gitTransport: input.gitTransport,
        token,
        repository,
        run: parsed.data.run,
        baseBranch: parsed.data.baseBranch,
        title: parsed.data.title,
        body: parsed.data.body,
        headSha: parsed.data.checkpoint.revision,
      });
    },
  });
}

async function assertPublishableCheckpoint(
  run: RepositoryRun,
  checkpoint: RepositoryCheckpoint,
): Promise<void> {
  try {
    await verifyRepositoryCheckpoint(run, checkpoint);
  } catch (error) {
    const code =
      error instanceof RepositoryError
        ? error.code === "invalid_input"
          ? "invalid-input"
          : error.code === "run_conflict"
            ? "run-conflict"
            : "git-failed"
        : "git-failed";
    throw new GitHubPublicationError(
      code,
      `Repository checkpoint cannot be published: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function publishExactPullRequest(input: {
  client: GitHubPullRequestClient;
  gitTransport: GitPushTransport;
  token: string;
  repository: GitHubPullRequestLookup["repository"];
  run: RepositoryRun;
  baseBranch: string;
  title: string;
  body: string;
  headSha: string;
}): Promise<PublishedPullRequest> {
  await ensureRemoteBranch({
    gitTransport: input.gitTransport,
    token: input.token,
    workspace: input.run.workspace,
    remote: input.repository.httpsRemote,
    branch: input.run.branch,
    headSha: input.headSha,
  });

  const lookup = Object.freeze({
    repository: input.repository,
    baseBranch: input.baseBranch,
    headBranch: input.run.branch,
  });
  const existing = await findExactPullRequest(input.client, lookup, input.headSha);
  if (existing) return toPublishedPullRequest(existing);

  try {
    const created = await input.client.createPullRequest({
      ...lookup,
      title: input.title,
      body: input.body,
    });
    assertExactPullRequest(created, lookup, input.headSha);
    return toPublishedPullRequest(created);
  } catch (creationError) {
    try {
      const recovered = await findExactPullRequest(input.client, lookup, input.headSha);
      if (recovered) return toPublishedPullRequest(recovered);
    } catch (lookupError) {
      if (lookupError instanceof GitHubPublicationError && lookupError.code === "github-conflict") {
        throw lookupError;
      }
    }
    throw creationError;
  }
}

function invalidPublicationInput(error: z.ZodError): GitHubPublicationError {
  return new GitHubPublicationError(
    "invalid-input",
    `GitHub publication input is invalid: ${error.issues
      .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
      .join("; ")}`,
  );
}

async function ensureRemoteBranch(input: {
  gitTransport: GitPushTransport;
  token: string;
  workspace: string;
  remote: string;
  branch: string;
  headSha: string;
}): Promise<void> {
  const pushInput = {
    workspace: input.workspace,
    remote: input.remote,
    branch: input.branch,
    commitSha: input.headSha,
    token: input.token,
  };
  const remoteSha = await input.gitTransport.readRemoteBranch(pushInput);
  if (remoteSha === input.headSha) return;
  if (remoteSha !== null) {
    throw new GitHubPublicationError(
      "remote-conflict",
      `Remote branch ${input.branch} does not match this publication commit.`,
    );
  }

  try {
    await input.gitTransport.pushBranch(pushInput);
  } catch (pushError) {
    try {
      if ((await input.gitTransport.readRemoteBranch(pushInput)) === input.headSha) return;
    } catch {
      // Preserve the original push failure for the durable caller.
    }
    throw pushError;
  }
}

async function findExactPullRequest(
  client: GitHubPullRequestClient,
  lookup: GitHubPullRequestLookup,
  headSha: string,
): Promise<GitHubPullRequestRecord | null> {
  const records = await client.listPullRequests(lookup);
  if (records.length === 0) return null;
  if (records.length !== 1) {
    throw new GitHubPublicationError(
      "github-conflict",
      "GitHub returned multiple pull requests for the publication branch.",
    );
  }
  const record = records[0];
  if (!record) return null;
  assertExactPullRequest(record, lookup, headSha);
  return record;
}

function assertExactPullRequest(
  record: GitHubPullRequestRecord,
  lookup: GitHubPullRequestLookup,
  headSha: string,
): void {
  const fullName = `${lookup.repository.owner}/${lookup.repository.repository}`.toLowerCase();
  if (
    `${record.owner}/${record.repository}`.toLowerCase() !== fullName ||
    `${record.headOwner}/${record.headRepository}`.toLowerCase() !== fullName ||
    record.baseBranch !== lookup.baseBranch ||
    record.headBranch !== lookup.headBranch ||
    record.headSha !== headSha
  ) {
    throw new GitHubPublicationError(
      "github-conflict",
      "GitHub pull request identity does not match this publication.",
    );
  }
}

function toPublishedPullRequest(record: GitHubPullRequestRecord): PublishedPullRequest {
  return Object.freeze({
    url: record.url,
    number: record.number,
    owner: record.owner,
    repository: record.repository,
    baseBranch: record.baseBranch,
    headBranch: record.headBranch,
    headSha: record.headSha,
    state: record.state,
    merged: record.merged,
  });
}

export { GitHubPublicationError } from "./error.ts";
export type { GitHubPublicationErrorCode } from "./error.ts";
export type {
  CreateGitHubPublicationOptions,
  GitHubPublicationAuthor,
  GitHubPublicationService,
  PublishedPullRequest,
  PublishCheckpointPullRequestInput,
  PublishPullRequestInput,
} from "./types.ts";
