import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { RepositoryError } from "./error.ts";
import {
  inspectCommittedGitChanges,
  inspectGitChanges,
  inspectStagedGitChanges,
  runGit,
} from "./git.ts";
import type {
  RepositoryChange,
  RepositoryCheckpoint,
  RepositoryCheckpointInput,
  RepositoryRun,
} from "./types.ts";

const CHECKPOINT_VERSION = 1;
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CHECKPOINT_REF_ROOT = "refs/harness/checkpoints/v1";
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const AUTHOR = Object.freeze({
  name: "Harness",
  email: "harness@localhost",
});
const METADATA_KEYS = Object.freeze({
  checkpointId: "Harness-Checkpoint-ID",
  runId: "Harness-Run-ID",
  baseSha: "Harness-Base-SHA",
  branch: "Harness-Branch",
  changesSha256: "Harness-Changes-SHA256",
});
const RESERVED_TRAILER = new RegExp(`^(?:${Object.values(METADATA_KEYS).join("|")}):`, "im");
const SAFE_COMMIT_CONFIG = Object.freeze([
  "-c",
  "credential.helper=",
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "commit.gpgsign=false",
]);
const COMMIT_ENVIRONMENT = Object.freeze({
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_CONFIG_NOSYSTEM: "1",
});

type CheckpointIdentity = Readonly<{
  id: string;
  run: RepositoryRun;
  expectedParentRevision: string;
  expectedChanges: readonly RepositoryChange[];
  fullMessage: string;
  ref: string;
}>;

type CommitDetails = Readonly<{
  parents: readonly string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}>;

type CheckpointMetadata = Readonly<{
  checkpointId: string;
  runId: string;
  baseSha: string;
  branch: string;
  changesSha256: string;
}>;

export async function createRepositoryCheckpoint(
  input: RepositoryCheckpointInput,
): Promise<RepositoryCheckpoint> {
  const identity = checkpointIdentity(input);
  const headRevision = await assertWorkspace(identity.run);
  await assertExpectedParent(identity);

  const existingRevision = await findExistingCheckpoint(identity, headRevision);
  if (existingRevision) {
    await assertCleanWorkspace(identity.run.workspace);
    await assertAncestor(identity.run.workspace, existingRevision, headRevision);
    if (headRevision !== existingRevision) {
      await assertAcceptedCheckpointRevision(identity.run, headRevision);
    }
    await assertCheckpointCommit(identity, existingRevision);
    await ensureCheckpointRef(identity, existingRevision);
    return checkpointResult(identity, existingRevision);
  }

  if (headRevision !== identity.expectedParentRevision) {
    throw conflict("Repository run HEAD does not match the expected checkpoint parent.");
  }

  const workspaceChanges = await inspectGitChanges(identity.run.workspace);
  assertExactChanges(workspaceChanges, identity.expectedChanges, "workspace");
  await stageExpectedChanges(identity);
  const stagedChanges = await inspectStagedGitChanges(
    identity.run.workspace,
    identity.expectedParentRevision,
  );
  assertCommittedChanges(stagedChanges, identity.expectedChanges, "staged");
  await assertNoUnstagedChanges(identity.run.workspace);
  await commitCheckpoint(identity);

  const revision = await readHead(identity.run.workspace);
  await assertCheckpointCommit(identity, revision);
  await assertCleanWorkspace(identity.run.workspace);
  await ensureCheckpointRef(identity, revision);
  return checkpointResult(identity, revision);
}

