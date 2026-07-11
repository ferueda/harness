import {
  validateApprovedPlanArtifacts,
  validatePlannedWorkHandoff,
} from "./factory-planning-handoff.ts";
import { parseFactoryWorkItemMetadata, type FactoryWorkItemMetadata } from "./factory-schemas.ts";
import type { FactoryResolvedWorkItemInput } from "./factory-triage-input.ts";

export class FactoryImplementationInputError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryImplementationInputError";
  }
}

export type FactoryImplementationSourceMaterial = {
  title: string;
  body: string;
  labels: string[];
  url?: string;
  tracker?: FactoryWorkItemMetadata["tracker"];
};

export type FactoryPlannedImplementationInput = {
  mode: "planned";
  source: FactoryResolvedWorkItemInput["source"];
  workItem: FactoryResolvedWorkItemInput["workItem"];
  metadata: FactoryWorkItemMetadata;
  approvedPlanPath: string;
  planPath: string;
  approvedPlanCommit: string;
};

export type FactoryDirectImplementationInput = {
  mode: "direct";
  source: FactoryResolvedWorkItemInput["source"];
  workItem: FactoryResolvedWorkItemInput["workItem"];
  metadata: FactoryWorkItemMetadata;
  sourceMaterial: FactoryImplementationSourceMaterial;
};

export type FactoryImplementationInput =
  | FactoryPlannedImplementationInput
  | FactoryDirectImplementationInput;

export type FactoryImplementationAttempt = "first" | "retry";

export type FactoryImplementationLinearProjection = {
  mode: "observe" | "apply";
  readyToImplement: string;
  implementationFailed: string;
};

export function resolveFactoryImplementationInput(input: {
  workspace: string;
  resolvedInput: FactoryResolvedWorkItemInput;
  linearProjection?: FactoryImplementationLinearProjection;
  /** Compatibility input for existing observe-only callers. */
  linearReadyStatus?: string;
}): FactoryImplementationInput {
  const metadata = parseImplementationMetadata(input.resolvedInput.workItem.metadata);
  const base = {
    source: input.resolvedInput.source,
    workItem: input.resolvedInput.workItem,
    metadata,
  };

  if (input.resolvedInput.source === "linear") {
    const legacyProjection = !input.linearProjection;
    assertLinearProjection(
      metadata,
      input.linearProjection ??
        (input.linearReadyStatus
          ? {
              mode: "observe",
              readyToImplement: input.linearReadyStatus,
              implementationFailed: "Implementation Failed",
            }
          : undefined),
      legacyProjection,
    );
  }

  // Any publication signal means planned work; validate it before direct mode.
  if (hasAnyPlannedPublicationSignal(metadata)) {
    const handoff =
      metadata.factoryStage === "implementation-failed" &&
      input.resolvedInput.source === "linear" &&
      input.linearProjection?.mode === "apply"
        ? validateApprovedPlanArtifacts(metadata, input.workspace)
        : validatePlannedWorkHandoff(metadata, input.workspace);
    const approvedPlanPath = metadata.approvedPlanPath;
    if (!approvedPlanPath) {
      throw new FactoryImplementationInputError(
        "Planned implementation input is missing approvedPlanPath after handoff validation.",
      );
    }
    return {
      mode: "planned",
      ...base,
      approvedPlanPath,
      planPath: handoff.planPath,
      approvedPlanCommit: handoff.approvedPlanCommit,
    };
  }

  if (hasAllDirectMarkers(metadata, input.linearProjection)) {
    return {
      mode: "direct",
      ...base,
      sourceMaterial: {
        title: input.resolvedInput.workItem.title,
        body: input.resolvedInput.workItem.body,
        labels: [...input.resolvedInput.workItem.labels],
        ...(input.resolvedInput.workItem.url ? { url: input.resolvedInput.workItem.url } : {}),
        ...(metadata.tracker ? { tracker: metadata.tracker } : {}),
      },
    };
  }

  throw new FactoryImplementationInputError(
    `Factory work item is not ready for implementation: factoryStage=${metadata.factoryStage ?? "none"}, factoryRoute=${metadata.factoryRoute ?? "none"}, factoryNextAction=${metadata.factoryNextAction ?? "none"}, linearStatus=${metadata.linearStatus ?? "none"}`,
  );
}

function parseImplementationMetadata(value: unknown): FactoryWorkItemMetadata {
  try {
    return parseFactoryWorkItemMetadata(value);
  } catch (error) {
    throw new FactoryImplementationInputError(
      "Invalid factory work item metadata for implementation input.",
      { cause: error },
    );
  }
}

export function factoryImplementationAttempt(
  implementationInput: FactoryImplementationInput,
): FactoryImplementationAttempt {
  return implementationAttemptForMetadata(implementationInput.metadata);
}

function implementationAttemptForMetadata(
  metadata: FactoryWorkItemMetadata,
): FactoryImplementationAttempt {
  return metadata.factoryStage === "implementation-failed" ? "retry" : "first";
}

function assertLinearProjection(
  metadata: FactoryWorkItemMetadata,
  projection: FactoryImplementationLinearProjection | undefined,
  legacyProjection: boolean,
): void {
  if (!projection?.readyToImplement.trim() || !projection.implementationFailed.trim()) {
    throw new FactoryImplementationInputError(
      legacyProjection
        ? "linearReadyStatus is required for Linear implementation input."
        : "Linear implementation projection statuses are required for Linear implementation input.",
    );
  }
  const attempt = implementationAttemptForMetadata(metadata);
  if (attempt === "retry" && projection.mode !== "apply") {
    throw new FactoryImplementationInputError("Linear implementation retries require --apply.");
  }
  const expected =
    attempt === "retry" ? projection.implementationFailed : projection.readyToImplement;
  if (!sameStatus(metadata.linearStatus, expected)) {
    throw new FactoryImplementationInputError(
      `Linear issue is in ${String(metadata.linearStatus ?? "none")}; implementation${attempt === "first" ? "" : ` ${attempt} runs`} accepts ${expected}.`,
    );
  }
}

function sameStatus(left: unknown, right: string): boolean {
  return typeof left === "string" && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function hasAnyPlannedPublicationSignal(metadata: FactoryWorkItemMetadata): boolean {
  return (
    metadata.factoryStage === "plan-approved" ||
    metadata.factoryStage === "plan-pr-open" ||
    Boolean(metadata.approvedPlanPath) ||
    Boolean(metadata.approvedPlanPrUrl) ||
    Boolean(metadata.approvedPlanCommit)
  );
}

function hasAllDirectMarkers(
  metadata: FactoryWorkItemMetadata,
  projection: FactoryImplementationLinearProjection | undefined,
): boolean {
  return (
    (metadata.factoryStage === "ready-to-implement" ||
      (metadata.factoryStage === "implementation-failed" && projection?.mode === "apply")) &&
    metadata.factoryRoute === "ready-to-implement" &&
    metadata.factoryNextAction === "implement-directly"
  );
}
