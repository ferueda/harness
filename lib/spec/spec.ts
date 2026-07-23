import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Agent,
  AgentProviderName,
  AgentReasoningEffort,
  AgentRunResult,
} from "../agent/contract.ts";
import { errorMessage } from "../agent/invocation.ts";
import { renderSpecPrompt, SPEC_POLICY_VERSION } from "./prompt.ts";
import {
  SPEC_RESULT_SCHEMA_VERSION,
  SpecDecisionSchema,
  SpecIssueReferenceSchema,
  type SpecDecision,
  type SpecWorkItemContext,
} from "./schema.ts";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HARNESS_ROOT = basename(MODULE_ROOT) === "dist" ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;

export const SPEC_RESULT_SCHEMA_PATH = join(HARNESS_ROOT, "schemas/spec-result.schema.json");

export type SpecExecution = Readonly<{
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  maxRuntimeMs: number;
  logPath?: string;
  signal?: AbortSignal;
}>;

export type SpecSessionReference = Readonly<{
  provider: AgentProviderName;
  id: string;
}>;

export type SpecProvenance = Readonly<{
  provider: AgentProviderName;
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  policyVersion: string;
  resultSchemaVersion: string;
  promptSha256: string;
  schemaSha256: string;
  session: SpecSessionReference | null;
}>;

export type SpecIssueFailureKind =
  | "provider"
  | "timeout"
  | "cancelled"
  | "invalid-output"
  | "invalid-artifact"
  | "workspace-guard";

export type SpecIssueResult =
  | Readonly<{
      ok: true;
      decision: SpecDecision;
      provenance: SpecProvenance;
    }>
  | Readonly<{
      ok: false;
      failureKind: SpecIssueFailureKind;
      error: string;
      provenance: SpecProvenance;
    }>;

export async function specIssue(input: {
  workItem: SpecWorkItemContext;
  agent: Agent;
  workspace: string;
  execution: SpecExecution;
}): Promise<SpecIssueResult> {
  const artifactPath = specArtifactPath(input.workItem.reference);
  const prompt = renderSpecPrompt({ workItem: input.workItem, artifactPath });
  const provenance = baseProvenance(
    input.agent.name,
    input.execution.model,
    input.execution.modelReasoningEffort,
    prompt,
  );

  let result: AgentRunResult;
  try {
    result = await input.agent.run({
      workspace: input.workspace,
      prompt,
      schemaPath: SPEC_RESULT_SCHEMA_PATH,
      model: input.execution.model,
      modelReasoningEffort: input.execution.modelReasoningEffort,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      workspaceGuard: "record",
      maxRuntimeMs: input.execution.maxRuntimeMs,
      logPath: input.execution.logPath,
      signal: input.execution.signal,
    });
  } catch (error) {
    return {
      ok: false,
      failureKind: "provider",
      error: `Spec agent failed: ${errorMessage(error)}`,
      provenance,
    };
  }

  const resultProvenance = {
    ...provenance,
    session: result.ok && result.session ? normalizedSession(result.session) : null,
  };

  if (!result.ok) {
    return {
      ok: false,
      failureKind: failureKind(result),
      error: result.error,
      provenance: resultProvenance,
    };
  }

  const decision = SpecDecisionSchema.safeParse(result.structuredOutput);
  if (!decision.success) {
    return {
      ok: false,
      failureKind: "invalid-output",
      error: `Invalid Spec structured output: ${formatZodError(decision.error.issues)}`,
      provenance: resultProvenance,
    };
  }

  if (decision.data.outcome === "ready-for-review") {
    const artifactError = validateSpecArtifact(
      input.workspace,
      artifactPath,
      decision.data.artifactPath,
    );
    if (artifactError) {
      return {
        ok: false,
        failureKind: "invalid-artifact",
        error: artifactError,
        provenance: resultProvenance,
      };
    }
  }

  return {
    ok: true,
    decision: decision.data,
    provenance: resultProvenance,
  };
}

export function specArtifactPath(reference: string): string {
  return `dev/plans/${SpecIssueReferenceSchema.parse(reference)}.md`;
}

function validateSpecArtifact(
  workspace: string,
  expectedPath: string,
  claimedPath: string,
): string | null {
  if (claimedPath !== expectedPath) {
    return `Invalid Spec artifact: expected ${expectedPath}, received ${claimedPath}.`;
  }

  try {
    const workspaceRoot = realpathSync(workspace);
    const candidate = resolve(workspaceRoot, claimedPath);
    const candidateRelative = relative(workspaceRoot, candidate);
    if (
      candidateRelative === ".." ||
      candidateRelative.startsWith(`..${sep}`) ||
      isAbsolute(candidateRelative)
    ) {
      return `Invalid Spec artifact: ${claimedPath} resolves outside the supplied workspace.`;
    }

    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return `Invalid Spec artifact: ${claimedPath} must be a regular file.`;
    }

    const realCandidate = realpathSync(candidate);
    const realRelative = relative(workspaceRoot, realCandidate);
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
      return `Invalid Spec artifact: ${claimedPath} resolves outside the supplied workspace.`;
    }

    if (readFileSync(realCandidate, "utf8").trim() === "") {
      return `Invalid Spec artifact: ${claimedPath} is empty.`;
    }
  } catch (error) {
    return `Invalid Spec artifact ${claimedPath}: ${errorMessage(error)}`;
  }

  return null;
}

function baseProvenance(
  provider: AgentProviderName,
  model: string,
  modelReasoningEffort: AgentReasoningEffort,
  prompt: string,
): SpecProvenance {
  return {
    provider,
    model,
    modelReasoningEffort,
    policyVersion: SPEC_POLICY_VERSION,
    resultSchemaVersion: SPEC_RESULT_SCHEMA_VERSION,
    promptSha256: sha256(prompt),
    schemaSha256: sha256(readFileSync(SPEC_RESULT_SCHEMA_PATH)),
    session: null,
  };
}

function failureKind(result: Extract<AgentRunResult, { ok: false }>): SpecIssueFailureKind {
  if (result.aborted) return "cancelled";
  if (result.exitCode === 124) return "timeout";
  if (result.failureKind === "workspace-guard") return "workspace-guard";
  return "provider";
}

function normalizedSession(session: {
  provider: AgentProviderName;
  id: string;
}): SpecSessionReference {
  return {
    provider: session.provider,
    id: session.id,
  };
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatZodError(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}