export function validateRepositoryCheckpoint(
  checkpoint: RepositoryCheckpoint,
): RepositoryCheckpoint {
  if (
    checkpoint.version !== CHECKPOINT_VERSION ||
    !ID.test(checkpoint.id) ||
    !ID.test(checkpoint.runId) ||
    !FULL_GIT_SHA.test(checkpoint.baseSha) ||
    !FULL_GIT_SHA.test(checkpoint.parentRevision) ||
    !FULL_GIT_SHA.test(checkpoint.revision) ||
    !checkpoint.branch.trim() ||
    hasCommandControl(checkpoint.branch) ||
    !Array.isArray(checkpoint.changes)
  ) {
    throw invalid("Repository checkpoint identity is invalid.");
  }
  return Object.freeze({
    version: CHECKPOINT_VERSION,
    id: checkpoint.id,
    runId: checkpoint.runId,
    baseSha: checkpoint.baseSha,
    parentRevision: checkpoint.parentRevision,
    revision: checkpoint.revision,
    branch: checkpoint.branch,
    changes: freezeExpectedChanges(checkpoint.changes),
  });
}

export async function verifyRepositoryCheckpoint(
  run: RepositoryRun,
  input: RepositoryCheckpoint,
): Promise<void> {
  assertRunIdentity(run);
  const checkpoint = validateRepositoryCheckpoint(input);
  if (
    checkpoint.runId !== run.id ||
    checkpoint.baseSha !== run.baseSha ||
    checkpoint.branch !== run.branch
  ) {
    throw conflict("Repository checkpoint does not match the repository run identity.");
  }

  const headRevision = await assertWorkspace(run);
  if (headRevision !== checkpoint.revision) {
    throw conflict("Repository run HEAD does not match the checkpoint revision.");
  }
  await assertCleanWorkspace(run.workspace);
  await assertCheckpointHistory(run, checkpoint);
  await assertStoredCheckpoint(run, checkpoint);
}

function checkpointIdentity(input: RepositoryCheckpointInput): CheckpointIdentity {
  const id = input.id.trim();
  const message = input.message.trim();
  if (!ID.test(id)) {
    throw invalid("Repository checkpoint ID is invalid.");
  }
  assertRunIdentity(input.run);
  if (!FULL_GIT_SHA.test(input.expectedParentRevision)) {
    throw invalid("Repository checkpoint parent must be an exact commit SHA.");
  }
  if (!message || message.includes("\u0000") || RESERVED_TRAILER.test(message)) {
    throw invalid("Repository checkpoint message is empty or contains reserved metadata.");
  }
  const expectedChanges = freezeExpectedChanges(input.expectedChanges);
  const changesSha256 = hashChanges(expectedChanges);
  const metadata: CheckpointMetadata = {
    checkpointId: id,
    runId: input.run.id,
    baseSha: input.run.baseSha,
    branch: input.run.branch,
    changesSha256,
  };
  return Object.freeze({
    id,
    run: input.run,
    expectedParentRevision: input.expectedParentRevision,
    expectedChanges,
    fullMessage: renderCheckpointMessage(message, metadata),
    ref: checkpointRef(id),
  });
}

function assertRunIdentity(run: RepositoryRun): void {
  if (
    run.version !== 1 ||
    !ID.test(run.id) ||
    !FULL_GIT_SHA.test(run.baseSha) ||
    !run.baseRef.trim() ||
    !run.remote.trim() ||
    hasCommandControl(run.remote) ||
    !run.branch.trim() ||
    hasCommandControl(run.branch) ||
    !isAbsolute(run.workspace)
  ) {
    throw invalid("Repository run identity is invalid.");
  }
}

async function assertWorkspace(run: RepositoryRun): Promise<string> {
  const [workspace, root, branch, remote, headRevision] = await Promise.all([
    realpath(run.workspace),
    runGit(run.workspace, ["rev-parse", "--show-toplevel"], "checkpoint_failed").then(realpath),
    runGit(run.workspace, ["branch", "--show-current"], "checkpoint_failed"),
    runGit(run.workspace, ["remote", "get-url", "origin"], "checkpoint_failed"),
    readHead(run.workspace),
  ]);
  if (workspace !== root || branch !== run.branch || remote !== run.remote) {
    throw conflict(
      "Repository run workspace, branch, or origin no longer matches its durable identity.",
    );
  }
  await runGit(run.workspace, ["check-ref-format", "--branch", run.branch], "checkpoint_failed");
  return headRevision;
}

