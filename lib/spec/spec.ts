import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Agent,
  AgentProviderName,
  AgentReasoningEffort,
  AgentRunResult,
} from "../agent/contract.ts";
import { errorMessage } from "../agent/invocation.ts";
import { inspectSpecArtifact, specArtifactPath } from "./artifact.ts";
import { renderSpecPrompt, SPEC_POLICY_VERSION } from "./prompt.ts";
import {
  SPEC_RESULT_SCHEMA_VERSION,
  SpecDecisionSchema,
  type SpecDecision,
  type SpecWorkItemContext,
} from "./schema.ts";

export { specArtifactPath } from "./artifact.ts";

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
    const artifact = inspectSpecArtifact({
      workspace: input.workspace,
      expectedPath: artifactPath,
      claimedPath: decision.data.artifactPath,
    });
    if (!artifact.ok) {
      return {
        ok: false,
        failureKind: "invalid-artifact",
        error: artifact.error,
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
