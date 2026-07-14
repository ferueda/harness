import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { z } from "zod";
import type { AgentSessionRef } from "./agents.ts";
import { loadFactoryContinuationForReaction } from "./factory-continuation.ts";
import { verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import {
  FactoryImplementationBlockingFindingsSchema,
  FactoryImplementationCandidateEvidenceSchema,
  FactoryImplementationReviewEvidenceSchema,
  collectImplementationBlockingFindings,
} from "./factory-implementation-review-evidence.ts";
import type { FactoryImplementationRunContext } from "./factory-implementation-run-context.ts";
import { readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { readFactoryWorkspaceTree } from "./factory-review-head.ts";
import type { FactoryReaction } from "./factory-state-machine.ts";

export type FactoryImplementationRevision = {
  blockingFindings: z.infer<typeof FactoryImplementationBlockingFindingsSchema> | [];
  candidateEventId: string;
  operatorResponse: string;
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
  const roots = factoryRoots(ctx);
  let continuation: ReturnType<typeof loadFactoryContinuationForReaction>;
  try {
    continuation = loadFactoryContinuationForReaction({
      events,
      causationEventId: reaction.causationEventId,
      phase: "implementation",
      handler: "produceImplementationCandidate",
      attempt: reaction.attempt,
      phaseRunId: ctx.runId,
      workItemKey,
      roots,
    });
  } catch (error) {
    throw new FactoryImplementationRevisionError(message(error));
  }
  if (!continuation || continuation.event.data.decision !== "revise")
    throw new FactoryImplementationRevisionError(
      "Implementation revision has no accepted continuation",
    );
  const candidate = continuation.candidate;
  if (candidate.type !== "implementation.candidate.produced")
    throw new FactoryImplementationRevisionError(
      "Implementation revision has no matching prior candidate",
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
  if (continuation.review && continuation.review.type !== "implementation.review.completed")
    throw new FactoryImplementationRevisionError(
      "Implementation continuation review has the wrong phase",
    );
  const blockingFindings = continuation.review
    ? loadBlockingFindings({ ctx, candidate, review: continuation.review, roots })
    : [];
  return {
    blockingFindings,
    candidateEventId: candidate.id,
    operatorResponse: continuation.response,
    priorCommit: candidateEvidence.commit,
    priorTree: candidateEvidence.tree,
    priorStatus: candidateEvidence.status,
    session: candidateEvidence.effectiveSession,
  };
}

function loadBlockingFindings(input: {
  ctx: FactoryImplementationRunContext;
  candidate: Extract<FactoryLifecycleEvent, { type: "implementation.candidate.produced" }>;
  review: Extract<FactoryLifecycleEvent, { type: "implementation.review.completed" }>;
  roots: ReturnType<typeof factoryRoots>;
}): z.infer<typeof FactoryImplementationBlockingFindingsSchema> | [] {
  if (input.review.type !== "implementation.review.completed")
    throw new FactoryImplementationRevisionError("Implementation continuation review is invalid");
  if (
    input.review.data.candidateEventId !== input.candidate.id ||
    input.review.data.candidateAttempt !== input.candidate.data.attempt
  )
    throw new FactoryImplementationRevisionError(
      "Implementation continuation review conflicts with its candidate",
    );
  const manifest = FactoryImplementationReviewEvidenceSchema.parse(
    JSON.parse(
      readFileSync(verifyFactoryArtifactRef(input.review.data.review, input.roots), "utf8"),
    ),
  );
  if (
    manifest.phaseRunId !== input.ctx.runId ||
    manifest.reviewRound !== input.review.data.attempt ||
    manifest.candidateAttempt !== input.candidate.data.attempt ||
    manifest.base !== input.ctx.identity.baseSha ||
    manifest.commit !== input.candidate.data.commit ||
    manifest.tree !== input.candidate.data.tree ||
    manifest.verdict !== input.review.data.verdict ||
    JSON.stringify(manifest.blockingFindings) !== JSON.stringify(input.review.data.blockingFindings)
  )
    throw new FactoryImplementationRevisionError(
      "Implementation revision review manifest conflicts with lifecycle evidence",
    );
  if (!input.review.data.blockingFindings) return [];
  const blocking = FactoryImplementationBlockingFindingsSchema.parse(
    JSON.parse(
      readFileSync(
        verifyFactoryArtifactRef(input.review.data.blockingFindings, input.roots),
        "utf8",
      ),
    ),
  );
  const expected = collectImplementationBlockingFindings({
    implementationPath: verifyFactoryArtifactRef(manifest.reviewers.implementation, input.roots),
    qualityPath: verifyFactoryArtifactRef(manifest.reviewers.quality, input.roots),
  });
  if (JSON.stringify(blocking) !== JSON.stringify(expected))
    throw new FactoryImplementationRevisionError(
      "Implementation revision blocking findings conflict with aggregate review",
    );
  return blocking;
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
