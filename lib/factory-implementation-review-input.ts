import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  loadFactoryLifecycleState,
  deriveFactoryWorkItemKey,
  type FactoryLifecycleState,
} from "./factory-lifecycle.ts";
import {
  ImplementationReviewCheckpointSchema,
  type ImplementationReviewCheckpoint,
  type ArtifactPointer,
} from "./factory-implementation-review-schemas.ts";
import { parseFactoryWorkItem, type FactoryWorkItem } from "./factory-schemas.ts";
import {
  resolveFactoryStore,
  type FactoryStoreMeta,
  type FactoryStoreResolution,
} from "./factory-store.ts";

export type FactoryImplementationReviewIdentityInput = {
  workspace: string;
  itemFile?: string;
  linearIssue?: string;
  factoryStateRoot?: string;
  factoryStore?: FactoryStoreResolution | FactoryStoreMeta;
};

export type FactoryImplementationReviewInput = {
  workspace: string;
  workItemKey: string;
  workItem: FactoryWorkItem;
  state: FactoryLifecycleState;
  checkpoint: ImplementationReviewCheckpoint;
  implementationRunId: string;
  implementationRunDir: string;
  implementationMeta: Record<string, unknown>;
  approvedPlanPath?: string;
  factoryStore: FactoryStoreMeta;
};

export class FactoryImplementationReviewInputError extends Error {
  readonly classification:
    | "identity"
    | "legacy-incomplete"
    | "artifact"
    | "workspace"
    | "provenance"
    | "stage";

  constructor(
    message: string,
    classification: FactoryImplementationReviewInputError["classification"] = "artifact",
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "FactoryImplementationReviewInputError";
    this.classification = classification;
  }
}

export function canonicalizeFactoryReviewIssueIdentifier(issue: string): string {
  const normalized = issue.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(normalized)) {
    throw new FactoryImplementationReviewInputError(
      `Invalid Linear issue identifier: ${issue}`,
      "identity",
    );
  }
  return `linear:${normalized}`;
}

export function resolveFactoryImplementationReviewInput(
  input: FactoryImplementationReviewIdentityInput,
): FactoryImplementationReviewInput {
  const workspace = resolve(input.workspace);
  const workItemKey = resolveIdentity(input, workspace);
  const storeResolution = resolveStore(input.factoryStore, workspace);
  const state = loadFactoryLifecycleState({
    factoryStateRoot: storeResolution.factoryStateRoot,
    workItemKey,
    workspace,
  });
  if (!state) {
    throw new FactoryImplementationReviewInputError(
      `No canonical lifecycle state exists for ${workItemKey}`,
      "identity",
    );
  }
  if (state.factoryStage === "ready-for-human") {
    throw new FactoryImplementationReviewInputError(
      "Factory review is terminal at ready-for-human; human lifecycle recovery is required.",
      "stage",
    );
  }
  if (!state.implementationReviewCheckpoint) {
    if (state.legacyReviewBlock) {
      throw new FactoryImplementationReviewInputError(
        `Implementation review is unavailable for legacy implementation ${state.legacyReviewBlock.owningImplementationRunId}; missing ${state.legacyReviewBlock.missing.join(", ")}.`,
        "legacy-incomplete",
      );
    }
    throw new FactoryImplementationReviewInputError(
      "Canonical lifecycle state has no implementation review checkpoint.",
      "artifact",
    );
  }
  const checkpoint = ImplementationReviewCheckpointSchema.parse(
    state.implementationReviewCheckpoint,
  );
  const implementationRunDir = directChildPath(
    checkpoint.runRoots.factoryRunsDir,
    checkpoint.owningImplementationRunId,
  );
  const implementationMeta = readRecord(
    join(implementationRunDir, "meta.json"),
    "implementation meta",
  );
  const workItem = parseFactoryWorkItem(
    readUnknown(
      join(implementationRunDir, "context", "work-item.json"),
      "implementation work item",
    ),
  );
  if (deriveFactoryWorkItemKey(workItem) !== workItemKey) {
    throw new FactoryImplementationReviewInputError(
      `Implementation work item key does not match lifecycle key ${workItemKey}`,
      "provenance",
    );
  }
  if (implementationMeta.runId !== checkpoint.owningImplementationRunId) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata runId does not match canonical lifecycle owner.",
      "provenance",
    );
  }
  if (implementationMeta.workspace !== workspace) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata workspace does not match the requested workspace.",
      "provenance",
    );
  }
  const storeMeta = implementationMeta.factoryStore;
  if (!isRecord(storeMeta) || storeMeta.factoryRunsDir !== checkpoint.runRoots.factoryRunsDir) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata store provenance does not match the lifecycle checkpoint.",
      "provenance",
    );
  }
  if (implementationMeta.reviewBase !== checkpoint.originalReviewBase) {
    throw new FactoryImplementationReviewInputError(
      "Implementation review base does not match the lifecycle checkpoint.",
      "provenance",
    );
  }
  // Implementation metadata records the immutable initial candidate. The
  // checkpoint may intentionally advance to a later remediation candidate.
  const reviewHead = implementationMeta.reviewHead;
  const reviewCommitSha = implementationMeta.reviewCommitSha;
  if (
    typeof reviewHead !== "string" ||
    typeof reviewCommitSha !== "string" ||
    reviewHead !== `refs/harness/factory/${checkpoint.owningImplementationRunId}/implementation`
  ) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata does not contain the immutable initial candidate provenance.",
      "provenance",
    );
  }
  if (typeof implementationMeta.reviewTree === "string") {
    const initialTree = readCandidateTree(workspace, reviewCommitSha);
    if (initialTree !== implementationMeta.reviewTree) {
      throw new FactoryImplementationReviewInputError(
        "Implementation metadata initial candidate tree does not match its commit.",
        "provenance",
      );
    }
  }
  return {
    workspace,
    workItemKey,
    workItem,
    state,
    checkpoint,
    implementationRunId: checkpoint.owningImplementationRunId,
    implementationRunDir,
    implementationMeta,
    ...(isRecord(implementationMeta.factoryMetadata) &&
    typeof implementationMeta.factoryMetadata.approvedPlanPath === "string"
      ? { approvedPlanPath: implementationMeta.factoryMetadata.approvedPlanPath }
      : {}),
    factoryStore: normalizeStoreMeta(storeResolution, storeMeta),
  };
}

