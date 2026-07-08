import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { FactoryPlanningRunMeta } from "./factory-planning-run-context.ts";
import { FactoryPlanningError } from "./factory-planning-schemas.ts";
import { FactoryWorkItemMetadataSchema, type FactoryWorkItemMetadata } from "./factory-schemas.ts";
import { formatZodError } from "./schemas.ts";

export const FactoryPlanningRunMetaSchema = z
  .object({
    runId: z.string().min(1),
    workflow: z.literal("factory-planning"),
    status: z.enum([
      "dry_run",
      "plan-approved",
      "plan-needs-human",
      "plan-review-unresolved",
      "planning-failed",
    ]),
    workspace: z.string().min(1),
    runDir: z.string().min(1),
    workItem: z
      .object({
        id: z.string().min(1),
        source: z.string().min(1),
        title: z.string().min(1),
      })
      .passthrough(),
    outputPlan: z.string().min(1).optional(),
    factoryMetadata: FactoryWorkItemMetadataSchema.optional(),
    iterations: z.array(z.object({ index: z.number() }).passthrough()),
  })
  .passthrough();

export type FactoryPlanningHandoffPatch = {
  approvedPlanPrUrl?: string;
  approvedPlanCommit?: string;
  factoryStage?: "plan-pr-open" | "plan-approved";
};

export type PlannedWorkHandoff = {
  planPath: string;
  approvedPlanCommit: string;
};

export function loadFactoryPlanningRunMeta(runDir: string): FactoryPlanningRunMeta {
  const metaPath = join(resolve(runDir), "meta.json");
  const parsed = FactoryPlanningRunMetaSchema.safeParse(JSON.parse(readFileSync(metaPath, "utf8")));
  if (!parsed.success) {
    throw new FactoryPlanningError(
      `Invalid factory planning meta: ${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data as FactoryPlanningRunMeta;
}

export function updateFactoryPlanningHandoff(
  runDir: string,
  patch: FactoryPlanningHandoffPatch,
): FactoryPlanningRunMeta {
  const resolvedRunDir = resolve(runDir);
  const meta = loadFactoryPlanningRunMeta(resolvedRunDir);
  const metadata = meta.factoryMetadata ?? {};
  validatePublicationPatch(meta, patch);

  const parsedMetadata = FactoryWorkItemMetadataSchema.safeParse({
    ...metadata,
    ...patch,
  });
  if (!parsedMetadata.success) {
    throw new FactoryPlanningError(
      `Invalid factory planning handoff metadata: ${formatZodError(parsedMetadata.error)}`,
    );
  }
  const updated: FactoryPlanningRunMeta = {
    ...meta,
    factoryMetadata: parsedMetadata.data,
  };
  writeJson(join(resolvedRunDir, "meta.json"), updated);
  writeFileSync(join(resolvedRunDir, "summary.md"), renderFactoryPlanningSummary(updated), "utf8");
  return updated;
}

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

export function validatePlannedWorkHandoff(
  metadata: FactoryWorkItemMetadata,
  workspace: string,
): PlannedWorkHandoff {
  if (metadata.factoryStage !== "plan-approved") {
    throw new FactoryPlanningError(
      `Planned work is not ready to implement: factoryStage=${metadata.factoryStage ?? "none"}`,
    );
  }
  if (!metadata.approvedPlanPath) {
    throw new FactoryPlanningError("Planned work is missing approvedPlanPath");
  }
  if (!metadata.approvedPlanCommit) {
    throw new FactoryPlanningError("Planned work is missing approvedPlanCommit");
  }
  const planPath = resolveWorkspacePath(workspace, metadata.approvedPlanPath);
  if (!existsSync(planPath)) {
    throw new FactoryPlanningError(`Approved plan does not exist: ${metadata.approvedPlanPath}`);
  }
  return {
    planPath,
    approvedPlanCommit: metadata.approvedPlanCommit,
  };
}

function validatePublicationPatch(
  meta: FactoryPlanningRunMeta,
  patch: FactoryPlanningHandoffPatch,
): void {
  if (meta.workflow !== "factory-planning") {
    throw new FactoryPlanningError(`Run is not a factory planning run: ${meta.workflow}`);
  }
  if (meta.status !== "plan-approved") {
    throw new FactoryPlanningError(`Planning run is not approved: ${meta.status}`);
  }
  const metadata = meta.factoryMetadata;
  if (!metadata?.approvedPlanPath) {
    throw new FactoryPlanningError("Planning run is missing approvedPlanPath");
  }
  if (!isTrackerBackedPlanningHandoff(metadata)) {
    throw new FactoryPlanningError("Planning publication requires tracker-backed metadata");
  }
  if (patch.approvedPlanPrUrl !== undefined) {
    const url = z.url().safeParse(patch.approvedPlanPrUrl);
    if (!url.success) {
      throw new FactoryPlanningError(`Invalid plan PR URL: ${patch.approvedPlanPrUrl}`);
    }
    if (metadata.approvedPlanCommit) {
      throw new FactoryPlanningError("Planning run already has approvedPlanCommit");
    }
    if (metadata.approvedPlanPrUrl && metadata.approvedPlanPrUrl !== patch.approvedPlanPrUrl) {
      throw new FactoryPlanningError("Planning run already has a different approvedPlanPrUrl");
    }
  }
  if (patch.approvedPlanCommit !== undefined) {
    if (patch.approvedPlanCommit.trim().length === 0) {
      throw new FactoryPlanningError("approvedPlanCommit must be non-empty");
    }
    if (!metadata.approvedPlanPrUrl) {
      throw new FactoryPlanningError("Planning run is missing approvedPlanPrUrl");
    }
    if (metadata.approvedPlanCommit && metadata.approvedPlanCommit !== patch.approvedPlanCommit) {
      throw new FactoryPlanningError("Planning run already has a different approvedPlanCommit");
    }
  }
}

function isTrackerBackedPlanningHandoff(metadata: FactoryWorkItemMetadata): boolean {
  const source = metadata.tracker?.source;
  return source === "linear" || source === "github";
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

function resolveWorkspacePath(workspace: string, path: string): string {
  const resolvedWorkspace = resolve(workspace);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const rel = relative(resolvedWorkspace, resolvedPath);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) {
    throw new FactoryPlanningError(`Path must be inside workspace: ${path}`);
  }
  return resolvedPath;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
