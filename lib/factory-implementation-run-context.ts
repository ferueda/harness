import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FactoryRoleAgent } from "./config.ts";
import { factoryActionExecutionProfile } from "./config.ts";
import { buildRunId } from "./context.ts";
import { verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import type { FactoryImplementationInput } from "./factory-implementation-input.ts";
import {
  readFactoryPhaseRunIdentity,
  writeFactoryPhaseRunIdentity,
  type FactoryImplementationInputSnapshot,
} from "./factory-phase-run.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { parseFactoryWorkItem, type FactoryWorkItem } from "./factory-schemas.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";
import {
  createCompositeEventSink,
  createFileEventSink,
  type WorkflowEventSink,
} from "./workflow-events.ts";

export class FactoryImplementationRunError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryImplementationRunError";
  }
}

export type FactoryImplementationRunContext = ReturnType<
  typeof openFactoryImplementationRunContext
>;

export function createFactoryImplementationRunContext(input: {
  workspace: string;
  runsDir: string;
  workItem: FactoryWorkItem;
  factoryStore: FactoryStoreMeta;
  implementationInput: FactoryImplementationInput;
  reviewCeiling: number;
  implementerRole: FactoryRoleAgent;
  reviewerRole: FactoryRoleAgent;
  eventSink?: WorkflowEventSink;
}) {
  const workspace = canonicalWorkspace(input.workspace);
  const gitIdentity = assertImplementationStartGit(workspace);
  const authoritativeWorkItemPath = verifyFactoryArtifactRef(
    input.implementationInput.workItem,
    roots(input.factoryStore, workspace),
  );
  const authoritativeWorkItem = parseFactoryWorkItem(
    JSON.parse(readFileSync(authoritativeWorkItemPath, "utf8")),
  );
  if (deriveFactoryWorkItemKey(authoritativeWorkItem) !== deriveFactoryWorkItemKey(input.workItem))
    throw new FactoryImplementationRunError(
      "Immutable implementation work item conflicts with input key",
    );
  validateInputAuthority(
    input.implementationInput,
    input.factoryStore,
    workspace,
    gitIdentity.baseSha,
  );
  const runId = buildRunId(new Date());
  const runDir = join(resolve(input.runsDir), runId);
  try {
    mkdirSync(join(runDir, "context"), { recursive: true });
    writeJson(join(runDir, "context/work-item.json"), authoritativeWorkItem);
    writeJson(join(runDir, "context/implementation-input.json"), input.implementationInput);
    const snapshot: FactoryImplementationInputSnapshot = {
      ...input.implementationInput,
    };
    writeFactoryPhaseRunIdentity(runDir, {
      version: 1,
      phaseRunId: runId,
      phase: "implementation",
      workItemKey: deriveFactoryWorkItemKey(authoritativeWorkItem),
      workspace,
      projectId: input.factoryStore.projectId,
      factoryStateRoot: resolve(input.factoryStore.factoryStateRoot),
      reviewCeiling: input.reviewCeiling,
      branchRef: gitIdentity.branchRef,
      baseSha: gitIdentity.baseSha,
      input: snapshot,
      actions: {
        produceImplementationCandidate: factoryActionExecutionProfile(input.implementerRole),
        reviewImplementationCandidate: factoryActionExecutionProfile(input.reviewerRole),
      },
    });
  } catch (error) {
    rmSync(runDir, { recursive: true, force: true });
    throw wrap(error);
  }
  return openFactoryImplementationRunContext({
    workspace,
    runsDir: input.runsDir,
    phaseRunId: runId,
    workItem: input.workItem,
    factoryStore: input.factoryStore,
    eventSink: input.eventSink,
  });
}