function readCandidateTree(workspace: string, commit: string): string {
  try {
    return execFileSync("git", ["rev-parse", `${commit}^{tree}`], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata initial candidate commit is unavailable.",
      "provenance",
      { cause: error },
    );
  }
}

/** Resolve a durable pointer only through its recorded immutable run root. */
export function resolveFactoryArtifactPointer(input: {
  pointer: ArtifactPointer;
  runRoots: { factoryRunsDir: string; reviewRunsDir: string };
}): string {
  const root = resolve(
    input.pointer.root === "factory" ? input.runRoots.factoryRunsDir : input.runRoots.reviewRunsDir,
  );
  const runDir = resolve(root, input.pointer.runId);
  const runRelative = relative(root, runDir);
  if (
    !runRelative ||
    runRelative === ".." ||
    runRelative.startsWith("../") ||
    isAbsolute(runRelative)
  ) {
    throw new FactoryImplementationReviewInputError(
      "Artifact pointer run escapes its recorded root.",
      "provenance",
    );
  }
  if (
    !existsSync(runDir) ||
    !lstatSync(runDir).isDirectory() ||
    lstatSync(runDir).isSymbolicLink()
  ) {
    throw new FactoryImplementationReviewInputError(
      "Artifact pointer run directory is missing or symlinked.",
      "artifact",
    );
  }
  const candidate = resolve(runDir, input.pointer.path);
  const candidateRelative = relative(runDir, candidate);
  if (
    !candidateRelative ||
    candidateRelative === ".." ||
    candidateRelative.startsWith("../") ||
    isAbsolute(candidateRelative)
  ) {
    throw new FactoryImplementationReviewInputError(
      "Artifact pointer path escapes its run directory.",
      "provenance",
    );
  }
  const realRun = realpathSync(runDir);
  if (existsSync(candidate)) {
    const realCandidate = realpathSync(candidate);
    const realRelative = relative(realRun, realCandidate);
    if (
      !realRelative ||
      realRelative === ".." ||
      realRelative.startsWith("../") ||
      isAbsolute(realRelative)
    ) {
      throw new FactoryImplementationReviewInputError(
        "Artifact pointer symlink escapes its run directory.",
        "provenance",
      );
    }
  }
  return candidate;
}

function resolveIdentity(
  input: FactoryImplementationReviewIdentityInput,
  workspace: string,
): string {
  if (Boolean(input.itemFile) === Boolean(input.linearIssue)) {
    throw new FactoryImplementationReviewInputError(
      "Exactly one of --item-file or --linear-issue is required.",
      "identity",
    );
  }
  if (input.linearIssue) return canonicalizeFactoryReviewIssueIdentifier(input.linearIssue);
  const path = resolve(workspace, input.itemFile!);
  const workItem = parseFactoryWorkItem(readUnknown(path, "item file"));
  return deriveFactoryWorkItemKey(workItem);
}

function resolveStore(
  store: FactoryStoreResolution | FactoryStoreMeta | undefined,
  workspace: string,
): FactoryStoreResolution {
  if (!store) return resolveFactoryStore({ workspace });
  if ("workspace" in store) return store;
  return {
    workspace,
    ...store,
    overrides: {},
    warnings: [],
  };
}

function normalizeStoreMeta(
  resolution: FactoryStoreResolution,
  implementationStore: Record<string, unknown>,
): FactoryStoreMeta {
  const factoryRunsDir = String(implementationStore.factoryRunsDir);
  const reviewRunsDir = String(implementationStore.reviewRunsDir ?? resolution.reviewRunsDir);
  return {
    storeRoot: String(implementationStore.storeRoot ?? resolution.storeRoot),
    projectId: String(implementationStore.projectId ?? resolution.projectId),
    projectRoot: String(implementationStore.projectRoot ?? resolution.projectRoot),
    factoryStateRoot: String(implementationStore.factoryStateRoot ?? resolution.factoryStateRoot),
    factoryRunsDir,
    reviewRunsDir,
    repo: resolution.repo,
    overrides: resolution.overrides,
    warnings: resolution.warnings,
  };
}

function directChildPath(root: string, runId: string): string {
  const canonicalRoot = resolve(root);
  const path = resolve(canonicalRoot, runId);
  const pathRelative = relative(canonicalRoot, path);
  if (
    !pathRelative ||
    pathRelative === ".." ||
    pathRelative.startsWith("../") ||
    isAbsolute(pathRelative)
  ) {
    throw new FactoryImplementationReviewInputError(
      "Recorded implementation run escapes its store root.",
      "provenance",
    );
  }
  if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new FactoryImplementationReviewInputError(
      `Recorded implementation run directory is missing or not a real directory: ${path}`,
      "artifact",
    );
  }
  return path;
}

function readRecord(path: string, label: string): Record<string, unknown> {
  const value = readUnknown(path, label);
  if (!isRecord(value)) {
    throw new FactoryImplementationReviewInputError(
      `${label} must be an object: ${path}`,
      "artifact",
    );
  }
  return value;
}

function readUnknown(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new FactoryImplementationReviewInputError(`Cannot read ${label}: ${path}`, "artifact", {
      cause: error,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
