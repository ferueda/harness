import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";

export function buildRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function gitExec(workspace, args) {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}

/**
 * @param {string} workspace
 * @param {{ baseRef: string, headRef: string }} refs
 */
export function prepareGitScope(workspace, refs) {
  gitExec(workspace, ["rev-parse", "--is-inside-work-tree"]);

  const mergeBase = gitExec(workspace, ["merge-base", refs.baseRef, refs.headRef]);
  const headSha = gitExec(workspace, ["rev-parse", refs.headRef]);
  const diff = gitExec(workspace, ["diff", `${mergeBase}..${refs.headRef}`]);

  let headBranch = "HEAD";
  try {
    headBranch = gitExec(workspace, ["rev-parse", "--abbrev-ref", refs.headRef]);
  } catch {
    // detached HEAD or invalid ref name — keep default
  }

  return { mergeBase, headSha, headBranch, diff };
}

/**
 * @param {string} template
 * @param {Record<string, string>} values
 */
export function fillTemplate(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => values[key] ?? "");
}

export function buildPlanSection(planArtifact, workspace) {
  if (!planArtifact?.requested) {
    return "_No plan file provided._";
  }
  if (!planArtifact.path) {
    return `_Plan file not found: \`${planArtifact.requested}\`_`;
  }
  return `Plan file: \`${formatArtifactPath(planArtifact.path, workspace)}\``;
}

export function buildHandoffSection(handoffArtifact, workspace) {
  if (!handoffArtifact?.requested) {
    return "_No handoff file provided._";
  }
  if (!handoffArtifact.path) {
    return `_Handoff file not found: \`${handoffArtifact.requested}\`_`;
  }
  return `Handoff file: \`${formatArtifactPath(handoffArtifact.path, workspace)}\``;
}

/**
 * @param {string} diff
 * @param {string} runDir
 * @param {string} workspace
 */
export function buildDiffSection(diff, runDir, workspace) {
  const contextDir = join(runDir, "context");
  mkdirSync(contextDir, { recursive: true });
  const patchPath = join(contextDir, "diff.patch");
  writeFileSync(patchPath, diff, "utf8");

  return `Diff file: \`${formatArtifactPath(patchPath, workspace)}\``;
}

/**
 * @param {{ workspace: string, runDir: string, scope: object, planPath?: string, handoffPath?: string }} input
 */
export function writeRunContext(input) {
  const contextDir = join(input.runDir, "context");
  mkdirSync(contextDir, { recursive: true });

  return {
    plan: copyContextFile({
      requested: input.planPath,
      workspace: input.workspace,
      destination: join(contextDir, "plan.md"),
    }),
    handoff: copyContextFile({
      requested: input.handoffPath,
      workspace: input.workspace,
      destination: join(contextDir, "handoff.md"),
    }),
  };
}

export function buildPriorReviewSection(reviewPath, workspace) {
  if (!existsSync(reviewPath)) {
    return "";
  }
  return `- Prior implementation review file: \`${formatArtifactPath(reviewPath, workspace)}\``;
}

/**
 * @param {string} templatePath
 * @param {Record<string, string>} values
 */
export function renderPrompt(templatePath, values) {
  const template = readFileSync(templatePath, "utf8");
  return fillTemplate(template, values);
}

function copyContextFile({ requested, workspace, destination }) {
  if (!requested) {
    return { requested: null, path: null };
  }

  const resolved = requested.startsWith("/") ? requested : join(workspace, requested);
  if (!existsSync(resolved)) {
    return { requested, path: null };
  }

  copyFileSync(resolved, destination);
  return { requested, path: destination };
}

function formatArtifactPath(path, workspace) {
  const artifactPath = relative(workspace, path);
  if (artifactPath && !artifactPath.startsWith("..") && !isAbsolute(artifactPath)) {
    return artifactPath;
  }
  return path;
}
