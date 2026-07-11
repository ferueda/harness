import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  loadFactoryLifecycleState,
  deriveFactoryWorkItemKey,
  type FactoryLifecycleState,
} from "./factory-lifecycle.ts";
import {
  AgentSessionRefSchema,
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
import { canonicalizeFactoryWorkspace } from "./factory-locks.ts";

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

export type FactoryImplementationReviewLegacyInput = {
  workspace: string;
  workItemKey: string;
  workItem: FactoryWorkItem;
  state: FactoryLifecycleState;
  factoryStore: FactoryStoreMeta;
  missing: NonNullable<FactoryLifecycleState["legacyReviewBlock"]>["missing"];
  implementationRunId: string;
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
  if (state.factoryStage === "ready-for-human") {
    throw new FactoryImplementationReviewInputError(
      "Factory review is terminal at ready-for-human; human lifecycle recovery is required.",
      "stage",
    );
  }
  const implementationRunDir = directChildPath(
    checkpoint.runRoots.factoryRunsDir,
    checkpoint.owningImplementationRunId,
  );
  const implementationMeta = readImplementationMeta(implementationRunDir);
  const workItem = parseFactoryWorkItem(
    readRegularFileJson(
      join(implementationRunDir, "context", "work-item.json"),
      implementationRunDir,
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
  if (implementationMeta.status !== "implementation-complete") {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata is not an implementation-complete run.",
      "stage",
    );
  }
  if (!samePhysicalPath(String(implementationMeta.runDir ?? ""), implementationRunDir)) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata runDir does not match its recorded durable run.",
      "provenance",
    );
  }
  if (!samePhysicalPath(String(implementationMeta.workspace ?? ""), workspace)) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata workspace does not match the requested workspace.",
      "provenance",
    );
  }
  const storeMeta = implementationMeta.factoryStore;
  if (
    !isRecord(storeMeta) ||
    !samePhysicalPath(String(storeMeta.factoryRunsDir ?? ""), checkpoint.runRoots.factoryRunsDir) ||
    !samePhysicalPath(String(storeMeta.reviewRunsDir ?? ""), checkpoint.runRoots.reviewRunsDir)
  ) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata store provenance does not match the lifecycle checkpoint.",
      "provenance",
    );
  }
  if (
    !samePhysicalPath(String(storeMeta.storeRoot ?? ""), storeResolution.storeRoot) ||
    !samePhysicalPath(String(storeMeta.factoryStateRoot ?? ""), storeResolution.factoryStateRoot) ||
    storeMeta.projectId !== storeResolution.projectId
  ) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata store identity does not match the lifecycle store.",
      "provenance",
    );
  }
  const implementationSession = AgentSessionRefSchema.safeParse(
    implementationMeta.implementerSession,
  );
  if (!implementationSession.success) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata is missing a structured implementer session.",
      "provenance",
      { cause: implementationSession.error },
    );
  }
  if (stableJson(implementationSession.data) !== stableJson(checkpoint.implementerSession)) {
    throw new FactoryImplementationReviewInputError(
      "Implementation session does not match the lifecycle checkpoint owner.",
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
  if (typeof implementationMeta.reviewTree !== "string") {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata is missing immutable initial candidate tree provenance.",
      "provenance",
    );
  }
  const initialTree = readCandidateTree(workspace, reviewCommitSha);
  if (initialTree !== implementationMeta.reviewTree) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata initial candidate tree does not match its commit.",
      "provenance",
    );
  }
  validateCheckpointProvenance({
    workspace,
    checkpoint,
    implementationMeta,
    storeResolution,
  });
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
      ? {
          approvedPlanPath: validateWorkspaceArtifactPath(
            workspace,
            implementationMeta.factoryMetadata.approvedPlanPath,
            "approved plan",
          ),
        }
      : {}),
    factoryStore: normalizeStoreMeta(storeResolution, storeMeta),
  };
}

