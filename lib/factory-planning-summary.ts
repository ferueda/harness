import type { FactoryPlanningRunMeta } from "./factory-planning-run-context.ts";
import type { FactoryWorkItemMetadata } from "./factory-schemas.ts";

export function renderFactoryPlanningSummary(meta: FactoryPlanningRunMeta): string {
  const metadata = meta.factoryMetadata;
  const lines = [
    "# Factory Planning",
    "",
    "## Work item",
    "",
    `- ${meta.workItem.id}: ${meta.workItem.title}`,
    "",
    "## Status",
    "",
    `- ${meta.status}`,
    "",
    "## Output plan",
    "",
    meta.outputPlan ? `- ${meta.outputPlan}` : "- None",
    "",
    "## Handoff",
    "",
    metadata?.factoryStage ? `- Stage: ${metadata.factoryStage}` : "- Stage: None",
    metadata?.approvedPlanPath
      ? `- Approved plan path: ${metadata.approvedPlanPath}`
      : "- Approved plan path: None",
    metadata?.approvedPlanPrUrl ? `- Plan PR: ${metadata.approvedPlanPrUrl}` : "- Plan PR: None",
    metadata?.approvedPlanCommit
      ? `- Approved plan commit: ${metadata.approvedPlanCommit}`
      : "- Approved plan commit: None",
    `- Next action: ${planningNextAction(metadata)}`,
    "",
    "## Iterations",
    "",
  ];
  if (meta.status === "dry_run") {
    lines.push("- Dry-run placeholder; providers and reviewers were not called.");
  } else if (meta.iterations.length === 0) {
    lines.push("- None");
  } else {
    for (const iteration of meta.iterations) {
      lines.push(`- ${iteration.index}: ${iteration.planPath ?? "(no plan draft)"}`);
      if (iteration.review) {
        lines.push(`  - Review: ${iteration.review.runDir}`);
        lines.push(`  - Findings: ${iteration.review.specReviewPath}`);
      }
    }
  }
  lines.push("", "## Human questions", "");
  if (meta.humanQuestions?.length) {
    for (const question of meta.humanQuestions) lines.push(`- ${question}`);
  } else {
    lines.push("- None");
  }
  lines.push("", "## Error", "", meta.error ? `- ${meta.error}` : "- None", "");
  return lines.join("\n");
}

function planningNextAction(metadata: FactoryWorkItemMetadata | undefined): string {
  if (metadata?.factoryStage === "plan-pr-open" && !metadata.approvedPlanPrUrl) {
    return "Open a plan PR, then register it with publish.";
  }
  if (metadata?.factoryStage === "plan-pr-open") {
    return "Merge the plan PR, then register the commit with mark-plan-merged.";
  }
  if (metadata?.factoryStage === "plan-approved" && metadata.approvedPlanCommit) {
    return "Ready to implement.";
  }
  return "None";
}
