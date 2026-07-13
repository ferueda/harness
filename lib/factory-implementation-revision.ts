import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { z } from "zod";
import type { AgentSessionRef } from "./agents.ts";
import { verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import {
  FactoryImplementationBlockingFindingsSchema,
  FactoryImplementationCandidateEvidenceSchema,
  FactoryImplementationReviewEvidenceSchema,
  collectImplementationBlockingFindings,
} from "./factory-implementation-review-evidence.ts";
import type { FactoryImplementationRunContext } from "./factory-implementation-run-context.ts";
import { readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { readFactoryWorkspaceTree } from "./factory-review-head.ts";
import type { FactoryReaction } from "./factory-state-machine.ts";

export type FactoryImplementationRevision = {
  blockingFindings: z.infer<typeof FactoryImplementationBlockingFindingsSchema>;
  priorCommit: string;
  priorTree: string;
  priorStatus: string;
  session: AgentSessionRef;
};

export class FactoryImplementationRevisionError extends Error {
  readonly failureKind: "human-required" | "terminal";

  constructor(message: string, failureKind: "human-required" | "terminal" = "terminal") {
    super(message);
    this.failureKind = failureKind;
  }
}

export function loadFactoryImplementationRevision(input: {
  ctx: FactoryImplementationRunContext;
  factoryStateRoot: string;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
}): FactoryImplementationRevision {
  const { ctx, reaction } = input;
  const workItemKey = deriveFactoryWorkItemKey(ctx.workItem);
  const events = readFactoryActionEvents(input.factoryStateRoot, workItemKey);
  const review = events.find((event) => event.id === reaction.causationEventId);
  if (
    !review ||
    review.type !== "implementation.review.completed" ||
    review.phaseRunId !== ctx.runId ||
    review.workItemKey !== workItemKey ||
    review.data.verdict !== "needs_changes" ||
    review.data.attempt !== reaction.attempt - 1 ||
    review.data.reviewCeiling !== ctx.identity.reviewCeiling ||
    !review.data.blockingFindings
  )
    throw new FactoryImplementationRevisionError(
      "Implementation revision causation conflicts with durable review evidence",
    );
  const roots = factoryRoots(ctx);
  const candidate = events.find((event) => event.id === review.data.causationEventId);
  if (
    !candidate ||
    candidate.type !== "implementation.candidate.produced" ||
    candidate.phaseRunId !== ctx.runId ||
    candidate.workItemKey !== workItemKey ||
    candidate.data.attempt !== review.data.attempt
  )
    throw new FactoryImplementationRevisionError(
      "Implementation revision has no matching prior candidate",
    );
  const manifest = FactoryImplementationReviewEvidenceSchema.parse(
    JSON.parse(readFileSync(verifyFactoryArtifactRef(review.data.review, roots), "utf8")),
  );
  if (
    manifest.phaseRunId !== ctx.runId ||
    manifest.attempt !== review.data.attempt ||
    manifest.base !== ctx.identity.baseSha ||
    manifest.commit !== candidate.data.commit ||
    manifest.tree !== candidate.data.tree ||
    manifest.verdict !== "needs_changes" ||
    JSON.stringify(manifest.blockingFindings) !== JSON.stringify(review.data.blockingFindings)
  )
    throw new FactoryImplementationRevisionError(
      "Implementation revision review manifest conflicts with lifecycle evidence",
    );
  const blockingFindings = FactoryImplementationBlockingFindingsSchema.parse(
    JSON.parse(readFileSync(verifyFactoryArtifactRef(review.data.blockingFindings, roots), "utf8")),
  );
  const expectedBlocking = collectImplementationBlockingFindings({
    implementationPath: verifyFactoryArtifactRef(manifest.reviewers.implementation, roots),
    qualityPath: verifyFactoryArtifactRef(manifest.reviewers.quality, roots),
  });
  if (JSON.stringify(blockingFindings) !== JSON.stringify(expectedBlocking))
    throw new FactoryImplementationRevisionError(
      "Implementation revision blocking findings conflict with aggregate review",
    );
  const candidateEvidence = FactoryImplementationCandidateEvidenceSchema.parse(
    JSON.parse(readFileSync(verifyFactoryArtifactRef(candidate.data.candidate, roots), "utf8")),
  );
  const profile = ctx.identity.actions.produceImplementationCandidate;
  if (
    candidateEvidence.phaseRunId !== ctx.runId ||
    candidateEvidence.attempt !== candidate.data.attempt ||
    candidateEvidence.base !== ctx.identity.baseSha ||
    candidateEvidence.ref !== `refs/harness/factory/${ctx.runId}/${candidate.data.attempt}` ||
    candidateEvidence.commit !== candidate.data.commit ||
    candidateEvidence.tree !== candidate.data.tree ||
    candidateEvidence.effectiveSession.provider !== candidate.data.effectiveSession.provider ||
    candidateEvidence.effectiveSession.id !== candidate.data.effectiveSession.id ||
    candidateEvidence.effectiveSession.provider !== profile.provider
  )
    throw new FactoryImplementationRevisionError(
      "Implementation revision candidate evidence conflicts with lifecycle identity",
      candidateEvidence.effectiveSession.provider !== profile.provider
        ? "human-required"
        : "terminal",
    );
  for (const artifact of Object.values(candidateEvidence.artifacts))
    verifyFactoryArtifactRef(artifact, roots);
  if (
    git(ctx.workspace, ["rev-parse", candidateEvidence.ref]).trim() !== candidateEvidence.commit ||
    git(ctx.workspace, ["rev-parse", `${candidateEvidence.commit}^`]).trim() !==
      ctx.identity.baseSha ||
    git(ctx.workspace, ["rev-parse", `${candidateEvidence.commit}^{tree}`]).trim() !==
      candidateEvidence.tree
  )
    throw new FactoryImplementationRevisionError(
      "Implementation revision prior candidate Git evidence conflicts",
    );
  return {
    blockingFindings,
    priorCommit: candidateEvidence.commit,
    priorTree: candidateEvidence.tree,
    priorStatus: candidateEvidence.status,
    session: candidateEvidence.effectiveSession,
  };
}

export function matchesFactoryImplementationRevisionWorkspace(input: {
  ctx: FactoryImplementationRunContext;
  facts: { head: string; branchRef: string; status: string; refs: string; indexClean: boolean };
  revision: FactoryImplementationRevision;
}): boolean {
  if (
    input.facts.head !== input.ctx.identity.baseSha ||
    input.facts.branchRef !== input.ctx.identity.branchRef ||
    !input.facts.indexClean ||
    input.facts.status !== input.revision.priorStatus
  )
    return false;
  const live = readFactoryWorkspaceTree({
    workspace: input.ctx.workspace,
    runDir: input.ctx.runDir,
    baseSha: input.ctx.identity.baseSha,
  });
  return live.tree === input.revision.priorTree && live.status === input.revision.priorStatus;
}

function factoryRoots(ctx: FactoryImplementationRunContext) {
  return { "factory-store": ctx.factoryStore.projectRoot, repository: ctx.workspace } as const;
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
