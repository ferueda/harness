import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";

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
  destination: string;
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

export function buildPlanSection(planArtifact: ContextArtifact, workspace: string): string {
  return buildArtifactSection(planArtifact, workspace, {
    none: "_No plan file provided._",
    missing: "_Plan file not found: `{{requested}}`_",
    found: "Plan file: `{{path}}`",
  });
}

export function buildHandoffSection(handoffArtifact: ContextArtifact, workspace: string): string {
  return buildArtifactSection(handoffArtifact, workspace, {
    none: "_No handoff file provided._",
    missing: "_Handoff file not found: `{{requested}}`_",
    found: "Handoff file: `{{path}}`",
  });
}

export function buildDiffSection(diff: string, runDir: string, workspace: string): string {
  const contextDir = join(runDir, "context");
  mkdirSync(contextDir, { recursive: true });
  const patchPath = join(contextDir, "diff.patch");
  writeFileSync(patchPath, diff, "utf8");

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
  mkdirSync(contextDir, { recursive: true });

  return {
    plan: copyContextFile({
      requested: input.planPath,
      workspace: input.workspace,
      destination: join(contextDir, "plan.md"),
    }),
    handoff: writeHandoffArtifact({
      path: input.handoffPath,
      text: input.handoffText,
      workspace: input.workspace,
      destination: join(contextDir, "handoff.md"),
    }),
  };
}

function copyContextFile({
  requested,
  workspace,
  destination,
}: RequestedContextFile): ContextArtifact {
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

function writeHandoffArtifact(input: {
  path?: string;
  text?: string;
  workspace: string;
  destination: string;
}): ContextArtifact {
  if (input.path && input.text !== undefined) {
    throw new Error("Use only one handoff input");
  }
  if (input.text !== undefined) {
    if (!input.text.trim()) {
      throw new Error("Handoff text must not be empty");
    }
    writeFileSync(input.destination, input.text, "utf8");
    return { requested: "inline handoff text", path: input.destination };
  }
  return copyContextFile({
    requested: input.path,
    workspace: input.workspace,
    destination: input.destination,
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
