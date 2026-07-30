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
import { normalizeAgentSessionForProvider } from "../agent/session.ts";
import { renderImplementationPrompt, IMPLEMENTATION_POLICY_VERSION } from "./prompt.ts";
import {
  IMPLEMENTATION_RESULT_SCHEMA_VERSION,
  ImplementationDecisionSchema,
  type ImplementationDecision,
} from "./schema.ts";
import {
  inspectImplementationSource,
  verifyImplementationSource,
  type ImplementationSource,
  type ImplementationSourceAuthority,
} from "./source.ts";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HARNESS_ROOT = basename(MODULE_ROOT) === "dist" ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;

export const IMPLEMENTATION_RESULT_SCHEMA_PATH = join(
  HARNESS_ROOT,
  "schemas/implementation-result.schema.json",
);

export type ImplementationExecution = Readonly<{
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  maxRuntimeMs: number;
  logPath?: string;
  signal?: AbortSignal;
}>;

export type ImplementationSessionReference = Readonly<{
  provider: AgentProviderName;
  id: string;
}>;

export type ImplementationSourceProvenance = Readonly<{
  kind: ImplementationSource["kind"];
  issueReference: string;
  path: string | null;
  sha256: string;
}>;

export type ImplementationProvenance = Readonly<{
  provider: AgentProviderName;
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  policyVersion: string;
  resultSchemaVersion: string;
  promptSha256: string | null;
  schemaSha256: string | null;
  source: ImplementationSourceProvenance | null;
  session: ImplementationSessionReference | null;
}>;

export type ImplementationFailureKind =
  | "provider"
  | "timeout"
  | "cancelled"
  | "invalid-output"
  | "invalid-session"
  | "invalid-source"
  | "source-integrity"
  | "workspace-guard";

export type ImplementationResult =
  | Readonly<{
      ok: true;
      decision: ImplementationDecision;
      provenance: ImplementationProvenance;
    }>
  | Readonly<{
      ok: false;
      failureKind: ImplementationFailureKind;
      error: string;
      provenance: ImplementationProvenance;
    }>;

export async function implementWorkItem(input: {
  source: ImplementationSource;
  workspace: string;
  agent: Agent;
  execution: ImplementationExecution;
}): Promise<ImplementationResult> {
  const resultSchema = inspectResultSchema();
  let provenance = createProvenance({
    provider: input.agent.name,
    execution: input.execution,
    prompt: null,
    schemaSha256: resultSchema.ok ? resultSchema.sha256 : null,
    source: null,
    session: null,
  });

  if (!resultSchema.ok) {
    return failure("provider", resultSchema.error, provenance);
  }

  const inspected = inspectImplementationSource({
    workspace: input.workspace,
    source: input.source,
  });
  if (!inspected.ok) {
    return failure("invalid-source", inspected.error, provenance);
  }

  const authority = inspected.value;
  const prompt = renderImplementationPrompt(authority);
  provenance = createProvenance({
    provider: input.agent.name,
    execution: input.execution,
    prompt,
    schemaSha256: resultSchema.sha256,
    source: sourceProvenance(authority),
    session: null,
  });

  let result: AgentRunResult | undefined;
  let thrownError: unknown;
  try {
    result = await input.agent.run({
      workspace: input.workspace,
      prompt,
      schemaPath: IMPLEMENTATION_RESULT_SCHEMA_PATH,
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
    thrownError = error;
  }

  const verified = verifyImplementationSource(input.workspace, authority);
  if (!verified.ok) {
    return failure("source-integrity", verified.error, provenance);
  }

  if (thrownError !== undefined) {
    return failure(
      input.execution.signal?.aborted ? "cancelled" : "provider",
      `Implementation agent failed: ${errorMessage(thrownError)}`,
      provenance,
    );
  }
  if (!result) {
    return failure("provider", "Implementation agent returned no result.", provenance);
  }
  if (!result.ok) {
    return failure(agentFailureKind(result), result.error, provenance);
  }

  const decision = ImplementationDecisionSchema.safeParse(result.structuredOutput);
  if (!decision.success) {
    return failure(
      "invalid-output",
      `Invalid implementation structured output: ${formatZodError(decision.error.issues)}`,
      provenance,
    );
  }

  if (decision.data.outcome === "needs-input") {
    return {
      ok: true,
      decision: decision.data,
      provenance,
    };
  }

  const normalized = normalizeAgentSessionForProvider(input.agent.name, result.session);
  if (!normalized.ok) {
    return failure("invalid-session", normalized.error.error, provenance);
  }
  if (!normalized.session) {
    return failure(
      "invalid-session",
      "Implementation agent did not return a resumable author session.",
      provenance,
    );
  }

  return {
    ok: true,
    decision: decision.data,
    provenance: {
      ...provenance,
      session: {
        provider: normalized.session.provider,
        id: normalized.session.id,
      },
    },
  };
}

function createProvenance(input: {
  provider: AgentProviderName;
  execution: ImplementationExecution;
  prompt: string | null;
  schemaSha256: string | null;
  source: ImplementationSourceProvenance | null;
  session: ImplementationSessionReference | null;
}): ImplementationProvenance {
  return {
    provider: input.provider,
    model: input.execution.model,
    modelReasoningEffort: input.execution.modelReasoningEffort,
    policyVersion: IMPLEMENTATION_POLICY_VERSION,
    resultSchemaVersion: IMPLEMENTATION_RESULT_SCHEMA_VERSION,
    promptSha256: input.prompt === null ? null : sha256(input.prompt),
    schemaSha256: input.schemaSha256,
    source: input.source,
    session: input.session,
  };
}

function sourceProvenance(
  authority: ImplementationSourceAuthority,
): ImplementationSourceProvenance {
  return {
    kind: authority.source.kind,
    issueReference: authority.issueReference,
    path: authority.source.kind === "plan" ? authority.source.path : null,
    sha256: authority.sourceSha256,
  };
}

function inspectResultSchema():
  | Readonly<{ ok: true; sha256: string }>
  | Readonly<{ ok: false; error: string }> {
  try {
    return {
      ok: true,
      sha256: sha256(readFileSync(IMPLEMENTATION_RESULT_SCHEMA_PATH)),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Implementation result schema is unavailable: ${errorMessage(error)}`,
    };
  }
}

function agentFailureKind(
  result: Extract<AgentRunResult, { ok: false }>,
): ImplementationFailureKind {
  if (result.aborted) return "cancelled";
  if (result.exitCode === 124) return "timeout";
  if (result.failureKind === "workspace-guard") return "workspace-guard";
  return "provider";
}

function failure(
  failureKind: ImplementationFailureKind,
  error: string,
  provenance: ImplementationProvenance,
): Extract<ImplementationResult, { ok: false }> {
  return {
    ok: false,
    failureKind,
    error,
    provenance,
  };
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatZodError(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}