async function assertCheckpointHistory(
  run: RepositoryRun,
  checkpoint: RepositoryCheckpoint,
): Promise<void> {
  await Promise.all([
    runGit(
      run.workspace,
      ["rev-parse", "--verify", `${run.baseSha}^{commit}`],
      "checkpoint_failed",
    ),
    runGit(
      run.workspace,
      ["rev-parse", "--verify", `${checkpoint.parentRevision}^{commit}`],
      "checkpoint_failed",
    ),
    runGit(
      run.workspace,
      ["rev-parse", "--verify", `${checkpoint.revision}^{commit}`],
      "checkpoint_failed",
    ),
  ]);
  await assertAncestor(run.workspace, run.baseSha, checkpoint.parentRevision);
  if (checkpoint.parentRevision !== run.baseSha) {
    await assertAcceptedCheckpointRevision(run, checkpoint.parentRevision);
  }
}

async function assertStoredCheckpoint(
  run: RepositoryRun,
  checkpoint: RepositoryCheckpoint,
): Promise<void> {
  // Both the immutable local ref and commit metadata must bind the durable
  // checkpoint identity to this exact commit and approved change set.
  const [referencedRevision, details] = await Promise.all([
    readCheckpointRevision(run.workspace, checkpointRef(checkpoint.id)),
    readCommitDetails(run.workspace, checkpoint.revision),
  ]);
  const metadata = parseCheckpointMetadata(details.message);
  if (
    referencedRevision !== checkpoint.revision ||
    details.parents.length !== 1 ||
    details.parents[0] !== checkpoint.parentRevision ||
    !hasHarnessAuthor(details) ||
    !metadata ||
    metadata.checkpointId !== checkpoint.id ||
    metadata.runId !== checkpoint.runId ||
    metadata.baseSha !== checkpoint.baseSha ||
    metadata.branch !== checkpoint.branch ||
    metadata.changesSha256 !== hashChanges(checkpoint.changes)
  ) {
    throw conflict(`Repository checkpoint ${checkpoint.id} no longer matches its durable record.`);
  }
  const committedChanges = await inspectCommittedGitChanges(
    run.workspace,
    checkpoint.parentRevision,
    checkpoint.revision,
  );
  assertCommittedChanges(committedChanges, checkpoint.changes, "committed");
}

async function assertExpectedParent(identity: CheckpointIdentity): Promise<void> {
  const { run, expectedParentRevision } = identity;
  await runGit(
    run.workspace,
    ["rev-parse", "--verify", `${run.baseSha}^{commit}`],
    "checkpoint_failed",
  );
  await runGit(
    run.workspace,
    ["rev-parse", "--verify", `${expectedParentRevision}^{commit}`],
    "checkpoint_failed",
  );
  await assertAncestor(run.workspace, run.baseSha, expectedParentRevision);
  if (expectedParentRevision === run.baseSha) return;

  const details = await readCommitDetails(run.workspace, expectedParentRevision);
  await assertAcceptedCheckpointRevision(run, expectedParentRevision, details);
}

async function findExistingCheckpoint(
  identity: CheckpointIdentity,
  headRevision: string,
): Promise<string | null> {
  const referenced = await readCheckpointRef(identity);
  if (referenced) return referenced;

  const output = await runGit(
    identity.run.workspace,
    ["rev-list", "--first-parent", `${identity.run.baseSha}..${headRevision}`],
    "checkpoint_failed",
  );
  const matches: string[] = [];
  for (const revision of output.split("\n").filter(Boolean)) {
    const details = await readCommitDetails(identity.run.workspace, revision);
    const metadata = parseCheckpointMetadata(details.message);
    if (metadata?.checkpointId === identity.id) matches.push(revision);
  }
  if (matches.length > 1) {
    throw conflict(`Repository checkpoint ID ${identity.id} resolves to multiple commits.`);
  }
  return matches[0] ?? null;
}

async function readCheckpointRef(identity: CheckpointIdentity): Promise<string | null> {
  return readCheckpointRevision(identity.run.workspace, identity.ref);
}

