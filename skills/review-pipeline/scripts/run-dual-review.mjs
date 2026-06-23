#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateVerdict, renderSummary } from "./lib/aggregate.mjs";
import {
  buildDiffSection,
  buildHandoffSection,
  buildPlanSection,
  buildRunId,
  prepareGitScope,
  renderPrompt,
  writeRunContext,
} from "./lib/context.mjs";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CURSOR_AGENT = resolve(SKILL_ROOT, "../../cursor-cli/scripts/cursor-agent.mjs");
const SCHEMA_PATH = join(SKILL_ROOT, "schemas/review-output.schema.json");
const IMPL_PROMPT = join(SKILL_ROOT, "prompts/implementation-review.md");
const QUALITY_PROMPT = join(SKILL_ROOT, "prompts/quality-review.md");

function printHelp() {
  console.log(`Usage: node run-dual-review.mjs [options]

Run sequential review-implementation then code-quality-review via cursor-cli.
Artifacts: <workspace>/.agent-runs/reviews/<run-id>/

Options:
  --workspace <path>       Target repo (default: cwd)
  --base <ref>             Base ref (default: main)
  --head <ref>             Head ref (default: HEAD)
  --plan <path>            Optional plan file (relative to workspace or absolute)
  --handoff <path>         Optional handoff file
  --runs-dir <path>        Output root (default: <workspace>/.agent-runs/reviews)
  --cursor-agent <path>    cursor-agent.mjs path (auto-detected)
  --model <id>             Cursor model override
  --max-runtime-ms <n>     Per-reviewer timeout (default: 1800000)
  --dry-run                Prepare context + prompts only; do not invoke agents
  -h, --help
`);
}

function parseArgs(argv) {
  const options = {
    workspace: process.cwd(),
    baseRef: "main",
    headRef: "HEAD",
    dryRun: false,
    maxRuntimeMs: 30 * 60 * 1000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--workspace":
        options.workspace = resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--base":
        options.baseRef = readValue(argv, index, arg);
        index += 1;
        break;
      case "--head":
        options.headRef = readValue(argv, index, arg);
        index += 1;
        break;
      case "--plan":
        options.planPath = readValue(argv, index, arg);
        index += 1;
        break;
      case "--handoff":
        options.handoffPath = readValue(argv, index, arg);
        index += 1;
        break;
      case "--runs-dir":
        options.runsDir = resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--cursor-agent":
        options.cursorAgentPath = resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--model":
        options.model = readValue(argv, index, arg);
        index += 1;
        break;
      case "--max-runtime-ms":
        options.maxRuntimeMs = Number(readValue(argv, index, arg));
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(options.maxRuntimeMs) || options.maxRuntimeMs <= 0) {
    throw new Error("Invalid --max-runtime-ms");
  }

  if (!existsSync(options.workspace)) {
    throw new Error(`Workspace does not exist: ${options.workspace}`);
  }

  options.runsDir ??= join(options.workspace, ".agent-runs/reviews");
  options.cursorAgentPath ??= resolveCursorAgentPath();

  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function resolveCursorAgentPath() {
  const candidates = [
    DEFAULT_CURSOR_AGENT,
    join(process.env.HOME ?? "", ".agents/skills/cursor-cli/scripts/cursor-agent.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "cursor-agent.mjs not found. Pass --cursor-agent or install skills/cursor-cli.",
  );
}

function invokeReviewer({ cursorAgentPath, workspace, promptPath, schemaPath, model, maxRuntimeMs }) {
  const args = [
    cursorAgentPath,
    "--format",
    "json",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--workspace",
    workspace,
    "--schema",
    schemaPath,
    "--prompt-file",
    promptPath,
    "--max-runtime-ms",
    String(maxRuntimeMs),
  ];
  if (model) args.push("--model", model);

  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: process.env,
  });

  let envelope;
  try {
    envelope = JSON.parse(result.stdout.trim());
  } catch {
    return {
      ok: false,
      error: `Invalid cursor-agent JSON output: ${result.stdout.slice(0, 500)}`,
      exitCode: result.status ?? 1,
      stderr: result.stderr,
    };
  }

  if (envelope.status !== "completed" || !envelope.structuredOutput) {
    return {
      ok: false,
      error: envelope.error ?? envelope.structuredError ?? "Reviewer failed",
      envelope,
      exitCode: result.status ?? 1,
      stderr: result.stderr,
    };
  }

  return {
    ok: true,
    review: envelope.structuredOutput,
    envelope,
    exitCode: 0,
  };
}

