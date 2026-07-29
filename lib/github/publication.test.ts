import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHubPublicationForClient } from "./publication.ts";
import type {
  GitHubPullRequestClient,
  GitHubPullRequestRecord,
  GitPushTransport,
} from "./types.ts";
import { createRepositoryCheckpoint } from "../repository/checkpoint.ts";
import { inspectGitChanges } from "../repository/git.ts";
import type { RepositoryCheckpoint, RepositoryRun } from "../repository/types.ts";

const TOKEN = "github-secret";
const BRANCH = "codex/FER-286";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("GitHub publication", () => {
  it("publishes an approved checkpoint without changing its revision", async () => {
    const fixture = createFixture();
    const checkpoint = await createCheckpoint(fixture, "checkpoint:approved");
    const transport = localTransport(fixture);
    const github = fakeGitHub(fixture);
    const publication = createPublication(transport.value, github.client);
    const commitCount = git(fixture.workspace, ["rev-list", "--count", "HEAD"]);

    const first = await publication.publishCheckpointPullRequest(
      checkpointRequest(fixture, checkpoint),
    );
    const second = await publication.publishCheckpointPullRequest(
      checkpointRequest(fixture, checkpoint),
    );

    expect(second).toEqual(first);
    expect(first.headSha).toBe(checkpoint.revision);
    expect(git(fixture.workspace, ["rev-parse", "HEAD"])).toBe(checkpoint.revision);
    expect(git(fixture.workspace, ["rev-list", "--count", "HEAD"])).toBe(commitCount);
    expect(git(fixture.remote, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(checkpoint.revision);
    expect(transport.counts()).toEqual({ reads: 2, pushes: 1 });
    expect(github.counts()).toEqual({ lists: 2, creates: 1 });
  });

  it("recovers checkpoint publication after ambiguous push and PR responses", async () => {
    const fixture = createFixture();
    const checkpoint = await createCheckpoint(fixture, "checkpoint:recovery");
    const transport = localTransport(fixture, { loseFirstPushResponse: true });
    const github = fakeGitHub(fixture, { loseCreateResponse: true });
    const publication = createPublication(transport.value, github.client);

    await expect(
      publication.publishCheckpointPullRequest(checkpointRequest(fixture, checkpoint)),
    ).resolves.toMatchObject({ headSha: checkpoint.revision });

    expect(transport.counts()).toEqual({ reads: 2, pushes: 1 });
    expect(github.counts()).toEqual({ lists: 2, creates: 1 });
  });

  it.each([
    { state: "open" as const, merged: false },
    { state: "closed" as const, merged: false },
    { state: "closed" as const, merged: true },
  ])(
    "returns one existing $state checkpoint PR without replacing it",
    async ({ state, merged }) => {
      const fixture = createFixture();
      const checkpoint = await createCheckpoint(fixture, "checkpoint:existing");
      const transport = localTransport(fixture);
      await transport.value.pushBranch({
        workspace: fixture.workspace,
        remote: fixture.run.remote,
        branch: fixture.run.branch,
        commitSha: checkpoint.revision,
        token: TOKEN,
      });
      const github = fakeGitHub(fixture, {
        initialRecords: [pullRequestRecord(checkpoint.revision, { state, merged })],
      });
      const publication = createPublication(transport.value, github.client);

      const result = await publication.publishCheckpointPullRequest(
        checkpointRequest(fixture, checkpoint),
      );

      expect(result).toMatchObject({ state, merged, headSha: checkpoint.revision });
      expect(github.counts()).toEqual({ lists: 1, creates: 0 });
    },
  );

  it("rejects multiple pull requests for one checkpoint branch", async () => {
    const fixture = createFixture();
    const checkpoint = await createCheckpoint(fixture, "checkpoint:multiple-prs");
    const transport = localTransport(fixture);
    await transport.value.pushBranch({
      workspace: fixture.workspace,
      remote: fixture.run.remote,
      branch: fixture.run.branch,
      commitSha: checkpoint.revision,
      token: TOKEN,
    });
    const github = fakeGitHub(fixture, {
      initialRecords: [
        pullRequestRecord(checkpoint.revision),
        { ...pullRequestRecord(checkpoint.revision), number: 287 },
      ],
    });
    const publication = createPublication(transport.value, github.client);

    await expect(
      publication.publishCheckpointPullRequest(checkpointRequest(fixture, checkpoint)),
    ).rejects.toMatchObject({ code: "github-conflict" });
  });

  it("rejects a pull request whose head SHA differs from its checkpoint", async () => {
    const fixture = createFixture();
    const checkpoint = await createCheckpoint(fixture, "checkpoint:wrong-pr-head");
    const transport = localTransport(fixture);
    await transport.value.pushBranch({
      workspace: fixture.workspace,
      remote: fixture.run.remote,
      branch: fixture.run.branch,
      commitSha: checkpoint.revision,
      token: TOKEN,
    });
    const differentSha = checkpoint.revision.replace(
      /^./,
      checkpoint.revision.startsWith("a") ? "b" : "a",
    );
    const github = fakeGitHub(fixture, {
      initialRecords: [pullRequestRecord(differentSha)],
    });
    const publication = createPublication(transport.value, github.client);

    await expect(
      publication.publishCheckpointPullRequest(checkpointRequest(fixture, checkpoint)),
    ).rejects.toMatchObject({ code: "github-conflict" });
  });

  it("publishes the latest approved checkpoint in a revision chain", async () => {
    const fixture = createFixture();
    const first = await createCheckpoint(fixture, "checkpoint:chain:first");
    writeFileSync(
      join(fixture.workspace, "dev", "plans", "FER-286.md"),
      "# FER-286 revised\n",
      "utf8",
    );
    const second = await createCheckpoint(fixture, "checkpoint:chain:second", first.revision);
    const transport = localTransport(fixture);
    const github = fakeGitHub(fixture);
    const publication = createPublication(transport.value, github.client);

    const result = await publication.publishCheckpointPullRequest(
      checkpointRequest(fixture, second),
    );

    expect(result.headSha).toBe(second.revision);
    expect(second.parentRevision).toBe(first.revision);
    expect(git(fixture.workspace, ["rev-parse", `${second.revision}^`])).toBe(first.revision);
    expect(git(fixture.remote, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(second.revision);
  });

  it.each([
    {
      mismatch: "base",
      alter: (_fixture: Fixture, checkpoint: RepositoryCheckpoint) => ({
        ...checkpoint,
        baseSha: checkpoint.revision,
      }),
    },
    {
      mismatch: "branch",
      alter: (_fixture: Fixture, checkpoint: RepositoryCheckpoint) => ({
        ...checkpoint,
        branch: "codex/another-branch",
      }),
    },
    {
      mismatch: "run",
      alter: (_fixture: Fixture, checkpoint: RepositoryCheckpoint) => ({
        ...checkpoint,
        runId: "another-run",
      }),
    },
    {
      mismatch: "revision",
      alter: (_fixture: Fixture, checkpoint: RepositoryCheckpoint) => ({
        ...checkpoint,
        revision: checkpoint.parentRevision,
      }),
    },
    {
      mismatch: "metadata",
      alter: (_fixture: Fixture, checkpoint: RepositoryCheckpoint) => ({
        ...checkpoint,
        id: "checkpoint:another",
      }),
    },
    {
      mismatch: "change set",
      alter: (_fixture: Fixture, checkpoint: RepositoryCheckpoint) => ({
        ...checkpoint,
        changes: [{ path: "another.md", status: "added" as const }],
      }),
    },
    {
      mismatch: "dirty workspace",
      alter: (fixture: Fixture, checkpoint: RepositoryCheckpoint) => {
        writeFileSync(join(fixture.workspace, "dirty.txt"), "dirty\n", "utf8");
        return checkpoint;
      },
    },
  ])("rejects a $mismatch mismatch before remote access", async ({ alter }) => {
    const fixture = createFixture();
    const checkpoint = await createCheckpoint(fixture, "checkpoint:validation");
    const altered = alter(fixture, checkpoint);
    const transport = localTransport(fixture);
    const github = fakeGitHub(fixture);
    const publication = createPublication(transport.value, github.client);
    const headSha = git(fixture.workspace, ["rev-parse", "HEAD"]);

    await expect(
      publication.publishCheckpointPullRequest(checkpointRequest(fixture, altered)),
    ).rejects.toMatchObject({ code: "run-conflict" });

    expect(git(fixture.workspace, ["rev-parse", "HEAD"])).toBe(headSha);
    expect(transport.counts()).toEqual({ reads: 0, pushes: 0 });
    expect(github.counts()).toEqual({ lists: 0, creates: 0 });
  });
});

type Fixture = Readonly<{
  remote: string;
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
  return Object.freeze({ remote, workspace, baseSha, run });
}

function createPublication(gitTransport: GitPushTransport, client: GitHubPullRequestClient) {
  return createGitHubPublicationForClient({
    token: TOKEN,
    gitTransport,
    client,
  });
}

function checkpointRequest(fixture: Fixture, checkpoint: RepositoryCheckpoint) {
  return {
    run: fixture.run,
    checkpoint,
    baseBranch: "main",
    title: "Add FER-286 spec",
    body: "Generated by Harness",
  };
}

async function createCheckpoint(
  fixture: Fixture,
  id: string,
  parentRevision = fixture.baseSha,
): Promise<RepositoryCheckpoint> {
  if (parentRevision === fixture.baseSha) writeSpec(fixture.workspace);
  const expectedChanges = await inspectGitChanges(fixture.workspace);
  return createRepositoryCheckpoint({
    id,
    run: fixture.run,
    expectedParentRevision: parentRevision,
    expectedChanges,
    message: "Checkpoint FER-286 spec",
  });
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
      git(input.workspace, [
        "push",
        fixture.remote,
        `${input.commitSha}:refs/heads/${input.branch}`,
      ]);
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
