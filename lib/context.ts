import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { assertNonEmptyHandoffText, HANDOFF_CONFLICT_ERROR } from "./handoff.ts";
import { ensureFactoryRunDirectory, writeFactoryRunFile } from "./factory-run-files.ts";

export type GitScope = {
  mergeBase: string;
  headSha: string;
  headBranch: string;
  diff: string;
};

export type ContextArtifact = {
  requested: string | null | undefined;
  path: string | null;
};

type RequestedContextFile = {
  requested?: string;
  workspace: string;
  runDir: string;
  relativePath: string;
};

type ArtifactSectionOptions = {
  none: string;
  missing: string;
  found: string;
};

export function buildRunId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function gitExec(workspace: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}

export function prepareGitScope(
  workspace: string,
  refs: { baseRef: string; headRef: string },
): GitScope {
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

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => values[key] ?? "");
}

export function buildPlanRef(planArtifact: ContextArtifact, workspace: string): string {
  return buildArtifactSection(planArtifact, workspace, {
    none: "_No plan file provided._",
    missing: "_Plan file not found: `{{requested}}`_",
    found: "Plan file: `{{path}}`",
  });
}

export function buildInlinedHandoffSection(handoffArtifact: ContextArtifact): string {
  if (!handoffArtifact?.requested) {
    return "";
  }
  if (!handoffArtifact.path) {
    return `## Handoff\n\n_Handoff file not found: \`${handoffArtifact.requested}\`_`;
  }

  const content = readFileSync(handoffArtifact.path, "utf8").trim();
  if (!content) {
    return "";
  }

  return `## Handoff\n\n${content}`;
}

export function buildDiffRef(diff: string, runDir: string, workspace: string): string {
  const contextDir = join(runDir, "context");
  ensureFactoryRunDirectory(contextDir);
  const patchPath = writeFactoryRunFile({
    runDir,
    relativePath: "context/diff.patch",
    value: diff,
  });

  return `Diff file: \`${formatArtifactPath(patchPath, workspace)}\``;
}

export function writeRunContext(input: {
  workspace: string;
  runDir: string;
  scope?: object;
  planPath?: string;
  handoffPath?: string;
  handoffText?: string;
}): { plan: ContextArtifact; handoff: ContextArtifact } {
  const contextDir = join(input.runDir, "context");
  ensureFactoryRunDirectory(contextDir);

  return {
    plan: copyContextFile({
      requested: input.planPath,
      workspace: input.workspace,
      runDir: input.runDir,
      relativePath: "context/plan.md",
    }),
    handoff: writeHandoffArtifact({
      path: input.handoffPath,
      text: input.handoffText,
      workspace: input.workspace,
      runDir: input.runDir,
      relativePath: "context/handoff.md",
    }),
  };
}

function copyContextFile({
  requested,
  workspace,
  runDir,
  relativePath,
}: RequestedContextFile): ContextArtifact {
  if (!requested) {
    return { requested: null, path: null };
  }

  const resolved = requested.startsWith("/") ? requested : join(workspace, requested);
  if (!existsSync(resolved)) {
    return { requested, path: null };
  }

  const path = writeFactoryRunFile({
    runDir,
    relativePath,
    value: readFileSync(resolved, "utf8"),
  });
  return { requested, path };
}

function writeHandoffArtifact(input: {
  path?: string;
  text?: string;
  workspace: string;
  runDir: string;
  relativePath: string;
}): ContextArtifact {
  if (input.path && input.text !== undefined) {
    throw new Error(HANDOFF_CONFLICT_ERROR);
  }
  if (input.text !== undefined) {
    assertNonEmptyHandoffText(input.text);
    const path = writeFactoryRunFile({
      runDir: input.runDir,
      relativePath: input.relativePath,
      value: input.text,
    });
    return { requested: "inline handoff text", path };
  }
  return copyContextFile({
    requested: input.path,
    workspace: input.workspace,
    runDir: input.runDir,
    relativePath: input.relativePath,
  });
}

function formatArtifactPath(path: string, workspace: string): string {
  const artifactPath = relative(workspace, path);
  if (artifactPath && !artifactPath.startsWith("..") && !isAbsolute(artifactPath)) {
    return artifactPath;
  }
  return path;
}

function buildArtifactSection(
  artifact: ContextArtifact,
  workspace: string,
  options: ArtifactSectionOptions,
): string {
  if (!artifact?.requested) {
    return options.none;
  }
  if (!artifact.path) {
    return options.missing.replace("{{requested}}", artifact.requested);
  }
  return options.found.replace("{{path}}", formatArtifactPath(artifact.path, workspace));
}