function buildPromptValues(scope, diffSection, planPath, handoffPath, workspace, priorReviewJson = "") {
  return {
    BASE_REF: scope.baseRef,
    HEAD_REF: scope.headRef,
    MERGE_BASE: scope.mergeBase,
    HEAD_SHA: scope.headSha,
    PLAN_SECTION: buildPlanSection(planPath, workspace),
    HANDOFF_SECTION: buildHandoffSection(handoffPath, workspace),
    DIFF_SECTION: diffSection,
    PRIOR_REVIEW_JSON: priorReviewJson,
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    printHelp();
    process.exit(2);
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const runId = buildRunId(startedAt);
  const runDir = join(options.runsDir, runId);
  mkdirSync(runDir, { recursive: true });

  const scope = {
    ...prepareGitScope(options.workspace, {
      baseRef: options.baseRef,
      headRef: options.headRef,
    }),
    baseRef: options.baseRef,
    headRef: options.headRef,
  };
  const scopeMeta = {
    baseRef: scope.baseRef,
    headRef: scope.headRef,
    mergeBase: scope.mergeBase,
    headSha: scope.headSha,
    headBranch: scope.headBranch,
    diffChars: scope.diff.length,
    diffLines: scope.diff ? scope.diff.split("\n").length : 0,
  };

  writeRunContext({
    workspace: options.workspace,
    runDir,
    scope,
    planPath: options.planPath,
    handoffPath: options.handoffPath,
  });

  const diffSection = buildDiffSection(scope.diff, runDir, options.workspace);

  const implPromptPath = join(runDir, "implementation-review.prompt.md");
  const implPrompt = renderPrompt(
    IMPL_PROMPT,
    buildPromptValues(scope, diffSection, options.planPath, options.handoffPath, options.workspace),
  );
  writeFileSync(implPromptPath, implPrompt, "utf8");

  if (options.dryRun) {
    const qualityPromptPath = join(runDir, "quality-review.prompt.md");
    const qualityPrompt = renderPrompt(
      QUALITY_PROMPT,
      buildPromptValues(
        scope,
        diffSection,
        options.planPath,
        options.handoffPath,
        options.workspace,
        '{"verdict":"pass","summary":"(dry-run placeholder)","findings":[]}',
      ),
    );
    writeFileSync(qualityPromptPath, qualityPrompt, "utf8");

    const meta = {
      runId,
      status: "dry_run",
      workspace: options.workspace,
      scope: scopeMeta,
      runDir,
      cursorAgentPath: options.cursorAgentPath,
      prompts: {
        implementation: implPromptPath,
        quality: qualityPromptPath,
      },
    };
    writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  const implResult = invokeReviewer({
    cursorAgentPath: options.cursorAgentPath,
    workspace: options.workspace,
    promptPath: implPromptPath,
    schemaPath: SCHEMA_PATH,
    model: options.model,
    maxRuntimeMs: options.maxRuntimeMs,
  });

  writeFileSync(
    join(runDir, "implementation-review.raw.json"),
    JSON.stringify(implResult.envelope ?? { error: implResult.error }, null, 2),
    "utf8",
  );

  if (!implResult.ok) {
    writeFailure(runDir, runId, options, scopeMeta, startedAt, "implementation", implResult);
    process.exit(1);
    return;
  }

  writeFileSync(
    join(runDir, "implementation-review.json"),
    JSON.stringify(implResult.review, null, 2),
    "utf8",
  );

  const qualityPromptPath = join(runDir, "quality-review.prompt.md");
  const qualityPrompt = renderPrompt(
    QUALITY_PROMPT,
    buildPromptValues(
      scope,
      diffSection,
      options.planPath,
      options.handoffPath,
      options.workspace,
      JSON.stringify(implResult.review, null, 2),
    ),
  );
  writeFileSync(qualityPromptPath, qualityPrompt, "utf8");

  const qualityResult = invokeReviewer({
    cursorAgentPath: options.cursorAgentPath,
    workspace: options.workspace,
    promptPath: qualityPromptPath,
    schemaPath: SCHEMA_PATH,
    model: options.model,
    maxRuntimeMs: options.maxRuntimeMs,
  });

  writeFileSync(
    join(runDir, "quality-review.raw.json"),
    JSON.stringify(qualityResult.envelope ?? { error: qualityResult.error }, null, 2),
    "utf8",
  );

  if (!qualityResult.ok) {
    writeFailure(runDir, runId, options, scopeMeta, startedAt, "quality", qualityResult, implResult.review);
    process.exit(1);
    return;
  }

  writeFileSync(
    join(runDir, "quality-review.json"),
    JSON.stringify(qualityResult.review, null, 2),
    "utf8",
  );

  const durationMs = Date.now() - startedAt.getTime();
  const verdict = aggregateVerdict(implResult.review, qualityResult.review);
  const summary = renderSummary({
    runId,
    workspace: options.workspace,
    scope,
    implReview: implResult.review,
    qualityReview: qualityResult.review,
    verdict,
    startedAt: startedAt.toISOString(),
    durationMs,
  });

  writeFileSync(join(runDir, "summary.md"), summary, "utf8");

  const meta = {
    runId,
    status: "completed",
    verdict,
    workspace: options.workspace,
    scope: scopeMeta,
    startedAt: startedAt.toISOString(),
    durationMs,
    implementationReview: {
      verdict: implResult.review.verdict,
      findingCount: implResult.review.findings?.length ?? 0,
      sessionId: implResult.envelope?.sessionId,
    },
    qualityReview: {
      verdict: qualityResult.review.verdict,
      findingCount: qualityResult.review.findings?.length ?? 0,
      sessionId: qualityResult.envelope?.sessionId,
    },
  };
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

  console.log(JSON.stringify(meta, null, 2));
  process.exit(verdict === "pass" ? 0 : 1);
}

function writeFailure(runDir, runId, options, scope, startedAt, stage, result, implReview) {
  const meta = {
    runId,
    status: "failed",
    failedStage: stage,
    error: result.error,
    workspace: options.workspace,
    scope,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

  if (implReview) {
    writeFileSync(join(runDir, "implementation-review.json"), JSON.stringify(implReview, null, 2), "utf8");
  }

  console.error(JSON.stringify(meta, null, 2));
}

main();
