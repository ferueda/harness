import type {
  GitHubPublicationService,
  GitHubRepositoryIdentity,
  PublishedPullRequest,
} from "../github/types.ts";
import type { LinearService } from "../linear/client.ts";
import type { RepositoryCheckpoint, RepositoryRun } from "../repository/types.ts";
import type { SpecReviewProvenance } from "../spec-review/review.ts";
import type { SpecReviewDecision } from "../spec-review/schema.ts";
import {
  renderReviewedSpecOutcomeComment,
  renderReviewedSpecPullRequest,
  reservedPullRequestUrl,
  SpecPresentationError,
} from "../spec/presentation.ts";
import type { SpecDecision } from "../spec/schema.ts";
import type { SpecProvenance } from "../spec/spec.ts";
import type { LinearReadinessConfig } from "./readiness.ts";
import { loadClaimedWorkItem, type SpecAuthority } from "./spec-authority.ts";
import { specCycleCommentMarker } from "./spec-projection.ts";

type SpecPublicationLinear = Pick<LinearService, "getIssueContext">;

export type PublishReviewedSpecResult =
  | Readonly<{ kind: "stale"; reason: string }>
  | Readonly<{ kind: "invalid"; error: string }>
  | Readonly<{
      kind: "published";
      pullRequest: PublishedPullRequest;
      marker: string;
      comment: string;
    }>;

export type PublishReviewedSpecInput = Readonly<{
  linear: SpecPublicationLinear;
  authority: SpecAuthority;
  readiness: LinearReadinessConfig;
  github: GitHubPublicationService;
  repository: GitHubRepositoryIdentity;
  run: RepositoryRun;
  checkpoint: RepositoryCheckpoint;
  baseRef: string;
  commentIdentity: string;
  specDecision: Extract<SpecDecision, { outcome: "ready-for-review" }>;
  specProvenance: SpecProvenance;
  reviewDecision: SpecReviewDecision;
  reviewProvenance: SpecReviewProvenance;
  approved: boolean;
}>;

export async function publishReviewedSpecCheckpoint(
  input: PublishReviewedSpecInput,
): Promise<PublishReviewedSpecResult> {
  const claimed = await loadClaimedWorkItem(input.linear, input.authority, input.readiness);
  if (claimed.kind === "stale") return claimed;

  const reservedUrl = reservedPullRequestUrl(input.repository);
  const rendered = renderPublication(input, claimed.workItem, reservedUrl);
  if (rendered.kind === "invalid") return rendered;
  const pullRequest = await input.github.publishCheckpointPullRequest({
    run: input.run,
    checkpoint: input.checkpoint,
    baseBranch: input.baseRef,
    title: rendered.presentation.title,
    body: rendered.presentation.body,
  });
  const publicationError = validatePublishedPullRequest({
    pullRequest,
    checkpoint: input.checkpoint,
    run: input.run,
    repository: input.repository,
    reservedUrl,
  });
  if (publicationError) return { kind: "invalid", error: publicationError };
  return {
    kind: "published",
    pullRequest,
    marker: rendered.marker,
    comment: rendered.comment.replace(reservedUrl, () => pullRequest.url),
  };
}

function renderPublication(
  input: PublishReviewedSpecInput,
  workItem: Parameters<typeof renderReviewedSpecPullRequest>[0]["workItem"],
  reservedUrl: string,
):
  | Readonly<{
      kind: "rendered";
      presentation: ReturnType<typeof renderReviewedSpecPullRequest>;
      marker: string;
      comment: string;
    }>
  | Readonly<{ kind: "invalid"; error: string }> {
  try {
    const presentation = renderReviewedSpecPullRequest({
      workItem,
      specDecision: input.specDecision,
      specProvenance: input.specProvenance,
      reviewDecision: input.reviewDecision,
      reviewProvenance: input.reviewProvenance,
      approved: input.approved,
    });
    const marker = specCycleCommentMarker(
      input.commentIdentity,
      input.approved ? "approved" : "review-exhausted",
    );
    return {
      kind: "rendered",
      presentation,
      marker,
      comment: renderReviewedSpecOutcomeComment({
        marker,
        workItem,
        specDecision: input.specDecision,
        specProvenance: input.specProvenance,
        reviewDecision: input.reviewDecision,
        reviewProvenance: input.reviewProvenance,
        approved: input.approved,
        pullRequestUrl: reservedUrl,
      }),
    };
  } catch (error) {
    if (error instanceof SpecPresentationError) {
      return { kind: "invalid", error: error.message };
    }
    throw error;
  }
}

function validatePublishedPullRequest(input: {
  pullRequest: PublishedPullRequest;
  checkpoint: RepositoryCheckpoint;
  run: RepositoryRun;
  repository: GitHubRepositoryIdentity;
  reservedUrl: string;
}): string | null {
  if (input.pullRequest.state !== "open" || input.pullRequest.merged) {
    return "Spec publication recovered a closed or merged pull request.";
  }
  if (
    input.pullRequest.owner !== input.repository.owner ||
    input.pullRequest.repository !== input.repository.repository ||
    input.pullRequest.baseBranch !== input.run.baseRef ||
    input.pullRequest.headBranch !== input.run.branch ||
    input.pullRequest.headSha !== input.checkpoint.revision
  ) {
    return "Spec publication does not match the reviewed checkpoint identity.";
  }
  if (input.pullRequest.url.length > input.reservedUrl.length) {
    return "Spec pull-request URL exceeds the preflight reservation.";
  }
  return null;
}