/** Resolve only the durable identity needed to terminalize a legacy run. */
export function resolveFactoryImplementationReviewLegacyInput(
  input: FactoryImplementationReviewIdentityInput,
): FactoryImplementationReviewLegacyInput {
  const workspace = resolve(input.workspace);
  const workItemKey = resolveIdentity(input, workspace);
  const storeResolution = resolveStore(input.factoryStore, workspace);
  const state = loadFactoryLifecycleState({
    factoryStateRoot: storeResolution.factoryStateRoot,
    workItemKey,
    workspace,
  });
  if (!state?.legacyReviewBlock) {
    throw new FactoryImplementationReviewInputError(
      "Canonical lifecycle state is not a legacy implementation.",
      "artifact",
    );
  }
  const workItem = input.itemFile
    ? parseFactoryWorkItem(readUnknown(resolve(workspace, input.itemFile), "item file"))
    : {
        id: workItemKey.slice("linear:".length),
        source: "linear" as const,
        title: state.title ?? workItemKey,
        body: "",
        labels: [],
        metadata: {
          tracker: { source: "linear" as const, id: workItemKey.slice("linear:".length) },
        },
      };
  if (deriveFactoryWorkItemKey(workItem) !== workItemKey) {
    throw new FactoryImplementationReviewInputError(
      "Legacy implementation work item does not match lifecycle identity.",
      "provenance",
    );
  }
  return {
    workspace,
    workItemKey,
    workItem,
    state,
    factoryStore: normalizeStoreMeta(storeResolution, {
      factoryRunsDir: storeResolution.factoryRunsDir,
    }),
    missing: state.legacyReviewBlock.missing,
    implementationRunId: state.legacyReviewBlock.owningImplementationRunId,
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
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.pointer.runId) ||
    input.pointer.runId === "." ||
    input.pointer.runId === ".."
  ) {
    throw new FactoryImplementationReviewInputError(
      "Artifact pointer run ID is not a safe direct-child name.",
      "provenance",
    );
  }
  const root = resolve(
    input.pointer.root === "factory" ? input.runRoots.factoryRunsDir : input.runRoots.reviewRunsDir,
  );
  const realRoot = realpathSync(root);
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
  const runStat = existsSync(runDir) ? lstatSync(runDir) : undefined;
  if (!runStat || !runStat.isDirectory() || runStat.isSymbolicLink()) {
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
  const candidateStat = existsSync(candidate) ? lstatSync(candidate) : undefined;
  if (!candidateStat || !candidateStat.isFile() || candidateStat.isSymbolicLink()) {
    throw new FactoryImplementationReviewInputError(
      "Artifact pointer target is missing, symlinked, or not a regular file.",
      "artifact",
    );
  }
  const realRun = realpathSync(runDir);
  const realRunRelative = relative(realRoot, realRun);
  if (realRunRelative !== input.pointer.runId) {
    throw new FactoryImplementationReviewInputError(
      "Artifact pointer run is not a direct child of its recorded root.",
      "provenance",
    );
  }
  {
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

function validateCheckpointProvenance(input: {
  workspace: string;
  checkpoint: ImplementationReviewCheckpoint;
  implementationMeta: Record<string, unknown>;
  storeResolution: FactoryStoreResolution;
}): void {
  const { checkpoint, implementationMeta, storeResolution } = input;
  const implementationStore = isRecord(implementationMeta.factoryStore)
    ? implementationMeta.factoryStore
    : {};
  if (
    !samePhysicalPath(
      checkpoint.runRoots.factoryRunsDir,
      String(implementationStore.factoryRunsDir),
    )
  ) {
    throw new FactoryImplementationReviewInputError(
      "Review checkpoint factory run root does not match implementation provenance.",
      "provenance",
    );
  }
  if (
    !samePhysicalPath(checkpoint.runRoots.reviewRunsDir, String(implementationStore.reviewRunsDir))
  ) {
    throw new FactoryImplementationReviewInputError(
      "Review checkpoint review run root does not match implementation provenance.",
      "provenance",
    );
  }
  const canonicalWorkspace = canonicalizeFactoryWorkspace(input.workspace);
  if (
    checkpoint.workspace.physicalGitRoot !== canonicalWorkspace.physicalGitRoot ||
    checkpoint.workspace.workspaceKey !== canonicalWorkspace.workspaceKey ||
    checkpoint.workspace.factoryProjectId !== storeResolution.projectId
  ) {
    throw new FactoryImplementationReviewInputError(
      "Review checkpoint workspace provenance does not match the durable implementation input.",
      "provenance",
    );
  }
  const initialRef = `refs/harness/factory/${checkpoint.owningImplementationRunId}/implementation`;
  if (
    implementationMeta.reviewHead !== initialRef ||
    checkpoint.approvedCandidate.ref !==
      (checkpoint.candidateVersion === 0
        ? initialRef
        : `refs/harness/factory/${checkpoint.owningImplementationRunId}/review/${checkpoint.candidateVersion}`)
  ) {
    throw new FactoryImplementationReviewInputError(
      "Approved candidate ref is not bound to the implementation provenance namespace.",
      "provenance",
    );
  }
  const initialCommit = String(implementationMeta.reviewCommitSha ?? "");
  if (checkpoint.candidateVersion === 0 && checkpoint.approvedCandidate.commit !== initialCommit) {
    throw new FactoryImplementationReviewInputError(
      "Approved candidate is not the immutable implementation candidate.",
      "provenance",
    );
  }
  const candidateCommit = readGit(input.workspace, ["rev-parse", checkpoint.approvedCandidate.ref]);
  const candidateTree = readGit(input.workspace, ["rev-parse", `${candidateCommit}^{tree}`]);
  if (
    candidateCommit !== checkpoint.approvedCandidate.commit ||
    candidateTree !== checkpoint.approvedCandidate.tree
  ) {
    throw new FactoryImplementationReviewInputError(
      "Approved candidate tuple does not match its immutable Git ref.",
      "provenance",
    );
  }
  if (checkpoint.candidateVersion > 0) {
    const parentRef =
      checkpoint.candidateVersion === 1
        ? initialRef
        : `refs/harness/factory/${checkpoint.owningImplementationRunId}/review/${checkpoint.candidateVersion - 1}`;
    const parent = readGit(input.workspace, ["rev-parse", parentRef]);
    if (readGit(input.workspace, ["rev-parse", `${candidateCommit}^`]) !== parent) {
      throw new FactoryImplementationReviewInputError(
        "Approved remediation candidate does not descend from the prior candidate.",
        "provenance",
      );
    }
  }
}

function samePhysicalPath(left: string, right: string): boolean {
  try {
    return realpathSync(resolve(left)) === realpathSync(resolve(right));
  } catch {
    return false;
  }
}

function readGit(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new FactoryImplementationReviewInputError(
      `Cannot resolve Git provenance: ${args.join(" ")}`,
      "provenance",
      { cause: error },
    );
  }
}

function validateWorkspaceArtifactPath(workspace: string, path: string, label: string): string {
  const candidate = resolve(workspace, path);
  const stat = existsSync(candidate) ? lstatSync(candidate) : undefined;
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new FactoryImplementationReviewInputError(
      `${label} is missing, symlinked, or not a regular file: ${candidate}`,
      "artifact",
    );
  }
  const root = realpathSync(workspace);
  const realCandidate = realpathSync(candidate);
  const pathRelative = relative(root, realCandidate);
  if (
    !pathRelative ||
    pathRelative === ".." ||
    pathRelative.startsWith("../") ||
    isAbsolute(pathRelative)
  ) {
    throw new FactoryImplementationReviewInputError(
      `${label} escapes the physical workspace: ${candidate}`,
      "provenance",
    );
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === "." || runId === "..") {
    throw new FactoryImplementationReviewInputError(
      "Recorded implementation run ID is not a safe direct-child name.",
      "provenance",
    );
  }
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
  const realRoot = realpathSync(canonicalRoot);
  const realRun = realpathSync(path);
  if (relative(realRoot, realRun) !== runId) {
    throw new FactoryImplementationReviewInputError(
      "Recorded implementation run is not a direct child of its physical store root.",
      "provenance",
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

function readImplementationMeta(runDir: string): Record<string, unknown> {
  const metaPath = validateRunArtifactPath(runDir, "meta.json", "implementation meta");
  const meta = readRecord(metaPath, "implementation meta");
  const artifacts = meta.artifacts;
  if (
    !isRecord(artifacts) ||
    typeof artifacts.diff !== "string" ||
    typeof artifacts.changeReviewHandoff !== "string"
  ) {
    throw new FactoryImplementationReviewInputError(
      "Implementation metadata is missing required candidate artifacts.",
      "artifact",
    );
  }
  for (const [label, artifact] of [
    ["implementation summary", artifacts.summary],
    ["implementation input", artifacts.implementationInput],
    ["implementation diff", artifacts.diff],
    ["implementation handoff", artifacts.changeReviewHandoff],
  ] as const) {
    if (typeof artifact !== "string") {
      throw new FactoryImplementationReviewInputError(
        `Implementation metadata is missing ${label}.`,
        "artifact",
      );
    }
    validateRunArtifactPath(runDir, artifact, label);
  }
  return meta;
}

function readRegularFileJson(path: string, root: string, label: string): unknown {
  const safePath = validateRunArtifactPath(root, relative(root, path), label);
  return readUnknown(safePath, label);
}

function validateRunArtifactPath(root: string, path: string, label: string): string {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) {
    throw new FactoryImplementationReviewInputError(
      `${label} must be a relative artifact path.`,
      "provenance",
    );
  }
  const candidate = resolve(root, path);
  const lexical = relative(root, candidate);
  if (!lexical || lexical === ".." || lexical.startsWith("../") || isAbsolute(lexical)) {
    throw new FactoryImplementationReviewInputError(
      `${label} escapes its durable run root.`,
      "provenance",
    );
  }
  const stat = existsSync(candidate) ? lstatSync(candidate) : undefined;
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new FactoryImplementationReviewInputError(
      `${label} is missing, symlinked, or not a regular file: ${candidate}`,
      "artifact",
    );
  }
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const realRelative = relative(realRoot, realCandidate);
  if (
    !realRelative ||
    realRelative === ".." ||
    realRelative.startsWith("../") ||
    isAbsolute(realRelative)
  ) {
    throw new FactoryImplementationReviewInputError(
      `${label} escapes the physical durable run root.`,
      "provenance",
    );
  }
  return candidate;
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
