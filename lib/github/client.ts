import { z } from "zod";
import { errorMessage, GitHubPublicationError, redactSecrets } from "./error.ts";
import type {
  GitHubPullRequestClient,
  GitHubPullRequestLookup,
  GitHubPullRequestRecord,
} from "./types.ts";

const PullRequestSchema = z
  .object({
    html_url: z.url(),
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    merged_at: z.string().nullable(),
    base: z
      .object({
        ref: z.string(),
        repo: z
          .object({
            name: z.string(),
            owner: z.object({ login: z.string() }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
    head: z
      .object({
        ref: z.string(),
        sha: z.string().regex(/^[0-9a-f]{40,64}$/),
        repo: z
          .object({
            name: z.string(),
            owner: z.object({ login: z.string() }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const PullRequestListSchema = z.array(PullRequestSchema);

export function createGitHubPullRequestClient(input: {
  token: string;
  fetch?: typeof globalThis.fetch;
}): GitHubPullRequestClient {
  const token = input.token.trim();
  if (!token) {
    throw new GitHubPublicationError(
      "invalid-input",
      "GitHub publication token must not be empty.",
    );
  }
  const fetchRequest = input.fetch ?? globalThis.fetch;

  return Object.freeze({
    async listPullRequests(
      lookup: GitHubPullRequestLookup,
    ): Promise<readonly GitHubPullRequestRecord[]> {
      const query = new URLSearchParams({
        state: "all",
        head: `${lookup.repository.owner}:${lookup.headBranch}`,
        base: lookup.baseBranch,
        per_page: "100",
      });
      const value = await requestJson({
        token,
        fetchRequest,
        method: "GET",
        path: `/repos/${encodeURIComponent(lookup.repository.owner)}/${encodeURIComponent(lookup.repository.repository)}/pulls?${query}`,
      });
      const parsed = PullRequestListSchema.safeParse(value);
      if (!parsed.success) throw invalidResponse(parsed.error.message);
      return Object.freeze(parsed.data.map(toRecord));
    },

    async createPullRequest(
      request: GitHubPullRequestLookup & Readonly<{ title: string; body: string }>,
    ): Promise<GitHubPullRequestRecord> {
      const value = await requestJson({
        token,
        fetchRequest,
        method: "POST",
        path: `/repos/${encodeURIComponent(request.repository.owner)}/${encodeURIComponent(request.repository.repository)}/pulls`,
        body: {
          title: request.title,
          body: request.body,
          head: request.headBranch,
          base: request.baseBranch,
        },
      });
      const parsed = PullRequestSchema.safeParse(value);
      if (!parsed.success) throw invalidResponse(parsed.error.message);
      return toRecord(parsed.data);
    },
  });
}

async function requestJson(input: {
  token: string;
  fetchRequest: typeof globalThis.fetch;
  method: "GET" | "POST";
  path: string;
  body?: Readonly<Record<string, string>>;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await input.fetchRequest(`https://api.github.com${input.path}`, {
      method: input.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
        "User-Agent": "harness",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    throw new GitHubPublicationError(
      "github-failed",
      `GitHub request failed: ${redactSecrets(errorMessage(error), [input.token])}`,
    );
  }

  const responseBody = await response.text();
  if (!response.ok) {
    const diagnostic = redactSecrets(responseBody.slice(-2_000), [input.token]).trim();
    throw new GitHubPublicationError(
      "github-failed",
      `GitHub request failed with HTTP ${response.status}${diagnostic ? `: ${diagnostic}` : "."}`,
    );
  }

  try {
    return JSON.parse(responseBody) as unknown;
  } catch {
    throw invalidResponse("response body was not valid JSON");
  }
}

function toRecord(value: z.infer<typeof PullRequestSchema>): GitHubPullRequestRecord {
  return Object.freeze({
    url: value.html_url,
    number: value.number,
    state: value.state,
    merged: value.merged_at !== null,
    owner: value.base.repo.owner.login,
    repository: value.base.repo.name,
    baseBranch: value.base.ref,
    headOwner: value.head.repo.owner.login,
    headRepository: value.head.repo.name,
    headBranch: value.head.ref,
    headSha: value.head.sha,
  });
}

function invalidResponse(detail: string): GitHubPublicationError {
  return new GitHubPublicationError(
    "invalid-response",
    `GitHub returned an invalid pull request response: ${detail}`,
  );
}
