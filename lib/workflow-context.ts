import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateVerdict,
  renderSummary,
  type ReviewSection,
  type ReviewVerdict,
} from "./aggregate.ts";
import { invokeCursorAgent } from "./cursor-agent.ts";
import {
  buildDiffSection,
  buildHandoffSection,
  buildPlanSection,
  buildPriorReviewSection,
  buildRunId,
  prepareGitScope,
  renderPrompt,
  writeRunContext,
} from "./context.ts";
import type { ContextArtifact } from "./context.ts";
import type { ReviewOutput } from "./schemas.ts";

type WorkflowOptions = {
  workspace: string;
  baseRef: string;
  headRef: string;
  runsDir?: string;
  cursorAgentPath?: string;
  planPath?: string;
  handoffPath?: string;
  model?: string;
  maxRuntimeMs: number;
  dryRun?: boolean;
};

type Scope = ReturnType<typeof prepareGitScope> & {
  baseRef: string;
  headRef: string;
};

type ScopeMeta = ReturnType<typeof buildScopeMeta>;

export type ReviewAgentName = keyof typeof AGENTS;

type PromptArtifacts = Partial<Record<(typeof AGENTS)[ReviewAgentName]["stage"], string>>;

type PromptContextArtifacts = {
  plan: ContextArtifact;
  handoff: ContextArtifact;
};

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_BUILT_OUTPUT = basename(MODULE_ROOT) === "dist";
const HARNESS_ROOT = IS_BUILT_OUTPUT ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;
const RUNTIME_ROOT = IS_BUILT_OUTPUT ? MODULE_ROOT : HARNESS_ROOT;
const SCHEMA_PATH = join(HARNESS_ROOT, "schemas/review-output.schema.json");
const DEFAULT_CURSOR_AGENT = join(
  RUNTIME_ROOT,
  IS_BUILT_OUTPUT ? "providers/cursor/cursor-agent.js" : "providers/cursor/cursor-agent.ts",
);
const DRY_RUN_REVIEW = {
  verdict: "pass",
  summary: "(dry-run placeholder)",
  findings: [],
} satisfies ReviewOutput;

const AGENTS = {
  "review-implementation": {
    skillName: "review-implementation",
    title: "Implementation review",
    summaryKey: "implementation",
    promptTemplate: join(HARNESS_ROOT, "prompts/implementation-review.md"),
    promptFile: "implementation-review.prompt.md",
    reviewFile: "implementation-review.json",
    rawFile: "implementation-review.raw.json",
    dryRunReview: DRY_RUN_REVIEW,
    stage: "implementation",
  },
  "code-quality-review": {
    skillName: "code-quality-review",
    title: "Code quality review",
    summaryKey: "codeQuality",
    promptTemplate: join(HARNESS_ROOT, "prompts/quality-review.md"),
    promptFile: "quality-review.prompt.md",
    reviewFile: "quality-review.json",
    rawFile: "quality-review.raw.json",
    dryRunReview: DRY_RUN_REVIEW,
    stage: "quality",
  },
  simplify: {
    skillName: "simplify-review",
    title: "Simplify review",
    summaryKey: "simplify",
    promptTemplate: join(HARNESS_ROOT, "prompts/simplify-review.md"),
    promptFile: "simplify-review.prompt.md",
    reviewFile: "simplify-review.json",
    rawFile: "simplify-review.raw.json",
    dryRunReview: DRY_RUN_REVIEW,
    stage: "simplify",
  },
};