async function readCheckpointRevision(workspace: string, ref: string): Promise<string | null> {
  const revision = await runGit(
    workspace,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    "checkpoint_failed",
    { acceptedExitCodes: [1] },
  );
  return revision || null;
}

async function ensureCheckpointRef(identity: CheckpointIdentity, revision: string): Promise<void> {
  const existing = await readCheckpointRef(identity);
  if (existing === revision) return;
  if (existing) {
    throw conflict(`Repository checkpoint ID ${identity.id} is already in use.`);
  }

  try {
    await runGit(
      identity.run.workspace,
      ["update-ref", "--no-deref", identity.ref, revision, "0".repeat(revision.length)],
      "checkpoint_failed",
    );
  } catch (error) {
    // A concurrent retry may have stored the same immutable identity first.
    const recovered = await readCheckpointRef(identity);
    if (recovered === revision) return;
    throw error;
  }
}

async function stageExpectedChanges(identity: CheckpointIdentity): Promise<void> {
  const approvedPaths = new Set<string>();
  for (const change of identity.expectedChanges) {
    approvedPaths.add(change.path);
    if (change.previousPath) approvedPaths.add(change.previousPath);
  }
  const paths = await readUnstagedPaths(identity.run.workspace);
  if (paths.some((path) => !approvedPaths.has(path))) {
    throw conflict("Repository workspace changed while preparing its checkpoint.");
  }
  if (paths.length === 0) return;
  await runGit(
    identity.run.workspace,
    ["--literal-pathspecs", "add", "-A", "--", ...paths],
    "checkpoint_failed",
  );
}

async function assertNoUnstagedChanges(workspace: string): Promise<void> {
  if ((await readUnstagedPaths(workspace)).length !== 0) {
    throw conflict("Repository workspace changed while preparing its checkpoint.");
  }
}

async function readUnstagedPaths(workspace: string): Promise<readonly string[]> {
  const [unstaged, untracked] = await Promise.all([
    runGit(workspace, ["diff", "--name-only", "-z", "--no-ext-diff"], "checkpoint_failed"),
    runGit(workspace, ["ls-files", "--others", "--exclude-standard", "-z"], "checkpoint_failed"),
  ]);
  return Object.freeze(
    [...new Set([...nulFields(unstaged), ...nulFields(untracked)])].sort((left, right) =>
      left.localeCompare(right),
    ),
  );
}

function nulFields(output: string): readonly string[] {
  return output.split("\0").filter(Boolean);
}

async function assertCleanWorkspace(workspace: string): Promise<void> {
  if ((await inspectGitChanges(workspace)).length !== 0) {
    throw conflict("Repository checkpoint workspace contains uncommitted changes.");
  }
}

async function commitCheckpoint(identity: CheckpointIdentity): Promise<void> {
  await runGit(
    identity.run.workspace,
    [
      ...SAFE_COMMIT_CONFIG,
      "commit",
      "--no-gpg-sign",
      "--no-verify",
      "--cleanup=verbatim",
      "-m",
      identity.fullMessage,
    ],
    "checkpoint_failed",
    { environment: COMMIT_ENVIRONMENT },
  );
}

async function assertAcceptedCheckpointRevision(
  run: RepositoryRun,
  revision: string,
  details: CommitDetails | undefined = undefined,
): Promise<void> {
  const commit = details ?? (await readCommitDetails(run.workspace, revision));
  const metadata = parseCheckpointMetadata(commit.message);
  if (
    !metadata ||
    !ID.test(metadata.checkpointId) ||
    metadata.runId !== run.id ||
    metadata.baseSha !== run.baseSha ||
    metadata.branch !== run.branch ||
    commit.parents.length !== 1 ||
    !hasHarnessAuthor(commit) ||
    (await readCheckpointRevision(run.workspace, checkpointRef(metadata.checkpointId))) !== revision
  ) {
    throw conflict("Repository checkpoint parent is not an accepted checkpoint from this run.");
  }
}

