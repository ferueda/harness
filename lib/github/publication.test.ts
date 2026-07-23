import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePublicationCommit } from "./git.ts";
import { createGitHubPublicationForClient } from "./publication.ts";
import type {
  GitHubPullRequestClient,
  GitHubPullRequestRecord,
  GitPushTransport,
} from "./types.ts";
import type { RepositoryChange, RepositoryRun } from "../repository/types.ts";
import { inspectGitChanges } from "../repository/git.ts";

const AUTHOR = Object.freeze({ name: "Harness", email: "harness@example.com" });
const TOKEN = "github-secret";
const BRANCH = "codex/FER-286";
const EXPECTED_CHANGES = Object.freeze([
  Object.freeze({ path: "dev/plans/FER-286.md", status: "untracked" as const }),
]);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("GitHub publication", () => {
  it("commits, pushes, creates one PR, and converges on retry", async () => {
    const fixture = createFixture();
    writeSpec(fixture.workspace);
    const transport = localTransport(fixture);
    const github = fakeGitHub(fixture);
    const publication = createPublication(fixture, transport.value, github.client);

    const first = await publication.publishPullRequest(request(fixture));
    const second = await publication.publishPullRequest(request(fixture));

    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(git(fixture.workspace, ["rev-list", "--count", `${fixture.baseSha}..HEAD`])).toBe("1");
    expect(git(fixture.workspace, ["show", "-s", "--format=%B", "HEAD"])).toContain(
      `Harness-Run-ID: ${fixture.run.id}`,
    );
    expect(git(fixture.remote, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(first.headSha);
    expect(transport.counts()).toEqual({ reads: 2, pushes: 1 });
    expect(github.counts()).toEqual({ lists: 2, creates: 1 });
  });

  it("rejects changed paths before committing or using remote services", async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.workspace, "unexpected.txt"), "unexpected\n", "utf8");
    const transport = localTransport(fixture);
    const github = fakeGitHub(fixture);
    const publication = createPublication(fixture, transport.value, github.client);

    await expect(publication.publishPullRequest(request(fixture))).rejects.toMatchObject({
      code: "changes-mismatch",
    });
    expect(git(fixture.workspace, ["rev-parse", "HEAD"])).toBe(fixture.baseSha);
    expect(transport.counts()).toEqual({ reads: 0, pushes: 0 });
    expect(github.counts()).toEqual({ lists: 0, creates: 0 });
  });

  it("rejects an unmarked agent-created commit", async () => {
    const fixture = createFixture();
    writeSpec(fixture.workspace);
    git(fixture.workspace, ["add", "."]);
    git(fixture.workspace, ["commit", "-m", "Agent-created commit"]);
    const transport = localTransport(fixture);
    const github = fakeGitHub(fixture);
    const publication = createPublication(fixture, transport.value, github.client);

    await expect(publication.publishPullRequest(request(fixture))).rejects.toMatchObject({
      code: "run-conflict",
    });
    expect(transport.counts()).toEqual({ reads: 0, pushes: 0 });
  });

  it("publishes a renamed file from the caller-approved workspace snapshot", async () => {
    const fixture = createFixture();
    renameSync(join(fixture.workspace, "README.md"), join(fixture.workspace, "README-renamed.md"));
    const expectedChanges = await inspectGitChanges(fixture.workspace);
    const transport = localTransport(fixture);
    const github = fakeGitHub(fixture);
    const publication = createPublication(fixture, transport.value, github.client);

    await expect(
      publication.publishPullRequest(request(fixture, expectedChanges)),
    ).resolves.toMatchObject({ number: 286 });
    expect(
      git(fixture.workspace, ["diff", "--name-status", "-M", fixture.baseSha, "HEAD"]),
    ).toContain("README-renamed.md");
  });

  it("fails closed when the remote branch points to another commit", async () => {
    const fixture = createFixture();
    git(fixture.source, ["checkout", "-b", BRANCH, fixture.baseSha]);
    writeFileSync(join(fixture.source, "other.txt"), "other\n", "utf8");
    git(fixture.source, ["add", "other.txt"]);
    git(fixture.source, ["commit", "-m", "Conflicting publication"]);
    git(fixture.source, ["push", fixture.remote, `HEAD:refs/heads/${BRANCH}`]);
    writeSpec(fixture.workspace);
    const transport = localTransport(fixture);
    const github = fakeGitHub(fixture);
    const publication = createPublication(fixture, transport.value, github.client);

    await expect(publication.publishPullRequest(request(fixture))).rejects.toMatchObject({
      code: "remote-conflict",
    });
    expect(transport.counts()).toEqual({ reads: 1, pushes: 0 });
    expect(github.counts()).toEqual({ lists: 0, creates: 0 });
  });

  it("recovers when push succeeds before its response is lost", async () => {
    const fixture = createFixture();
    writeSpec(fixture.workspace);
    const transport = localTransport(fixture, { loseFirstPushResponse: true });
    const github = fakeGitHub(fixture);
    const publication = createPublication(fixture, transport.value, github.client);

    await expect(publication.publishPullRequest(request(fixture))).resolves.toMatchObject({
      number: 286,
    });
    expect(transport.counts()).toEqual({ reads: 2, pushes: 1 });
    expect(github.counts()).toEqual({ lists: 1, creates: 1 });
  });

  it("performs one lookup after an ambiguous PR creation failure", async () => {
    const fixture = createFixture();
    writeSpec(fixture.workspace);
    const transport = localTransport(fixture);
    const github = fakeGitHub(fixture, { loseCreateResponse: true });
    const publication = createPublication(fixture, transport.value, github.client);

    await expect(publication.publishPullRequest(request(fixture))).resolves.toMatchObject({
      number: 286,
    });
    expect(github.counts()).toEqual({ lists: 2, creates: 1 });
  });

  it.each([
    { state: "open" as const, merged: false },
    { state: "closed" as const, merged: false },
    { state: "closed" as const, merged: true },
  ])("returns one existing $state PR without replacing it", async ({ state, merged }) => {
    const fixture = createFixture();
    writeSpec(fixture.workspace);
    const headSha = await preparePublicationCommit({
      run: fixture.run,
      expectedChanges: EXPECTED_CHANGES,
      author: AUTHOR,
      commitMessage: "Add FER-286 spec",
    });
    const transport = localTransport(fixture);
    await transport.value.pushBranch(pushInput(fixture));
    const github = fakeGitHub(fixture, {
      initialRecords: [pullRequestRecord(headSha, { state, merged })],
    });
    const publication = createPublication(fixture, transport.value, github.client);

    const result = await publication.publishPullRequest(request(fixture));

    expect(result).toMatchObject({ state, merged, headSha });
    expect(github.counts()).toEqual({ lists: 1, creates: 0 });
  });

  it("rejects multiple matching pull requests", async () => {
    const fixture = createFixture();
    writeSpec(fixture.workspace);
    const headSha = await preparePublicationCommit({
      run: fixture.run,
      expectedChanges: EXPECTED_CHANGES,
      author: AUTHOR,
      commitMessage: "Add FER-286 spec",
    });
    const transport = localTransport(fixture);
    await transport.value.pushBranch(pushInput(fixture));
    const github = fakeGitHub(fixture, {
      initialRecords: [pullRequestRecord(headSha), { ...pullRequestRecord(headSha), number: 287 }],
    });
    const publication = createPublication(fixture, transport.value, github.client);

    await expect(publication.publishPullRequest(request(fixture))).rejects.toMatchObject({
      code: "github-conflict",
    });
  });

  it("rejects a pull request whose head SHA does not match", async () => {
    const fixture = createFixture();
    writeSpec(fixture.workspace);
    const headSha = await preparePublicationCommit({
      run: fixture.run,
      expectedChanges: EXPECTED_CHANGES,
      author: AUTHOR,
      commitMessage: "Add FER-286 spec",
    });
    const transport = localTransport(fixture);
    await transport.value.pushBranch(pushInput(fixture));
    const github = fakeGitHub(fixture, {
      initialRecords: [
        pullRequestRecord(headSha.replace(/^./, headSha.startsWith("a") ? "b" : "a")),
      ],
    });
    const publication = createPublication(fixture, transport.value, github.client);

    await expect(publication.publishPullRequest(request(fixture))).rejects.toMatchObject({
      code: "github-conflict",
    });
  });
});

