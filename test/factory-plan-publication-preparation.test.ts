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
  expect(git(fixture.workspace, ["rev-parse", `${first.headSha}^`]).trim()).toBe(fixture.baseSha);
  const index = git(fixture.workspace, ["show", `${first.headSha}:dev/plans/README.md`]);
  expect(index).toBe(
    "# Plans\n\n## Active queue\n\n- [Plan item](item.md) — approved; awaiting plan merge.\n- [Zulu](zulu.md) — approved.\n\n## Shipped\n",
  );

  const retry = preparePlanPublication(input);
  expect(retry.headSha).toBe(first.headSha);
});

test("canonicalizes an empty Active queue before publication", () => {
  const fixture = planningFixture({
    readme: "# Plans\n\n## Active queue\nNo active plans.\n\nKeep this note.\n\n## Shipped\n",
  });

  const prepared = preparePlanPublication(publicationInput(fixture));

  expect(git(fixture.workspace, ["show", `${prepared.headSha}:dev/plans/README.md`])).toBe(
    "# Plans\n\n## Active queue\n\n- [Plan item](item.md) — approved; awaiting plan merge.\n\nKeep this note.\n\n## Shipped\n",
  );
  execFileSync(join(process.cwd(), "node_modules/.bin/oxfmt"), [
    "--check",
    join(fixture.workspace, "dev/plans/README.md"),
  ]);
});

test("rejects an empty conflicting plan already present at the persisted base", () => {
  const fixture = planningFixture({ existingPlan: "" });

  expect(() => preparePlanPublication(publicationInput(fixture))).toThrow(
    /Plan path already contains different bytes/,
  );
});

test("rejects the plan index as an output path", () => {
  const fixture = planningFixture();

  expect(() =>
    preparePlanPublication({
      ...publicationInput(fixture),
      outputPlan: "dev/plans/README.md",
    }),
  ).toThrow(/conflicts with the plan index/);
  expect(git(fixture.workspace, ["symbolic-ref", "-q", "HEAD"]).trim()).toBe("refs/heads/main");
  expect(() =>
    git(fixture.workspace, [
      "show-ref",
      "--verify",
      "refs/heads/harness/factory/plan/planning-run",
    ]),
  ).toThrow();
});

function planningFixture(options: { existingPlan?: string; readme?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-plan-publication-"));
  const workspace = join(root, "workspace");
  const store = join(root, "store");
  execFileSync("git", ["init", "-b", "main", workspace]);
  git(workspace, ["config", "user.name", "Test"]);
  git(workspace, ["config", "user.email", "test@example.com"]);
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(
    join(workspace, "dev/plans/README.md"),
    options.readme ?? "# Plans\n\n## Active queue\n\n- [Zulu](zulu.md) — approved.\n\n## Shipped\n",
  );
  writeFileSync(join(workspace, "dev/plans/zulu.md"), "# Zulu\n");
  if (options.existingPlan !== undefined)
    writeFileSync(join(workspace, "dev/plans/item.md"), options.existingPlan);
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
