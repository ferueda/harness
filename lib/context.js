import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative } from "node:path";

const MAX_INLINE_DIFF_CHARS = 48_000;

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

export function buildPlanSection(planPath, workspace) {
  if (!planPath) {
    return "_No plan file provided._";
  }
  const resolved = planPath.startsWith("/") ? planPath : join(workspace, planPath);
  if (!existsSync(resolved)) {
    return `_Plan file not found: \`${planPath}\`_`;
  }
  const content = readFileSync(resolved, "utf8");
  return `## Plan\n\n\`\`\`markdown\n${content}\n\`\`\``;
}

export function buildHandoffSection(handoffPath, workspace) {
  if (!handoffPath) {
    return "_No handoff file provided._";
  }
  const resolved = handoffPath.startsWith("/") ? handoffPath : join(workspace, handoffPath);
  if (!existsSync(resolved)) {
    return `_Handoff file not found: \`${handoffPath}\`_`;
  }
  const content = readFileSync(resolved, "utf8");
  return `## Handoff\n\n\`\`\`markdown\n${content}\n\`\`\``;
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

  if (diff.length <= MAX_INLINE_DIFF_CHARS) {
    return `\`\`\`diff\n${diff || "(empty diff)"}\n\`\`\``;
  }

  const relPath = relative(workspace, patchPath);
  return [
    `Diff is large (${diff.length} chars). Read the patch file at \`${relPath}\` in this workspace.`,
    "",
    "_First 200 lines preview:_",
    "",
    `\`\`\`diff\n${diff.split("\n").slice(0, 200).join("\n")}\n\`\`\``,
  ].join("\n");
}

/**
 * @param {{ workspace: string, runDir: string, scope: object, planPath?: string, handoffPath?: string }} input
 */
export function writeRunContext(input) {
  mkdirSync(join(input.runDir, "context"), { recursive: true });

  if (input.planPath) {
    const resolved = input.planPath.startsWith("/")
      ? input.planPath
      : join(input.workspace, input.planPath);
    if (existsSync(resolved)) {
      copyFileSync(resolved, join(input.runDir, "context", "plan.md"));
    }
  }

  if (input.handoffPath) {
    const resolved = input.handoffPath.startsWith("/")
      ? input.handoffPath
      : join(input.workspace, input.handoffPath);
    if (existsSync(resolved)) {
      copyFileSync(resolved, join(input.runDir, "context", "handoff.md"));
    }
  }
}

/**
 * @param {string} templatePath
 * @param {Record<string, string>} values
 */
export function renderPrompt(templatePath, values) {
  const template = readFileSync(templatePath, "utf8");
  return fillTemplate(template, values);
}
