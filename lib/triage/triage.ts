import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, AgentProviderName, AgentReasoningEffort, AgentRunResult } from "../agents.ts";
import { errorMessage } from "../agent-invoke.ts";
import { renderTriagePrompt, TRIAGE_POLICY_VERSION } from "./prompt.ts";
import {
  TRIAGE_DECISION_SCHEMA_VERSION,
  TriageDecisionSchema,
  type TriageDecision,
  type TriageWorkItemContext,
} from "./schema.ts";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HARNESS_ROOT = basename(MODULE_ROOT) === "dist" ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;

export const TRIAGE_DECISION_SCHEMA_PATH = join(
  HARNESS_ROOT,
  "schemas/triage-decision.schema.json",
);

export type TriageExecution = Readonly<{
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  maxRuntimeMs: number;
  logPath?: string;
  signal?: AbortSignal;
}>;

export type TriageSessionReference = Readonly<{
  provider: AgentProviderName;
  id: string;
}>;

export type TriageProvenance = Readonly<{
  provider: AgentProviderName;
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  policyVersion: string;
  decisionSchemaVersion: string;
  /** Hash of the exact rendered prompt passed to Agent.run, before adapter translation. */
  promptSha256: string;
  /** Hash of the exact decision-schema file passed to Agent.run through schemaPath. */
  schemaSha256: string;
  session: TriageSessionReference | null;
}>;

export type TriageIssueFailureKind =
  | "provider"
  | "invalid-output"
  | "cancelled"
  | "workspace-guard";

export type TriageIssueResult =
  | Readonly<{
      ok: true;
      decision: TriageDecision;
      provenance: TriageProvenance;
    }>
  | Readonly<{
      ok: false;
      failureKind: TriageIssueFailureKind;
      error: string;
      provenance: TriageProvenance;
    }>;

export async function triageIssue(input: {
  workItem: TriageWorkItemContext;
  agent: Agent;
  workspace: string;
  execution: TriageExecution;
}): Promise<TriageIssueResult> {
  const prompt = renderTriagePrompt(input.workItem);
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
      schemaPath: TRIAGE_DECISION_SCHEMA_PATH,
      model: input.execution.model,
      modelReasoningEffort: input.execution.modelReasoningEffort,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      workspaceGuard: "enforce",
      maxRuntimeMs: input.execution.maxRuntimeMs,
      logPath: input.execution.logPath,
      signal: input.execution.signal,
    });
  } catch (error) {
    return {
      ok: false,
      failureKind: "provider",
      error: `Triage agent failed: ${errorMessage(error)}`,
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

  const decision = TriageDecisionSchema.safeParse(result.structuredOutput);
  if (!decision.success) {
    return {
      ok: false,
      failureKind: "invalid-output",
      error: `Invalid triage structured output: ${formatTriageZodError(decision.error.issues)}`,
      provenance: resultProvenance,
    };
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
): TriageProvenance {
  return {
    provider,
    model,
    modelReasoningEffort,
    policyVersion: TRIAGE_POLICY_VERSION,
    decisionSchemaVersion: TRIAGE_DECISION_SCHEMA_VERSION,
    promptSha256: sha256(prompt),
    schemaSha256: sha256(readFileSync(TRIAGE_DECISION_SCHEMA_PATH)),
    session: null,
  };
}

function failureKind(result: Extract<AgentRunResult, { ok: false }>): TriageIssueFailureKind {
  if (result.aborted) return "cancelled";
  if (result.failureKind === "workspace-guard") return "workspace-guard";
  return "provider";
}

function normalizedSession(session: {
  provider: AgentProviderName;
  id: string;
}): TriageSessionReference {
  return {
    provider: session.provider,
    id: session.id,
  };
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatTriageZodError(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  return issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}
