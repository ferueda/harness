import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { expect, test } from "vitest";
import {
  defaultFactoryStoreRoot,
  deriveFactoryRepoIdentity,
  normalizeGitOriginUrl,
  resolveFactoryStore,
} from "../lib/factory-store.ts";
import { factoryStatus } from "../lib/factory-status.ts";
import { ensureFactoryStoreFormat, FactoryStoreFormatError } from "../lib/factory-store-format.ts";

function tempWorkspace(prefix = "harness-factory-store-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeHarnessJson(workspace: string, value: unknown): void {
  writeFileSync(join(workspace, "harness.json"), `${JSON.stringify(value)}\n`, "utf8");
}

function initGit(workspace: string, origin?: string): void {
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: workspace });
}

test("resolves durable store overrides in CLI, env, config, then default order", () => {
  const workspace = tempWorkspace();
  const configRoot = join(workspace, "config-store");
  const envRoot = join(workspace, "env-store");
  const cliRoot = join(workspace, "cli-store");
  writeHarnessJson(workspace, { factory: { store: { root: configRoot, projectId: "config-id" } } });

  expect(
    resolveFactoryStore({
      workspace,
      factoryStoreRoot: cliRoot,
      factoryStoreProjectId: "cli-id",
      env: {
        HARNESS_FACTORY_STORE_ROOT: envRoot,
        HARNESS_FACTORY_STORE_PROJECT_ID: "env-id",
      },
    }),
  ).toMatchObject({
    storeRoot: resolve(cliRoot),
    projectId: "cli-id",
    overrides: { storeRoot: "cli", projectId: "cli" },
  });

  expect(
    resolveFactoryStore({
      workspace,
      env: {
        HARNESS_FACTORY_STORE_ROOT: envRoot,
        HARNESS_FACTORY_STORE_PROJECT_ID: "env-id",
      },
    }),
  ).toMatchObject({
    storeRoot: resolve(envRoot),
    projectId: "env-id",
    overrides: { storeRoot: "env", projectId: "env" },
  });

  expect(resolveFactoryStore({ workspace, env: {} })).toMatchObject({
    storeRoot: resolve(configRoot),
    projectId: "config-id",
    overrides: { storeRoot: "config", projectId: "config" },
  });

  const defaultWorkspace = tempWorkspace();
  const defaults = resolveFactoryStore({ workspace: defaultWorkspace, env: {} });
  expect(defaults.storeRoot).toBe(defaultFactoryStoreRoot({}));
  expect(defaults.projectRoot).toBe(join(defaults.storeRoot, "projects", defaults.projectId));
});

test("rejects unsafe explicit project ids before creating store paths", () => {
  const workspace = tempWorkspace();
  const storeRoot = join(workspace, "store");
  const invalid = [
    "",
    " ",
    ".",
    "..",
    "../escape",
    "a/b",
    "-starts-with-punctuation",
    "a".repeat(121),
  ];

  for (const projectId of invalid) {
    expect(() =>
      resolveFactoryStore({
        workspace,
        factoryStoreRoot: storeRoot,
        factoryStoreProjectId: projectId,
        env: {},
      }),
    ).toThrow(/factory store project id/i);
    expect(existsSync(storeRoot)).toBe(false);
  }

  for (const projectId of invalid) {
    expect(() =>
      resolveFactoryStore({
        workspace,
        factoryStoreRoot: storeRoot,
        env: { HARNESS_FACTORY_STORE_PROJECT_ID: projectId },
      }),
    ).toThrow(/factory store project id/i);
    expect(existsSync(storeRoot)).toBe(false);
  }

  writeHarnessJson(workspace, { factory: { store: { root: storeRoot, projectId: ".." } } });
  expect(() => resolveFactoryStore({ workspace, env: {} })).toThrow(/Invalid harness\.json/i);
  expect(existsSync(storeRoot)).toBe(false);
});

