import { FactoryPlanningError } from "./factory-planning-schemas.ts";
import { parseFactoryWorkItemMetadata } from "./factory-schemas.ts";
import type { FactoryResolvedWorkItemInput } from "./factory-triage-input.ts";

export function assertFactoryPlanningLinearEntry(input: FactoryResolvedWorkItemInput): void {
  if (input.source !== "linear") return;

  let metadata;
  try {
    metadata = parseFactoryWorkItemMetadata(input.workItem.metadata);
  } catch (error) {
    throw new FactoryPlanningError("Invalid factory work item metadata for planning input.", {
      cause: error,
    });
  }
  if (metadata.factoryStage === "ready-to-plan" || metadata.factoryStage === "planning-failed") {
    return;
  }

  const status = typeof metadata.linearStatus === "string" ? ` (${metadata.linearStatus})` : "";
  throw new FactoryPlanningError(
    `Linear issue is in ${String(metadata.factoryStage ?? "unknown")}${status}; planning accepts Needs Plan or Planning Failed.`,
  );
}