export function openFactoryImplementationRunContext(input: {
  workspace: string;
  runsDir: string;
  phaseRunId: string;
  workItem: FactoryWorkItem;
  factoryStore: FactoryStoreMeta;
  eventSink?: WorkflowEventSink;
}) {
  const workspace = canonicalWorkspace(input.workspace);
  const runDir = join(resolve(input.runsDir), input.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(runDir);
  if (
    identity.phase !== "implementation" ||
    identity.phaseRunId !== input.phaseRunId ||
    identity.workItemKey !== deriveFactoryWorkItemKey(input.workItem) ||
    identity.workspace !== workspace ||
    identity.projectId !== input.factoryStore.projectId ||
    identity.factoryStateRoot !== resolve(input.factoryStore.factoryStateRoot)
  )
    throw new FactoryImplementationRunError(
      `Factory implementation phase-run identity conflicts with ${input.phaseRunId}`,
    );
  const branchRef = git(workspace, ["symbolic-ref", "-q", "HEAD"]).trim();
  if (branchRef !== identity.branchRef)
    throw new FactoryImplementationRunError(
      `Factory implementation branch conflicts with persisted ${identity.branchRef}`,
    );
  const authoritativeWorkItemPath = verifyFactoryArtifactRef(
    identity.input.workItem,
    roots(input.factoryStore, workspace),
  );
  const persisted = parseFactoryWorkItem(
    JSON.parse(readFileSync(authoritativeWorkItemPath, "utf8")),
  );
  if (deriveFactoryWorkItemKey(persisted) !== identity.workItemKey)
    throw new FactoryImplementationRunError("Factory implementation work-item input changed");
  verifyInputSnapshot(identity.input, input.factoryStore, workspace);
  const eventSink = input.eventSink
    ? createCompositeEventSink(createFileEventSink(runDir), input.eventSink)
    : createFileEventSink(runDir);
  return {
    runId: identity.phaseRunId,
    runDir,
    workspace,
    workItem: persisted,
    factoryStore: input.factoryStore,
    identity,
    eventSink,
  };
}

function assertImplementationStartGit(workspace: string): { branchRef: string; baseSha: string } {
  let branchRef = "";
  try {
    branchRef = execFileSync("git", ["symbolic-ref", "-q", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new FactoryImplementationRunError("Factory implementation requires an attached branch");
  }
  if (!branchRef.startsWith("refs/heads/"))
    throw new FactoryImplementationRunError("Factory implementation requires an attached branch");
  const status = git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim())
    throw new FactoryImplementationRunError("Factory implementation requires a clean workspace");
  return { branchRef, baseSha: git(workspace, ["rev-parse", "HEAD"]).trim() };
}

function validateInputAuthority(
  input: FactoryImplementationInput,
  store: FactoryStoreMeta,
  workspace: string,
  baseSha: string,
): void {
  if (input.mode === "direct") {
    verifyFactoryArtifactRef(input.readiness, roots(store, workspace));
    return;
  }
  const candidatePath = verifyFactoryArtifactRef(input.planCandidate, roots(store, workspace));
  const candidate = readFileSync(candidatePath);
  const atBase = gitBuffer(workspace, ["show", `${baseSha}:${input.outputPlan}`]);
  if (!candidate.equals(atBase))
    throw new FactoryImplementationRunError(
      "Committed implementation plan does not match the reviewed candidate",
    );
  if (input.publicationMode === "pull-request") {
    if (!input.mergedCommit)
      throw new FactoryImplementationRunError(
        "Pull-request implementation input lacks merge commit",
      );
    git(workspace, ["merge-base", "--is-ancestor", input.mergedCommit, baseSha]);
    const atMerge = gitBuffer(workspace, ["show", `${input.mergedCommit}:${input.outputPlan}`]);
    if (!candidate.equals(atMerge))
      throw new FactoryImplementationRunError("Merged plan does not match the reviewed candidate");
  }
}

function verifyInputSnapshot(
  snapshot: FactoryImplementationInputSnapshot,
  store: FactoryStoreMeta,
  workspace: string,
): void {
  verifyFactoryArtifactRef(snapshot.workItem, roots(store, workspace));
  if (snapshot.mode === "direct")
    verifyFactoryArtifactRef(snapshot.readiness, roots(store, workspace));
  else verifyFactoryArtifactRef(snapshot.planCandidate, roots(store, workspace));
}

function roots(store: FactoryStoreMeta, workspace: string) {
  return { "factory-store": store.projectRoot, repository: workspace } as const;
}

function canonicalWorkspace(workspace: string): string {
  return realpathSync(git(workspace, ["rev-parse", "--show-toplevel"]).trim());
}

function git(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw wrap(error);
  }
}

function gitBuffer(workspace: string, args: string[]): Buffer {
  try {
    return execFileSync("git", args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw wrap(error);
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function wrap(error: unknown): FactoryImplementationRunError {
  return error instanceof FactoryImplementationRunError
    ? error
    : new FactoryImplementationRunError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
}