test("rejects blank explicit durable store roots before resolving paths", () => {
  const workspace = tempWorkspace();
  for (const storeRoot of ["", "   "]) {
    expect(() => resolveFactoryStore({ workspace, factoryStoreRoot: storeRoot, env: {} })).toThrow(
      /factory store root/i,
    );
    expect(() =>
      resolveFactoryStore({ workspace, env: { HARNESS_FACTORY_STORE_ROOT: storeRoot } }),
    ).toThrow(/factory store root/i);
  }
  writeHarnessJson(workspace, { factory: { store: { root: "   " } } });
  expect(() => resolveFactoryStore({ workspace, env: {} })).toThrow(/factory store root/i);
  expect(existsSync(join(workspace, "projects"))).toBe(false);
});

test("normalizes HTTPS and SCP origins without credentials", () => {
  expect(normalizeGitOriginUrl("https://token:secret@GitHub.com/Owner/Example.git")).toBe(
    "github.com/owner/example",
  );
  expect(normalizeGitOriginUrl("git@github.com:owner/example.git")).toBe(
    "github.com/owner/example",
  );

  const workspace = tempWorkspace();
  initGit(workspace, "https://token:secret@GitHub.com/Owner/Example.git");
  const repo = deriveFactoryRepoIdentity(workspace);
  expect(repo).toMatchObject({
    name: "example",
    idSource: "origin",
    normalizedOriginUrl: "github.com/owner/example",
  });
  expect(repo.normalizedOriginUrl).not.toContain("secret");
  expect(repo.id).toMatch(/^example-[a-f0-9]{12}$/);
});

test("uses stable no-origin and explicit-workspace fallback identities", () => {
  const gitWorkspace = tempWorkspace();
  initGit(gitWorkspace);
  expect(deriveFactoryRepoIdentity(gitWorkspace)).toMatchObject({
    name: basename(gitWorkspace),
    idSource: "no-origin-fallback",
    warnings: [expect.stringMatching(/projectId/)],
  });

  const workspace = tempWorkspace("Factory Workspace ");
  const storeRoot = join(workspace, "store");
  const resolution = resolveFactoryStore({ workspace, factoryStoreRoot: storeRoot, env: {} });
  expect(resolution.repo).toMatchObject({
    idSource: "workspace-fallback",
    workspaceHash: expect.stringMatching(/^[a-f0-9]{12}$/),
  });
  expect(resolution.projectId).toMatch(/-workspace-[a-f0-9]{12}$/);
  expect(resolution.warnings.join(" ")).toContain("factory.store.projectId");
  expect(existsSync(storeRoot)).toBe(false);
});

test("resolving a store is side-effect free and default data stays outside a harness checkout", () => {
  const workspace = tempWorkspace();
  const storeRoot = join(workspace, "empty-store");
  const resolution = resolveFactoryStore({ workspace, factoryStoreRoot: storeRoot, env: {} });
  expect(existsSync(storeRoot)).toBe(false);
  expect(existsSync(resolution.projectRoot)).toBe(false);

  const checkout = join(homedir(), ".harness");
  expect(relative(checkout, defaultFactoryStoreRoot({})).startsWith("..")).toBe(true);
});

test("factory status reports the durable store and leaves an empty store untouched", () => {
  const workspace = tempWorkspace();
  const storeRoot = join(workspace, "empty-store");
  const store = resolveFactoryStore({ workspace, factoryStoreRoot: storeRoot, env: {} });
  const status = factoryStatus({ workspace, store });

  expect(status.store).toMatchObject({
    storeRoot: resolve(storeRoot),
    projectId: store.projectId,
    factoryStateRoot: store.factoryStateRoot,
  });
  expect(status.locks).toEqual([]);
  expect(existsSync(storeRoot)).toBe(false);
});

