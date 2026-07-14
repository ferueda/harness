import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFactoryArtifactRef, type FactoryArtifactRef } from "./factory-artifact-ref.ts";
import { git } from "./factory-publication-git.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";
import { FactoryWorkItemMetadataSchema } from "./factory-schemas.ts";

export type PreparedPlanPublication = {
  baseRef: string;
  headBranch: string;
  headSha: string;
  title: string;
  body: string;
};

export function preparePlanPublication(input: {
  workspace: string;
  factoryStoreProjectRoot: string;
  phaseRunId: string;
  workItemKey: string;
  workItem: FactoryWorkItem;
  baseRef: string;
  baseSha: string;
  branchRef: string;
  outputPlan: string;
  candidate: FactoryArtifactRef;
}): PreparedPlanPublication {
  if (git(input.workspace, ["symbolic-ref", "-q", "HEAD"]).trim() !== input.branchRef)
    throw new Error(`Plan publication requires persisted branch ${input.branchRef}`);
  if (git(input.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]).trim())
    throw new Error("Plan publication requires a clean workspace");
  const candidatePath = verifyFactoryArtifactRef(input.candidate, {
    repository: input.workspace,
    "factory-store": input.factoryStoreProjectRoot,
  });
  const planBytes = readFileSync(candidatePath);
  const existingPlan = tryShow(input.workspace, input.baseSha, input.outputPlan);
  if (existingPlan !== undefined && !planBytes.equals(Buffer.from(existingPlan)))
    throw new Error(`Plan path already contains different bytes: ${input.outputPlan}`);
  const readmePath = "dev/plans/README.md";
  const readme = git(input.workspace, ["show", `${input.baseSha}:${readmePath}`]);
  const nextReadme = updateActiveQueue(readme, input.outputPlan, input.workItem);
  const temporary = mkdtempSync(join(tmpdir(), "harness-plan-publication-"));
  const index = join(temporary, "index");
  try {
    const env = { GIT_INDEX_FILE: index };
    git(input.workspace, ["read-tree", input.baseSha], env);
    const planTemp = join(temporary, "plan.md");
    const readmeTemp = join(temporary, "README.md");
    writeFileSync(planTemp, planBytes);
    writeFileSync(readmeTemp, nextReadme);
    const planBlob = git(input.workspace, ["hash-object", "-w", planTemp]).trim();
    const readmeBlob = git(input.workspace, ["hash-object", "-w", readmeTemp]).trim();
    git(
      input.workspace,
      ["update-index", "--add", "--cacheinfo", "100644", planBlob, input.outputPlan],
      env,
    );
    git(input.workspace, ["update-index", "--cacheinfo", "100644", readmeBlob, readmePath], env);
    const tree = git(input.workspace, ["write-tree"], env).trim();
    const baseDate = git(input.workspace, ["show", "-s", "--format=%aI", input.baseSha]).trim();
    const commit = git(
      input.workspace,
      [
        "commit-tree",
        tree,
        "-p",
        input.baseSha,
        "-m",
        `docs: publish reviewed plan ${input.workItemKey}`,
      ],
      {
        ...env,
        GIT_AUTHOR_NAME: "Harness Factory",
        GIT_AUTHOR_EMAIL: "factory@harness.local",
        GIT_COMMITTER_NAME: "Harness Factory",
        GIT_COMMITTER_EMAIL: "factory@harness.local",
        GIT_AUTHOR_DATE: baseDate,
        GIT_COMMITTER_DATE: baseDate,
      },
    ).trim();
    const headBranch = `refs/heads/harness/factory/plan/${input.phaseRunId}`;
    const existing = tryResolve(input.workspace, headBranch);
    if (existing && existing !== commit)
      throw new Error("Deterministic planning publication branch has a conflicting commit");
    if (!existing) git(input.workspace, ["update-ref", headBranch, commit]);
    git(input.workspace, ["switch", headBranch.replace(/^refs\/heads\//, "")]);
    git(input.workspace, ["reset", "--hard", commit]);
    return {
      baseRef: input.baseRef,
      headBranch,
      headSha: commit,
      title: input.workItem.title,
      body: `Factory reviewed plan for ${input.workItemKey}.\n\nReviewed artifact: ${input.outputPlan}`,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function updateActiveQueue(readme: string, outputPlan: string, workItem: FactoryWorkItem): string {
  const header = "## Active queue";
  const start = readme.indexOf(header);
  if (start < 0) throw new Error("Plan index is missing the Active queue section");
  const contentStart = start + header.length;
  const nextHeader = readme.indexOf("\n## ", contentStart);
  const end = nextHeader < 0 ? readme.length : nextHeader;
  const section = readme.slice(contentStart, end);
  const lines = section.split("\n");
  const bullets = lines.filter((line) => line.startsWith("- ["));
  const targets = new Set<string>();
  for (const bullet of bullets) {
    const match = /^- \[[^\]]+\]\(([^)]+\.md)\) — .+$/.exec(bullet);
    if (!match) throw new Error(`Malformed Active queue entry: ${bullet}`);
    if (targets.has(match[1]!)) throw new Error(`Duplicate Active queue target: ${match[1]}`);
    targets.add(match[1]!);
  }
  const planLink = outputPlan.replace(/^dev\/plans\//, "");
  const target = `(${planLink})`;
  if (bullets.filter((line) => line.includes(target)).length > 1)
    throw new Error(`Plan index contains duplicate entries for ${outputPlan}`);
  const metadata = FactoryWorkItemMetadataSchema.safeParse(workItem.metadata ?? {});
  const tracker = metadata.success ? metadata.data.tracker : undefined;
  const link = tracker?.url
    ? ` [${tracker.source === "linear" ? "Linear" : "Tracker"}](${tracker.url})`
    : "";
  const canonical = `- [${workItem.title}](${planLink}) — approved; awaiting plan merge.${link}`;
  const retained = bullets.filter((line) => !line.includes(target));
  const sorted = [...retained, canonical].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const firstBullet = lines.findIndex((line) => line.startsWith("- ["));
  const lastBullet = lines.findLastIndex((line) => line.startsWith("- ["));
  const before = firstBullet < 0 ? [""] : lines.slice(0, firstBullet);
  const after = lastBullet < 0 ? lines.slice(1) : lines.slice(lastBullet + 1);
  const replacement = [...before, ...sorted, ...after].join("\n");
  return `${readme.slice(0, contentStart)}${replacement}${readme.slice(end)}`;
}

function tryResolve(workspace: string, ref: string): string | undefined {
  try {
    return git(workspace, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  } catch {
    return undefined;
  }
}

function tryShow(workspace: string, commit: string, path: string): string | undefined {
  try {
    return git(workspace, ["show", `${commit}:${path}`]);
  } catch {
    return undefined;
  }
}
