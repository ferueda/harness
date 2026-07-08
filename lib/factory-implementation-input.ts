import { validatePlannedWorkHandoff } from "./factory-planning-handoff.ts";
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

export function resolveFactoryImplementationInput(input: {
  workspace: string;
  resolvedInput: FactoryResolvedWorkItemInput;
  linearReadyStatus?: string;
}): FactoryImplementationInput {
  const metadata = parseImplementationMetadata(input.resolvedInput.workItem.metadata);
  const base = {
    source: input.resolvedInput.source,
    workItem: input.resolvedInput.workItem,
    metadata,
  };

  if (input.resolvedInput.source === "linear") {
    assertLinearReadyProjection(metadata, input.linearReadyStatus);
  }

  // Any publication signal means planned work; validate it before direct mode.
  if (hasAnyPlannedPublicationSignal(metadata)) {
    const handoff = validatePlannedWorkHandoff(metadata, input.workspace);
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

  if (hasAllDirectMarkers(metadata)) {
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

function assertLinearReadyProjection(
  metadata: FactoryWorkItemMetadata,
  linearReadyStatus: string | undefined,
): void {
  if (!linearReadyStatus?.trim()) {
    throw new FactoryImplementationInputError(
      "linearReadyStatus is required for Linear implementation input.",
    );
  }
  if (metadata.linearStatus !== linearReadyStatus) {
    throw new FactoryImplementationInputError(
      `Linear issue is in ${String(metadata.linearStatus ?? "none")}; implementation accepts ${linearReadyStatus}.`,
    );
  }
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

function hasAllDirectMarkers(metadata: FactoryWorkItemMetadata): boolean {
  return (
    metadata.factoryStage === "ready-to-implement" &&
    metadata.factoryRoute === "ready-to-implement" &&
    metadata.factoryNextAction === "implement-directly"
  );
}