async function assertCheckpointCommit(
  identity: CheckpointIdentity,
  revision: string,
): Promise<void> {
  const details = await readCommitDetails(identity.run.workspace, revision);
  if (
    details.parents.length !== 1 ||
    details.parents[0] !== identity.expectedParentRevision ||
    details.message !== identity.fullMessage ||
    !hasHarnessAuthor(details)
  ) {
    throw conflict(`Existing repository checkpoint ${identity.id} does not match this request.`);
  }
  const committedChanges = await inspectCommittedGitChanges(
    identity.run.workspace,
    identity.expectedParentRevision,
    revision,
  );
  assertCommittedChanges(committedChanges, identity.expectedChanges, "committed");
}

async function readCommitDetails(workspace: string, revision: string): Promise<CommitDetails> {
  const output = await runGit(
    workspace,
    ["show", "-s", "--format=%P%x00%an%x00%ae%x00%cn%x00%ce%x00%B", revision],
    "checkpoint_failed",
  );
  const [
    parents = "",
    authorName = "",
    authorEmail = "",
    committerName = "",
    committerEmail = "",
    ...messageParts
  ] = output.split("\0");
  return Object.freeze({
    parents: Object.freeze(parents.trim().split(/\s+/).filter(Boolean)),
    authorName,
    authorEmail,
    committerName,
    committerEmail,
    message: messageParts.join("\0").trimEnd(),
  });
}

function parseCheckpointMetadata(message: string): CheckpointMetadata | null {
  const lines = message.split("\n");
  if (lines.length < 7) return null;
  const trailerStart = lines.length - 5;
  if (lines[trailerStart - 1] !== "") return null;
  const values = Object.values(METADATA_KEYS).map((key, index) => {
    const prefix = `${key}: `;
    const line = lines[trailerStart + index];
    return line?.startsWith(prefix) ? line.slice(prefix.length) : null;
  });
  if (values.some((value) => value === null)) return null;
  const [checkpointId, runId, baseSha, branch, changesSha256] = values as string[];
  if (
    !checkpointId ||
    !runId ||
    !baseSha ||
    !branch ||
    !changesSha256 ||
    !/^[0-9a-f]{64}$/.test(changesSha256)
  ) {
    return null;
  }
  return Object.freeze({ checkpointId, runId, baseSha, branch, changesSha256 });
}

function renderCheckpointMessage(message: string, metadata: CheckpointMetadata): string {
  return [
    message,
    "",
    `${METADATA_KEYS.checkpointId}: ${metadata.checkpointId}`,
    `${METADATA_KEYS.runId}: ${metadata.runId}`,
    `${METADATA_KEYS.baseSha}: ${metadata.baseSha}`,
    `${METADATA_KEYS.branch}: ${metadata.branch}`,
    `${METADATA_KEYS.changesSha256}: ${metadata.changesSha256}`,
  ].join("\n");
}

function hasHarnessAuthor(details: CommitDetails): boolean {
  return (
    details.authorName === AUTHOR.name &&
    details.authorEmail === AUTHOR.email &&
    details.committerName === AUTHOR.name &&
    details.committerEmail === AUTHOR.email
  );
}

async function assertAncestor(
  workspace: string,
  ancestor: string,
  descendant: string,
): Promise<void> {
  const mergeBase = await runGit(
    workspace,
    ["merge-base", ancestor, descendant],
    "checkpoint_failed",
  );
  if (mergeBase !== ancestor) {
    throw conflict("Repository checkpoint history no longer descends from its expected revision.");
  }
}

async function readHead(workspace: string): Promise<string> {
  const revision = await runGit(workspace, ["rev-parse", "--verify", "HEAD"], "checkpoint_failed");
  if (!FULL_GIT_SHA.test(revision)) {
    throw new RepositoryError("Git returned an invalid repository HEAD.", "checkpoint_failed");
  }
  return revision;
}

