import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FactoryRoleAgent } from "./config.ts";
import { buildRunId } from "./context.ts";
import { factoryRoleAgentMeta, type FactoryStationAgentMeta } from "./factory-agent-meta.ts";
import type { FactoryImplementationInput } from "./factory-implementation-input.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";

export const FACTORY_IMPLEMENTATION_WORKFLOW = "factory-implementation" as const;
export const FACTORY_IMPLEMENTATION_DRY_RUN_ERROR =
  "Factory implementation station only supports --dry-run in v1";

export class FactoryImplementationRunError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryImplementationRunError";
  }
}

export type FactoryImplementationRunStatus = "dry_run";

export type FactoryImplementationAgentMeta = FactoryStationAgentMeta;

export type FactoryImplementationArtifacts = {
  workItem: string;
  implementationInput: string;
  planRef?: string;
  sourceMaterial?: string;
  prompt: string;
  changeReviewHandoff: string;
  summary: string;
  meta: string;
};

export type FactoryImplementationRunMeta = {
  runId: string;
  workflow: typeof FACTORY_IMPLEMENTATION_WORKFLOW;
  status: FactoryImplementationRunStatus;
  mode: FactoryImplementationInput["mode"];
  workspace: string;
  runDir: string;
  workItem: {
    id: string;
    source: FactoryWorkItem["source"];
    title: string;
  };
  implementerAgent: FactoryImplementationAgentMeta;
  artifacts: FactoryImplementationArtifacts;
  summaryPath: string;
  metaPath: string;
  startedAt: string;
  durationMs: number;
};

export type FactoryImplementationRunContextOptions = {
  workspace: string;
  runsDir?: string;
  workItem: FactoryWorkItem;
  implementationInput: FactoryImplementationInput;
  implementerRole: FactoryRoleAgent;
  dryRun?: boolean;
};

export type FactoryImplementationRunContext = {
  runId: string;
  runDir: string;
  workspace: string;
  startedAt: Date;
  workItem: FactoryWorkItem;
  implementationInput: FactoryImplementationInput;
  implementerAgent: FactoryImplementationAgentMeta;
  dryRun?: boolean;
  writeImplementationArtifacts(input: { prompt: string; changeReviewHandoff: string }): void;
  export(): FactoryImplementationRunMeta;
};

export function createFactoryImplementationRunContext(
  options: FactoryImplementationRunContextOptions,
): FactoryImplementationRunContext {
  return createFactoryImplementationRunContextInternal(options);
}

// Test-only seam; production callers should use createFactoryImplementationRunContext.
export function createFactoryImplementationRunContextForTest(
  options: FactoryImplementationRunContextOptions,
): FactoryImplementationRunContext {
  return createFactoryImplementationRunContextInternal(options);
}

function createFactoryImplementationRunContextInternal(
  options: FactoryImplementationRunContextOptions,
): FactoryImplementationRunContext {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) {
    throw new FactoryImplementationRunError(`Workspace does not exist: ${workspace}`);
  }

  const startedAt = new Date();
  const runId = buildRunId(startedAt);
  const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/factory")), runId);
  const implementerAgent = factoryRoleAgentMeta(options.implementerRole);

  try {
    mkdirSync(join(runDir, "context"), { recursive: true });
    mkdirSync(join(runDir, "implementation"), { recursive: true });
    writeJson(join(runDir, "context/work-item.json"), options.workItem);
    writeJson(join(runDir, "context/implementation-input.json"), options.implementationInput);
    if (options.implementationInput.mode === "planned") {
      writeJson(join(runDir, "context/plan-ref.json"), {
        approvedPlanPath: options.implementationInput.approvedPlanPath,
        planPath: options.implementationInput.planPath,
        approvedPlanCommit: options.implementationInput.approvedPlanCommit,
        ...(options.implementationInput.metadata.tracker
          ? { tracker: options.implementationInput.metadata.tracker }
          : {}),
      });
    } else {
      writeJson(
        join(runDir, "context/source-material.json"),
        options.implementationInput.sourceMaterial,
      );
    }
  } catch (error) {
    cleanupOrphanedFactoryImplementationRunDir(runDir);
    throw asFactoryImplementationRunError(error);
  }

  return {
    runId,
    runDir,
    workspace,
    startedAt,
    workItem: options.workItem,
    implementationInput: options.implementationInput,
    implementerAgent,
    dryRun: options.dryRun,
    writeImplementationArtifacts(input): void {
      writeFileSync(join(runDir, "implementation/prompt.md"), input.prompt, "utf8");
      writeFileSync(
        join(runDir, "implementation/change-review-handoff.md"),
        input.changeReviewHandoff,
        "utf8",
      );
    },
    export(): FactoryImplementationRunMeta {
      const meta = buildMeta({
        startedAt,
        runId,
        runDir,
        workspace,
        workItem: options.workItem,
        mode: options.implementationInput.mode,
        implementerAgent,
      });
      writeFileSync(
        join(runDir, "summary.md"),
        renderSummary(meta, options.implementationInput),
        "utf8",
      );
      writeJson(join(runDir, "meta.json"), meta);
      return meta;
    },
  };
}