type Fixture = Readonly<{
  root: string;
  remote: string;
  source: string;
  workspace: string;
  baseSha: string;
  run: RepositoryRun;
}>;

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "harness-github-publication-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const workspace = join(root, "workspace");

  git(root, ["init", "--bare", remote]);
  git(root, ["clone", remote, source]);
  configureAuthor(source);
  writeFileSync(join(source, "README.md"), "# Fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "Initialize fixture"]);
  git(source, ["branch", "-M", "main"]);
  git(source, ["push", "--set-upstream", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const baseSha = git(source, ["rev-parse", "HEAD"]);

  git(root, ["clone", remote, workspace]);
  configureAuthor(workspace);
  git(workspace, ["checkout", "-b", BRANCH, baseSha]);
  git(workspace, ["remote", "set-url", "origin", "https://github.com/ferueda/harness.git"]);
  const run = Object.freeze({
    version: 1 as const,
    id: "work-spec-FER-286",
    workspace,
    remote: "https://github.com/ferueda/harness.git",
    baseRef: "main",
    baseSha,
    branch: BRANCH,
  });
  return Object.freeze({ root, remote, source, workspace, baseSha, run });
}

function createPublication(
  fixture: Fixture,
  gitTransport: GitPushTransport,
  client: GitHubPullRequestClient,
) {
  return createGitHubPublicationForClient({
    token: TOKEN,
    author: AUTHOR,
    gitTransport,
    client,
  });
}

function request(
  fixture: Fixture,
  expectedChanges: readonly RepositoryChange[] = EXPECTED_CHANGES,
) {
  return {
    run: fixture.run,
    expectedChanges,
    baseBranch: "main",
    commitMessage: "Add FER-286 spec",
    title: "Add FER-286 spec",
    body: "Generated by Harness",
  };
}

function writeSpec(workspace: string): void {
  mkdirSync(join(workspace, "dev", "plans"), { recursive: true });
  writeFileSync(join(workspace, "dev", "plans", "FER-286.md"), "# FER-286\n", "utf8");
}

function localTransport(fixture: Fixture, options: { loseFirstPushResponse?: boolean } = {}) {
  let reads = 0;
  let pushes = 0;
  let lost = false;
  const value: GitPushTransport = {
    async readRemoteBranch(input) {
      reads += 1;
      const output = git(input.workspace, [
        "ls-remote",
        "--heads",
        fixture.remote,
        `refs/heads/${input.branch}`,
      ]);
      if (!output) return null;
      return output.split(/\s+/)[0] ?? null;
    },
    async pushBranch(input) {
      pushes += 1;
      git(input.workspace, ["push", fixture.remote, `HEAD:refs/heads/${input.branch}`]);
      if (options.loseFirstPushResponse && !lost) {
        lost = true;
        throw new Error("push response lost");
      }
    },
  };
  return {
    value,
    counts: () => ({ reads, pushes }),
  };
}

function fakeGitHub(
  fixture: Fixture,
  options: {
    loseCreateResponse?: boolean;
    initialRecords?: readonly GitHubPullRequestRecord[];
  } = {},
) {
  let lists = 0;
  let creates = 0;
  let records = [...(options.initialRecords ?? [])];
  const client: GitHubPullRequestClient = {
    async listPullRequests() {
      lists += 1;
      return Object.freeze([...records]);
    },
    async createPullRequest() {
      creates += 1;
      const record = pullRequestRecord(git(fixture.workspace, ["rev-parse", "HEAD"]));
      records = [record];
      if (options.loseCreateResponse) throw new Error("PR response lost");
      return record;
    },
  };
  return {
    client,
    counts: () => ({ lists, creates }),
  };
}

function pullRequestRecord(
  headSha: string,
  overrides: { state?: "open" | "closed"; merged?: boolean } = {},
): GitHubPullRequestRecord {
  return Object.freeze({
    url: "https://github.com/ferueda/harness/pull/286",
    number: 286,
    state: overrides.state ?? "open",
    merged: overrides.merged ?? false,
    owner: "ferueda",
    repository: "harness",
    baseBranch: "main",
    headOwner: "ferueda",
    headRepository: "harness",
    headBranch: BRANCH,
    headSha,
  });
}

function pushInput(fixture: Fixture) {
  return {
    workspace: fixture.workspace,
    remote: "https://github.com/ferueda/harness.git",
    branch: BRANCH,
    commitSha: git(fixture.workspace, ["rev-parse", "HEAD"]),
    token: TOKEN,
  };
}

function configureAuthor(workspace: string): void {
  git(workspace, ["config", "user.name", "Fixture"]);
  git(workspace, ["config", "user.email", "fixture@example.com"]);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