function freezeExpectedChanges(changes: readonly RepositoryChange[]): readonly RepositoryChange[] {
  if (changes.length === 0) {
    throw invalid("Repository checkpoint requires at least one expected change.");
  }
  const frozen = changes.map((change) => {
    if (
      !change.path ||
      change.path.includes("\u0000") ||
      change.status === "conflicted" ||
      !["added", "modified", "deleted", "renamed", "copied", "untracked"].includes(change.status) ||
      ((change.status === "renamed" || change.status === "copied") && !change.previousPath) ||
      (change.previousPath?.includes("\u0000") ?? false)
    ) {
      throw invalid("Repository checkpoint contains an invalid or conflicted change.");
    }
    return Object.freeze({
      path: change.path,
      ...(change.previousPath ? { previousPath: change.previousPath } : {}),
      status: change.status,
    });
  });
  if (
    new Set(frozen.map((change) => JSON.stringify(canonicalChange(change)))).size !== frozen.length
  ) {
    throw invalid("Repository checkpoint contains duplicate expected changes.");
  }
  return Object.freeze(frozen);
}

function assertExactChanges(
  actual: readonly RepositoryChange[],
  expected: readonly RepositoryChange[],
  stage: string,
): void {
  if (canonicalChanges(actual) !== canonicalChanges(expected)) {
    throw conflict(`Repository ${stage} changes do not match the expected change set.`);
  }
}

function assertCommittedChanges(
  actual: readonly RepositoryChange[],
  expected: readonly RepositoryChange[],
  stage: string,
): void {
  if (canonicalCommittedChanges(actual) !== canonicalCommittedChanges(expected)) {
    throw conflict(`Repository ${stage} changes do not match the expected change set.`);
  }
}

function canonicalChanges(changes: readonly RepositoryChange[]): string {
  return JSON.stringify(changes.map(canonicalChange).sort(compareChanges));
}

function canonicalCommittedChanges(changes: readonly RepositoryChange[]): string {
  const normalized: ReturnType<typeof canonicalChange>[] = [];
  for (const change of changes) {
    if (change.status === "renamed") {
      if (change.previousPath) {
        normalized.push({ path: change.previousPath, previousPath: "", status: "deleted" });
      }
      normalized.push({ path: change.path, previousPath: "", status: "added" });
      continue;
    }
    if (change.status === "copied" || change.status === "untracked") {
      normalized.push({ path: change.path, previousPath: "", status: "added" });
      continue;
    }
    normalized.push(canonicalChange(change));
  }
  return JSON.stringify(normalized.sort(compareChanges));
}

function canonicalChange(change: RepositoryChange): {
  path: string;
  previousPath: string;
  status: string;
} {
  return {
    path: change.path,
    previousPath: change.previousPath ?? "",
    status: change.status,
  };
}

function compareChanges(
  left: ReturnType<typeof canonicalChange>,
  right: ReturnType<typeof canonicalChange>,
): number {
  return (
    left.path.localeCompare(right.path) ||
    left.status.localeCompare(right.status) ||
    left.previousPath.localeCompare(right.previousPath)
  );
}

function hashChanges(changes: readonly RepositoryChange[]): string {
  return createHash("sha256").update(canonicalChanges(changes)).digest("hex");
}

function checkpointResult(identity: CheckpointIdentity, revision: string): RepositoryCheckpoint {
  return Object.freeze({
    version: CHECKPOINT_VERSION,
    id: identity.id,
    runId: identity.run.id,
    baseSha: identity.run.baseSha,
    parentRevision: identity.expectedParentRevision,
    revision,
    branch: identity.run.branch,
    changes: identity.expectedChanges,
  });
}

function checkpointRef(id: string): string {
  return `${CHECKPOINT_REF_ROOT}/${createHash("sha256").update(id).digest("hex")}`;
}

function hasCommandControl(value: string): boolean {
  return value.includes("\u0000") || value.includes("\r") || value.includes("\n");
}

function invalid(message: string): RepositoryError {
  return new RepositoryError(message, "invalid_input");
}

function conflict(message: string): RepositoryError {
  return new RepositoryError(message, "run_conflict");
}