export function createWorkflowContext(options: WorkflowOptions) {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }

  const startedAt = new Date();
  const runId = buildRunId(startedAt);
  const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/reviews")), runId);

  let cursorAgentPath: string;
  let contextArtifacts: PromptContextArtifacts;
  let scope: Scope;
  let scopeMeta: ScopeMeta;
  let diffSection: string;
  try {
    mkdirSync(runDir, { recursive: true });

    cursorAgentPath = resolveCursorAgentPath(options.cursorAgentPath);
    scope = {
      ...prepareGitScope(workspace, {
        baseRef: options.baseRef,
        headRef: options.headRef,
      }),
      baseRef: options.baseRef,
      headRef: options.headRef,
    };
    scopeMeta = buildScopeMeta(scope);

    contextArtifacts = writeRunContext({
      workspace,
      runDir,
      scope,
      planPath: options.planPath,
      handoffPath: options.handoffPath,
    });

    diffSection = buildDiffSection(scope.diff, runDir, workspace);
  } catch (error) {
    cleanupOrphanedRunDir(runDir);
    throw error;
  }

  const promptPaths: PromptArtifacts = {};

  return {
    runId,
    runDir,
    workspace,
    scope,
    scopeMeta,
    startedAt,
    dryRun: options.dryRun,
    aggregate: aggregateVerdict,
    reviewInfo: getReviewInfo,
    async agent(name: ReviewAgentName): Promise<ReviewOutput> {
      const config = AGENTS[name];

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
          skillPath: resolveSkillPath(config.skillName, workspace),
        }),
      );
      writeFileSync(promptPath, prompt, "utf8");
      promptPaths[config.stage] = promptPath;

      if (options.dryRun) {
        writeFileSync(
          join(runDir, config.reviewFile),
          JSON.stringify(config.dryRunReview, null, 2),
          "utf8",
        );
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
        JSON.stringify(
          result.ok ? result.envelope : (result.envelope ?? { error: result.error }),
          null,
          2,
        ),
        "utf8",
      );

      if (!result.ok) {
        writeFailure({
          runDir,
          runId,
          workspace,
          scopeMeta,
          startedAt,
          stage: config.stage,
          result,
        });
        throw new Error(`${config.stage} reviewer failed: ${result.error}`);
      }

      writeFileSync(
        join(runDir, config.reviewFile),
        JSON.stringify(result.review, null, 2),
        "utf8",
      );
      return result.review;
    },
    export({
      title,
      reviews,
      verdict,
    }: {
      title: string;
      reviews: ReviewSection[];
      verdict: ReviewVerdict;
    }) {
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
        title,
        runId,
        workspace,
        scope,
        reviews,
        verdict,
        startedAt: startedAt.toISOString(),
        durationMs,
      });
      writeFileSync(join(runDir, "summary.md"), summary, "utf8");

      const reviewSummaries = Object.fromEntries(
        reviews.map(({ key, review }) => [key, summarizeReview(review)]),
      );
      const meta = {
        runId,
        status: "completed",
        verdict,
        workspace,
        scope: scopeMeta,
        startedAt: startedAt.toISOString(),
        durationMs,
        implementationReview: reviewSummaries.implementation,
        qualityReview: reviewSummaries.codeQuality,
        ...(reviewSummaries.simplify ? { simplifyReview: reviewSummaries.simplify } : {}),
        reviews: reviewSummaries,
      };
      writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
      return meta;
    },
  };
}

function getReviewInfo(name: ReviewAgentName): { key: string; title: string } {
  const config = AGENTS[name];
  return { key: config.summaryKey, title: config.title };
}

function buildScopeMeta(scope: Scope) {
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

function buildPromptValues({
  scope,
  diffSection,
  workspace,
  runDir,
  contextArtifacts,
  agentName,
  skillPath,
}: {
  scope: Scope;
  diffSection: string;
  workspace: string;
  runDir: string;
  contextArtifacts: PromptContextArtifacts;
  agentName: ReviewAgentName;
  skillPath: string;
}): Record<string, string> {
  return {
    BASE_REF: scope.baseRef,
    HEAD_REF: scope.headRef,
    MERGE_BASE: scope.mergeBase,
    HEAD_SHA: scope.headSha,
    PLAN_SECTION:
      agentName === "review-implementation"
        ? buildPlanSection(contextArtifacts.plan, workspace)
        : "",
    HANDOFF_SECTION: buildHandoffSection(contextArtifacts.handoff, workspace),
    DIFF_SECTION: diffSection,
    SKILL_PATH: skillPath,
    PRIOR_REVIEW_SECTION: buildPriorReviewContext(agentName, runDir, workspace),
  };
}

function buildPriorReviewContext(
  agentName: ReviewAgentName,
  runDir: string,
  workspace: string,
): string {
  if (agentName === "simplify") {
    return [
      buildPriorReviewSection(
        join(runDir, "implementation-review.json"),
        workspace,
        "Prior implementation review file",
      ),
      buildPriorReviewSection(
        join(runDir, "quality-review.json"),
        workspace,
        "Prior code quality review file",
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }

  return buildPriorReviewSection(
    join(runDir, "implementation-review.json"),
    workspace,
    "Prior implementation review file",
  );
}

export function resolveSkillPath(
  skillName: string,
  workspace: string,
  homeDir = homedir(),
): string {
  const candidates = [
    join(workspace, ".agents/skills", skillName, "SKILL.md"),
    join(homeDir, ".agents/skills", skillName, "SKILL.md"),
    join(HARNESS_ROOT, "skills", skillName, "SKILL.md"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Skill not found: ${skillName}`);
}

function resolveCursorAgentPath(explicitPath?: string): string {
  const candidates = [explicitPath ? resolve(explicitPath) : null, DEFAULT_CURSOR_AGENT].filter(
    (candidate): candidate is string => Boolean(candidate),
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("cursor-agent entrypoint not found. Pass --cursor-agent.");
}

function summarizeReview(review: ReviewSection["review"]): {
  verdict: ReviewSection["review"]["verdict"];
  findingCount: number;
} {
  return {
    verdict: review?.verdict,
    findingCount: review?.findings?.length ?? 0,
  };
}

function writeFailure({
  runDir,
  runId,
  workspace,
  scopeMeta,
  startedAt,
  stage,
  result,
}: {
  runDir: string;
  runId: string;
  workspace: string;
  scopeMeta: ScopeMeta;
  startedAt: Date;
  stage: string;
  result: { error: string };
}): void {
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

export function cleanupOrphanedRunDir(runDir: string): boolean {
  if (existsSync(join(runDir, "meta.json"))) {
    return false;
  }

  rmSync(runDir, { recursive: true, force: true });
  return true;
}
