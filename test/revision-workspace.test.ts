import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { prepareGitScope } from "../lib/review/run-context.ts";
import { withReviewWorkspace } from "../lib/review/revision-workspace.ts";

async function inRepository(
  run: (fixture: { source: string; checkout: string; head: string; base: string }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "harness-review-revision-"));
  const source = join(root, "source");
  mkdirSync(source);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Harness Test");
    git("config", "user.email", "harness@example.com");
    writeFileSync(join(source, "README.md"), "base\n");
    git("add", "README.md");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("switch", "-c", "topic");
    writeFileSync(join(source, "README.md"), "reviewed\n");
    git("commit", "-am", "reviewed");
    await run({ source, checkout: join(root, "review"), head: git("rev-parse", "HEAD"), base });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertRemoved(source: string, checkout: string) {
  assert.equal(existsSync(checkout), false);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: source,
    encoding: "utf8",
  });
  assert.equal(worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
}

test("review isolates dirty and untracked caller files", async () => {
  await inRepository(async ({ source, checkout, head }) => {
    writeFileSync(join(source, "README.md"), "local work\n");
    writeFileSync(join(source, "scratch.txt"), "unrelated\n");
    const result = await withReviewWorkspace(source, head, checkout, async (workspace) => {
      assert.equal(readFileSync(join(workspace, "README.md"), "utf8"), "reviewed\n");
      assert.equal(existsSync(join(workspace, "scratch.txt")), false);
      writeFileSync(join(source, "README.md"), "more local work\n");
      assert.equal(readFileSync(join(workspace, "README.md"), "utf8"), "reviewed\n");
      return "pass";
    });
    assert.equal(result, "pass");
    assert.equal(readFileSync(join(source, "README.md"), "utf8"), "more local work\n");
    assert.equal(readFileSync(join(source, "scratch.txt"), "utf8"), "unrelated\n");
    assertRemoved(source, checkout);
  });
});

test("review rejects changed checkout contents and cleans up", async () => {
  await inRepository(async ({ source, checkout, head }) => {
    await assert.rejects(
      withReviewWorkspace(source, head, checkout, async (workspace) => {
        writeFileSync(join(workspace, "README.md"), "changed during review\n");
        return "pass";
      }),
      /no longer matches the captured Git revision/,
    );
    assertRemoved(source, checkout);
  });
});

test("review rejects a different clean HEAD even when porcelain remains empty", async () => {
  await inRepository(async ({ source, checkout, head, base }) => {
    await assert.rejects(
      withReviewWorkspace(source, head, checkout, async (workspace) => {
        execFileSync("git", ["switch", "--detach", base], { cwd: workspace, stdio: "ignore" });
        assert.equal(
          execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }),
          "",
        );
        return "pass";
      }),
      /no longer matches the captured Git revision/,
    );
    assertRemoved(source, checkout);
  });
});

test("review cannot pass when post-run revision verification is unavailable", async () => {
  await inRepository(async ({ source, checkout, head }) => {
    await assert.rejects(
      withReviewWorkspace(source, head, checkout, async (workspace) => {
        const index = execFileSync("git", ["rev-parse", "--git-path", "index"], {
          cwd: workspace,
          encoding: "utf8",
        }).trim();
        writeFileSync(index, "invalid index");
        return "pass";
      }),
    );
    assertRemoved(source, checkout);
  });
});

test("provider rejection still removes the owned checkout", async () => {
  await inRepository(async ({ source, checkout, head }) => {
    await assert.rejects(
      withReviewWorkspace(source, head, checkout, async () => {
        throw new Error("provider unavailable");
      }),
      /provider unavailable/,
    );
    assertRemoved(source, checkout);
  });
});

test("parallel reviewers do not share mutable checkout contents", async () => {
  await inRepository(async ({ source, checkout, head }) => {
    const otherCheckout = `${checkout}-other`;
    const results = await Promise.allSettled([
      withReviewWorkspace(source, head, checkout, async (workspace) => {
        writeFileSync(join(workspace, "README.md"), "changed by one reviewer\n");
        return "pass";
      }),
      withReviewWorkspace(source, head, otherCheckout, async (workspace) => {
        assert.equal(readFileSync(join(workspace, "README.md"), "utf8"), "reviewed\n");
        return "pass";
      }),
    ]);
    assert.equal(results[0].status, "rejected");
    assert.deepEqual(results[1], { status: "fulfilled", value: "pass" });
    assertRemoved(source, checkout);
    assertRemoved(source, otherCheckout);
  });
});

test("creating a review checkout does not execute repository checkout hooks", async () => {
  await inRepository(async ({ source, checkout, head }) => {
    const marker = join(source, "hook-ran");
    writeFileSync(join(source, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    await withReviewWorkspace(source, head, checkout, async () => {
      assert.equal(existsSync(marker), false);
    });
    assertRemoved(source, checkout);
  });
});

test("failed checkout creation leaves a pre-existing directory untouched", async () => {
  await inRepository(async ({ source, checkout, head }) => {
    mkdirSync(checkout);
    writeFileSync(join(checkout, "unrelated.txt"), "keep\n");
    await assert.rejects(
      withReviewWorkspace(source, head, checkout, async () => {
        assert.fail("review must not start");
      }),
    );
    assert.equal(readFileSync(join(checkout, "unrelated.txt"), "utf8"), "keep\n");
  });
});

test("scope resolves annotated tags to the reviewed commit", async () => {
  await inRepository(async ({ source, head, base }) => {
    execFileSync("git", ["tag", "-a", "review-tag", "-m", "review-tag"], { cwd: source });
    const scope = prepareGitScope(source, { baseRef: "main", headRef: "review-tag" });
    assert.equal(scope.headSha, head);
    assert.equal(scope.mergeBase, base);
    assert.match(scope.diff, /\+reviewed/);
  });
});

test("scope keeps the resolved head when its branch advances during capture", async () => {
  await inRepository(async ({ source, head }) => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const git = (...args: string[]) =>
      execFileSync(realGit, args, {
        cwd: source,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    writeFileSync(join(source, "README.md"), "future\n");
    git("commit", "-am", "future");
    const future = git("rev-parse", "HEAD");
    git("reset", "--hard", head);
    const bin = join(source, "test-bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
case "$*" in
  'rev-parse topic'|'rev-parse --verify --end-of-options topic^{commit}')
    '${realGit}' "$@" || exit "$?"
    '${realGit}' update-ref refs/heads/topic '${future}'
    ;;
  *) exec '${realGit}' "$@" ;;
esac
`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const scope = prepareGitScope(source, { baseRef: "main", headRef: "topic" });
      assert.equal(scope.headSha, head);
      assert.equal(git("rev-parse", "topic"), future);
      assert.match(scope.diff, /\+reviewed/);
      assert.doesNotMatch(scope.diff, /\+future/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
