import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createFactoryArtifactRef } from "../lib/factory-artifact-ref.ts";
import { preparePlanPublication } from "../lib/factory-plan-publication-preparation.ts";

test("materializes one deterministic plan commit from the persisted base", () => {
  const fixture = planningFixture();
  const input = publicationInput(fixture);

  const first = preparePlanPublication(input);
  expect(first.headBranch).toBe("refs/heads/harness/factory/plan/planning-run");
  expect(
    git(fixture.workspace, ["diff", "--name-only", fixture.baseSha, first.headSha]).trim(),
  ).toBe("dev/plans/README.md\ndev/plans/item.md");
  expect(git(fixture.workspace, ["show", `${first.headSha}:dev/plans/item.md`])).toBe(
    "# Reviewed plan\n",
  );
  const index = git(fixture.workspace, ["show", `${first.headSha}:dev/plans/README.md`]);
  expect(index.indexOf("[Plan item](item.md)")).toBeLessThan(index.indexOf("[Zulu](zulu.md)"));

  git(fixture.workspace, ["switch", "main"]);
  const retry = preparePlanPublication(input);
  expect(retry.headSha).toBe(first.headSha);
});

test("rejects an empty conflicting plan already present at the persisted base", () => {
  const fixture = planningFixture("");

  expect(() => preparePlanPublication(publicationInput(fixture))).toThrow(
    /Plan path already contains different bytes/,
  );
});

function planningFixture(existingPlan?: string) {
  const root = mkdtempSync(join(tmpdir(), "factory-plan-publication-"));
  const workspace = join(root, "workspace");
  const store = join(root, "store");
  execFileSync("git", ["init", "-b", "main", workspace]);
  git(workspace, ["config", "user.name", "Test"]);
  git(workspace, ["config", "user.email", "test@example.com"]);
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(
    join(workspace, "dev/plans/README.md"),
    "# Plans\n\n## Active queue\n\n- [Zulu](zulu.md) — approved.\n\n## Shipped\n",
  );
  writeFileSync(join(workspace, "dev/plans/zulu.md"), "# Zulu\n");
  if (existingPlan !== undefined) writeFileSync(join(workspace, "dev/plans/item.md"), existingPlan);
  git(workspace, ["add", "dev/plans"]);
  git(workspace, ["commit", "-m", "base"]);
  const baseSha = git(workspace, ["rev-parse", "HEAD"]).trim();
  mkdirSync(join(store, "candidates"), { recursive: true });
  writeFileSync(join(store, "candidates/item.md"), "# Reviewed plan\n");
  const candidate = createFactoryArtifactRef({
    base: "factory-store",
    root: store,
    path: "candidates/item.md",
  });
  return { workspace, store, baseSha, candidate };
}

function publicationInput(fixture: ReturnType<typeof planningFixture>) {
  return {
    workspace: fixture.workspace,
    factoryStoreProjectRoot: fixture.store,
    phaseRunId: "planning-run",
    workItemKey: "linear:ENG-1",
    workItem: {
      id: "linear:ENG-1",
      source: "linear" as const,
      title: "Plan item",
      body: "",
      labels: [],
    },
    baseRef: "main",
    baseSha: fixture.baseSha,
    branchRef: "refs/heads/main",
    outputPlan: "dev/plans/item.md",
    candidate: fixture.candidate,
  };
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}
