import type { FactoryArtifactRef } from "./factory-artifact-ref.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";

export class FactoryImplementationInputError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryImplementationInputError";
  }
}

export type FactoryImplementationInput =
  | {
      mode: "direct";
      importedEventId: string;
      workItem: FactoryArtifactRef;
      readinessEventId: string;
      readiness: FactoryArtifactRef;
    }
  | {
      mode: "planned";
      importedEventId: string;
      workItem: FactoryArtifactRef;
      candidateEventId: string;
      reviewEventId: string;
      planCandidate: FactoryArtifactRef;
      outputPlan: string;
      publicationMode: "local" | "pull-request";
      mergedEventId?: string;
      mergedUrl?: string;
      mergedCommit?: string;
    };

/** Resolve implementation authority only from immutable Factory events. */
export function resolveFactoryImplementationInput(
  events: FactoryLifecycleEvent[],
): FactoryImplementationInput {
  const imported = events.find((event) => event.type === "work_item.imported");
  if (!imported)
    throw new FactoryImplementationInputError("Implementation requires imported input");
  const direct = events.findLast(
    (event) =>
      event.type === "triage.work_item.completed" && event.data.route === "ready-to-implement",
  );
  const approvedReview = events.findLast(
    (event) => event.type === "planning.review.completed" && event.data.verdict === "pass",
  );
  const mergedPlan = events.findLast((event) => event.type === "plan_pr.merged");
  if (direct && !approvedReview) {
    if (direct.type !== "triage.work_item.completed")
      throw new FactoryImplementationInputError("Direct readiness event is invalid");
    const readiness = direct.data.evidence.at(-1);
    if (!readiness)
      throw new FactoryImplementationInputError(
        "Direct implementation readiness evidence is missing",
      );
    const request = events.findLast(
      (event) => event.type === "triage.requested" && event.id === direct.data.causationEventId,
    );
    const workItem = request?.type === "triage.requested" ? request.data.inputRefs[0] : undefined;
    if (!workItem)
      throw new FactoryImplementationInputError("Direct implementation work-item input is missing");
    return {
      mode: "direct",
      importedEventId: imported.id,
      workItem,
      readinessEventId: direct.id,
      readiness,
    };
  }

  const latest = mergedPlan ?? approvedReview;
  if (!latest)
    throw new FactoryImplementationInputError(
      "Implementation requires direct readiness or an approved planning result",
    );
  const phaseRunId = latest.phaseRunId;
  const candidate = events.findLast(
    (event) => event.type === "planning.candidate.produced" && event.phaseRunId === phaseRunId,
  );
  const review = events.findLast(
    (event) => event.type === "planning.review.completed" && event.phaseRunId === phaseRunId,
  );
  const request = events.findLast(
    (event) => event.type === "planning.requested" && event.phaseRunId === phaseRunId,
  );
  if (
    !candidate ||
    candidate.type !== "planning.candidate.produced" ||
    !review ||
    review.type !== "planning.review.completed" ||
    review.data.verdict !== "pass" ||
    !request ||
    request.type !== "planning.requested"
  )
    throw new FactoryImplementationInputError("Planned implementation input is incomplete");
  const base = {
    mode: "planned" as const,
    importedEventId: imported.id,
    workItem: request.data.inputRefs[0],
    candidateEventId: candidate.id,
    reviewEventId: review.id,
    planCandidate: candidate.data.candidate,
    outputPlan: request.data.outputPlan,
    publicationMode: request.data.publicationMode,
  };
  if (!base.workItem)
    throw new FactoryImplementationInputError("Planned implementation work-item input is missing");
  if (request.data.publicationMode === "local") return base;
  const merged = events.findLast(
    (event) => event.type === "plan_pr.merged" && event.phaseRunId === phaseRunId,
  );
  if (!merged || merged.type !== "plan_pr.merged")
    throw new FactoryImplementationInputError("Pull-request plan must be recorded as merged");
  return {
    ...base,
    mergedEventId: merged.id,
    mergedUrl: merged.data.url,
    mergedCommit: merged.data.commit,
  };
}