function buildMeta(input: {
  startedAt: Date;
  runId: string;
  runDir: string;
  workspace: string;
  workItem: FactoryWorkItem;
  mode: FactoryImplementationInput["mode"];
  implementerAgent: FactoryImplementationAgentMeta;
}): FactoryImplementationRunMeta {
  const artifacts = {
    workItem: "context/work-item.json",
    implementationInput: "context/implementation-input.json",
    ...(input.mode === "planned"
      ? { planRef: "context/plan-ref.json" }
      : { sourceMaterial: "context/source-material.json" }),
    prompt: "implementation/prompt.md",
    changeReviewHandoff: "implementation/change-review-handoff.md",
    summary: "summary.md",
    meta: "meta.json",
  };
  return {
    runId: input.runId,
    workflow: FACTORY_IMPLEMENTATION_WORKFLOW,
    status: "dry_run",
    mode: input.mode,
    workspace: input.workspace,
    runDir: input.runDir,
    workItem: {
      id: input.workItem.id,
      source: input.workItem.source,
      title: input.workItem.title,
    },
    implementerAgent: input.implementerAgent,
    artifacts,
    summaryPath: join(input.runDir, "summary.md"),
    metaPath: join(input.runDir, "meta.json"),
    startedAt: input.startedAt.toISOString(),
    durationMs: Date.now() - input.startedAt.getTime(),
  };
}

function renderSummary(
  meta: FactoryImplementationRunMeta,
  implementationInput: FactoryImplementationInput,
): string {
  const modeDetails =
    implementationInput.mode === "planned"
      ? [
          "## Planned Input",
          "",
          `- Approved plan path: ${implementationInput.approvedPlanPath}`,
          `- Plan path: ${implementationInput.planPath}`,
          `- Approved plan commit: ${implementationInput.approvedPlanCommit}`,
        ]
      : [
          "## Direct Input",
          "",
          `- Source title: ${implementationInput.sourceMaterial.title}`,
          ...(implementationInput.sourceMaterial.url
            ? [`- Source URL: ${implementationInput.sourceMaterial.url}`]
            : []),
          ...(implementationInput.sourceMaterial.tracker
            ? [`- Tracker: ${JSON.stringify(implementationInput.sourceMaterial.tracker)}`]
            : []),
        ];
  return [
    "# Factory Implementation",
    "",
    `- Run: ${meta.runId}`,
    `- Status: ${meta.status}`,
    `- Mode: ${meta.mode}`,
    `- Work item: ${meta.workItem.id} - ${meta.workItem.title}`,
    `- Implementer: ${meta.implementerAgent.name} ${meta.implementerAgent.model}`,
    "",
    "## Artifacts",
    "",
    ...Object.entries(meta.artifacts).map(([key, path]) => `- ${key}: ${path}`),
    "",
    ...modeDetails,
    "",
    "## Actions",
    "",
    "- Provider invocation: not run.",
    "- Reviewer invocation: not run.",
    "- Lifecycle events: not written.",
    "- Linear mutation: not run.",
    "- GitHub/PR mutation: not run.",
    "- Branch/worktree orchestration: not run.",
    "",
  ].join("\n");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function cleanupOrphanedFactoryImplementationRunDir(runDir: string): boolean {
  if (existsSync(join(runDir, "meta.json"))) {
    return false;
  }
  rmSync(runDir, { recursive: true, force: true });
  return true;
}

function asFactoryImplementationRunError(error: unknown): FactoryImplementationRunError {
  if (error instanceof FactoryImplementationRunError) return error;
  return new FactoryImplementationRunError(errorMessage(error), { cause: error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