test("factory status reports ignored legacy state and stale locks without mutating either", () => {
  const workspace = tempWorkspace();
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: join(workspace, "durable-store"),
    env: {},
  });
  const legacyEventPath = join(workspace, ".harness/factory/events/file-legacy.jsonl");
  mkdirSync(join(workspace, ".harness/factory/state"), { recursive: true });
  mkdirSync(join(workspace, ".harness/factory/events"), { recursive: true });
  writeFileSync(legacyEventPath, '{"legacy":true}\n', "utf8");
  writeFileSync(join(workspace, ".harness/factory/state/file-legacy.json"), "{}\n", "utf8");

  const lockDir = join(store.factoryStateRoot, "locks/file-legacy.lock");
  ensureFactoryStoreFormat(store.factoryStateRoot);
  const ownerPath = join(lockDir, "owner.json");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    ownerPath,
    `${JSON.stringify({
      pid: 1,
      hostname: "other-host",
      token: "lock-token",
      workspace,
      workItemKey: "file:legacy",
      startedAt: "2000-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );

  const status = factoryStatus({ workspace, store });

  expect(status.legacyFactoryState).toMatchObject({
    path: join(workspace, ".harness/factory"),
    eventCount: 1,
    stateCount: 1,
    ignored: true,
  });
  expect(status.locks).toMatchObject([
    {
      workItemKey: "file:legacy",
      stale: true,
      classification: "remote-owner",
      warning: expect.stringMatching(/another hostname/i),
    },
  ]);
  expect(status.warnings).toEqual(
    expect.arrayContaining([
      "Legacy workspace-local factory lifecycle state is ignored; the durable store wins.",
      "Durable factory store is empty for this project; legacy workspace-local lifecycle is ignored.",
    ]),
  );
  expect(readFileSync(legacyEventPath, "utf8")).toBe('{"legacy":true}\n');
  expect(readFileSync(ownerPath, "utf8")).toContain("lock-token");
  expect(existsSync(join(store.factoryStateRoot, "events"))).toBe(false);
  expect(existsSync(join(store.factoryStateRoot, "state"))).toBe(false);
});

test("factory status applies execution-lease staleness without changing ordinary locks", () => {
  const workspace = tempWorkspace();
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: join(workspace, "durable-store"),
    env: {},
  });
  const owners = [
    {
      filename: "linear-ENG-1.implementation-execution",
      workItemKey: "linear:ENG-1",
      pid: process.pid,
      hostname: hostname(),
    },
    {
      filename: "linear-ENG-2.implementation-execution",
      workItemKey: "linear:ENG-2",
      pid: 2_147_483_647,
      hostname: hostname(),
    },
    {
      filename: "linear-ENG-3.implementation-execution",
      workItemKey: "linear:ENG-3",
      pid: 1,
      hostname: "remote-test-host",
    },
    {
      filename: "linear-ENG-4",
      workItemKey: "linear:ENG-4",
      pid: 1,
      hostname: "remote-test-host",
    },
  ];
  ensureFactoryStoreFormat(store.factoryStateRoot);
  for (const owner of owners) {
    const lockDir = join(store.factoryStateRoot, "locks", `${owner.filename}.lock`);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({
        ...owner,
        token: `token-${owner.workItemKey}`,
        workspace,
        startedAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
  }

  const locks = factoryStatus({ workspace, store }).locks;
  expect(locks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ workItemKey: "linear:ENG-1", stale: false }),
      expect.objectContaining({ workItemKey: "linear:ENG-2", stale: true }),
      expect.objectContaining({
        workItemKey: "linear:ENG-3",
        stale: false,
        classification: "remote-owner",
      }),
      expect.objectContaining({
        workItemKey: "linear:ENG-4",
        stale: true,
        classification: "remote-owner",
      }),
    ]),
  );
});

test("factory status rejects a non-empty store without a format marker", () => {
  const workspace = tempWorkspace();
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: join(workspace, "durable-store"),
    env: {},
  });
  mkdirSync(join(store.factoryStateRoot, "events"), { recursive: true });
  writeFileSync(join(store.factoryStateRoot, "events/legacy.jsonl"), "{}\n");

  expect(() => factoryStatus({ workspace, store })).toThrow(FactoryStoreFormatError);
});
