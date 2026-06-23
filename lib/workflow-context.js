import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateVerdict, renderSummary } from "./aggregate.js";
import { invokeCursorAgent } from "./cursor-agent.js";
import {
  buildDiffSection,
  buildHandoffSection,
  buildPlanSection,
  buildPriorReviewSection,
  buildRunId,
  prepareGitScope,
  renderPrompt,
  writeRunContext,
} from "./context.js";

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(HARNESS_ROOT, "schemas/review-output.schema.json");
const DEFAULT_CURSOR_AGENT = join(HARNESS_ROOT, "skills/cursor-cli/scripts/cursor-agent.mjs");

const AGENTS = {
  "review-implementation": {
    promptTemplate: join(HARNESS_ROOT, "prompts/implementation-review.md"),
    promptFile: "implementation-review.prompt.md",
    reviewFile: "implementation-review.json",
    rawFile: "implementation-review.raw.json",
    dryRunReview: { verdict: "pass", summary: "(dry-run placeholder)", findings: [] },
    stage: "implementation",
  },
  "code-quality-review": {
    promptTemplate: join(HARNESS_ROOT, "prompts/quality-review.md"),
    promptFile: "quality-review.prompt.md",
    reviewFile: "quality-review.json",
    rawFile: "quality-review.raw.json",
    dryRunReview: { verdict: "pass", summary: "(dry-run placeholder)", findings: [] },
    stage: "quality",
  },
};

export function createWorkflowContext(options) {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }

  const startedAt = new Date();
  const runId = buildRunId(startedAt);
  const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/reviews")), runId);
  mkdirSync(runDir, { recursive: true });

  const cursorAgentPath = resolveCursorAgentPath(options.cursorAgentPath);
  const scope = {
    ...prepareGitScope(workspace, {
      baseRef: options.baseRef,
      headRef: options.headRef,
    }),
    baseRef: options.baseRef,
    headRef: options.headRef,
  };
  const scopeMeta = buildScopeMeta(scope);

  const contextArtifacts = writeRunContext({
    workspace,
    runDir,
    scope,
    planPath: options.planPath,
    handoffPath: options.handoffPath,
  });

  const diffSection = buildDiffSection(scope.diff, runDir, workspace);
  const promptPaths = {};

  return {
    runId,
    runDir,
    workspace,
    scope,
    scopeMeta,
    startedAt,
    dryRun: options.dryRun,
    aggregate: aggregateVerdictFromList,
    async agent(name) {
      const config = AGENTS[name];
      if (!config) throw new Error(`Unknown agent: ${name}`);

      const promptPath = join(runDir, config.promptFile);
      const prompt = renderPrompt(
        config.promptTemplate,
        buildPromptValues({
          scope,
          diffSection,
          workspace,
          runDir,
          contextArtifacts,
          agentName: name,
        }),
      );
      writeFileSync(promptPath, prompt, "utf8");
      promptPaths[config.stage] = promptPath;

      if (options.dryRun) {
        return config.dryRunReview;
      }

      const result = invokeCursorAgent({
        cursorAgentPath,
        workspace,
        promptPath,
        schemaPath: SCHEMA_PATH,
        model: options.model,
        maxRuntimeMs: options.maxRuntimeMs,
      });

      writeFileSync(
        join(runDir, config.rawFile),
        JSON.stringify(result.envelope ?? { error: result.error }, null, 2),
        "utf8",
      );

      if (!result.ok) {
        writeFailure({ runDir, runId, workspace, scopeMeta, startedAt, stage: config.stage, result });
        throw new Error(`${config.stage} reviewer failed: ${result.error}`);
      }

      writeFileSync(join(runDir, config.reviewFile), JSON.stringify(result.review, null, 2), "utf8");
      return result.review;
    },
    export({ implementation, quality, verdict }) {
      const durationMs = Date.now() - startedAt.getTime();

      if (options.dryRun) {
        const meta = {
          runId,
          status: "dry_run",
          workspace,
          scope: scopeMeta,
          runDir,
          cursorAgentPath,
          prompts: promptPaths,
        };
        writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
        return meta;
      }

      const summary = renderSummary({
        runId,
        workspace,
        scope,
        implReview: implementation,
        qualityReview: quality,
        verdict,
        startedAt: startedAt.toISOString(),
        durationMs,
      });
      writeFileSync(join(runDir, "summary.md"), summary, "utf8");

      const meta = {
        runId,
        status: "completed",
        verdict,
        workspace,
        scope: scopeMeta,
        startedAt: startedAt.toISOString(),
        durationMs,
        implementationReview: summarizeReview(implementation),
        qualityReview: summarizeReview(quality),
      };
      writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
      return meta;
    },
  };
}

function buildScopeMeta(scope) {
  return {
    baseRef: scope.baseRef,
    headRef: scope.headRef,
    mergeBase: scope.mergeBase,
    headSha: scope.headSha,
    headBranch: scope.headBranch,
    diffChars: scope.diff.length,
    diffLines: scope.diff ? scope.diff.split("\n").length : 0,
  };
}

function buildPromptValues({ scope, diffSection, workspace, runDir, contextArtifacts, agentName }) {
  return {
    BASE_REF: scope.baseRef,
    HEAD_REF: scope.headRef,
    MERGE_BASE: scope.mergeBase,
    HEAD_SHA: scope.headSha,
    PLAN_SECTION:
      agentName === "review-implementation" ? buildPlanSection(contextArtifacts.plan, workspace) : "",
    HANDOFF_SECTION: buildHandoffSection(contextArtifacts.handoff, workspace),
    DIFF_SECTION: diffSection,
    PRIOR_REVIEW_SECTION: buildPriorReviewSection(
      join(runDir, "implementation-review.json"),
      workspace,
    ),
  };
}

function resolveCursorAgentPath(explicitPath) {
  const candidates = [
    explicitPath ? resolve(explicitPath) : null,
    DEFAULT_CURSOR_AGENT,
    join(process.env.HOME ?? "", ".agents/skills/cursor-cli/scripts/cursor-agent.mjs"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("cursor-agent.mjs not found. Pass --cursor-agent or install skills/cursor-cli.");
}

function aggregateVerdictFromList(reviews) {
  return aggregateVerdict(reviews[0], reviews[1]);
}

function summarizeReview(review) {
  return {
    verdict: review?.verdict,
    findingCount: review?.findings?.length ?? 0,
  };
}

function writeFailure({ runDir, runId, workspace, scopeMeta, startedAt, stage, result }) {
  const meta = {
    runId,
    status: "failed",
    failedStage: stage,
    error: result.error,
    workspace,
    scope: scopeMeta,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
}
