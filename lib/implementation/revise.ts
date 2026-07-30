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
import {
  createImplementationReviewFindingId,
  canonicalImplementationReviewFinding,
} from "./finding-identity.ts";
import {
  renderImplementationRevisionPrompt,
  IMPLEMENTATION_REVISION_POLICY_VERSION,
} from "./revise-prompt.ts";
import {
  IMPLEMENTATION_REVISION_RESULT_SCHEMA_VERSION,
  ImplementationRevisionAuthorSessionSchema,
  ImplementationRevisionDecisionSchema,
  ImplementationRevisionReviewSchema,
  type ImplementationRevisionAuthorSession,
  type ImplementationRevisionDecision,
  type ImplementationRevisionEvidence,
  type ImplementationRevisionReview,
} from "./revise-schema.ts";
import {
  inspectImplementationSource,
  verifyImplementationSource,
  type ImplementationSource,
  type ImplementationSourceAuthority,
} from "./source.ts";
import type { ImplementationSourceProvenance } from "./implementation.ts";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HARNESS_ROOT = basename(MODULE_ROOT) === "dist" ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;

export const IMPLEMENTATION_REVISION_RESULT_SCHEMA_PATH = join(
  HARNESS_ROOT,
  "schemas/implementation-revision-result.schema.json",
);

export type ImplementationRevisionExecution = Readonly<{
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  maxRuntimeMs: number;
  logPath?: string;
  signal?: AbortSignal;
}>;

export type ImplementationRevisionProvenance = Readonly<{
  provider: AgentProviderName;
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  policyVersion: string;
  resultSchemaVersion: string;
  reviewedRevision: string | null;
  promptSha256: string | null;
  schemaSha256: string | null;
  source: ImplementationSourceProvenance | null;
}>;

export type ImplementationRevisionFailureKind =
  | "provider"
  | "timeout"
  | "cancelled"
  | "invalid-output"
  | "invalid-session"
  | "invalid-review"
  | "invalid-source"
  | "source-integrity"
  | "workspace-guard";

export type ImplementationRevisionResult =
  | Readonly<{
      ok: true;
      decision: ImplementationRevisionDecision;
      authorSession: ImplementationRevisionAuthorSession;
      provenance: ImplementationRevisionProvenance;
    }>
  | Readonly<{
      ok: false;
      failureKind: ImplementationRevisionFailureKind;
      error: string;
      provenance: ImplementationRevisionProvenance;
    }>;

export async function reviseImplementation(input: {
  source: ImplementationSource;
  review: ImplementationRevisionReview;
  authorSession: ImplementationRevisionAuthorSession;
  workspace: string;
  agent: Agent;
  execution: ImplementationRevisionExecution;
}): Promise<ImplementationRevisionResult> {
  const resultSchema = inspectResultSchema();
  const parsedReview = ImplementationRevisionReviewSchema.safeParse(input.review);
  const parsedSession = ImplementationRevisionAuthorSessionSchema.safeParse(input.authorSession);
  let provenance = createProvenance({
    provider: input.agent.name,
    execution: input.execution,
    reviewedRevision: parsedReview.success ? parsedReview.data.reviewedRevision : null,
    prompt: null,
    schemaSha256: resultSchema.ok ? resultSchema.sha256 : null,
    source: null,
  });

  if (!resultSchema.ok) return failure("provider", resultSchema.error, provenance);
  if (!parsedReview.success) {
    return failure(
      "invalid-review",
      `Invalid implementation revision review: ${formatZodError(parsedReview.error.issues)}`,
      provenance,
    );
  }
  if (!parsedSession.success) {
    return failure(
      "invalid-session",
      `Invalid implementation author session: ${formatZodError(parsedSession.error.issues)}`,
      provenance,
    );
  }

  const identityError = validateFindingIdentities(parsedReview.data);
  if (identityError) return failure("invalid-review", identityError, provenance);

  const normalizedInputSession = normalizeAgentSessionForProvider(input.agent.name, {
    provider: parsedSession.data.provider,
    id: parsedSession.data.id,
  });
  if (!normalizedInputSession.ok || !normalizedInputSession.session) {
    const detail = normalizedInputSession.ok
      ? "Implementation author session is missing."
      : normalizedInputSession.error.error;
    return failure("invalid-session", detail, provenance);
  }

  const inspected = inspectImplementationSource({
    workspace: input.workspace,
    source: input.source,
  });
  if (!inspected.ok) return failure("invalid-source", inspected.error, provenance);
  const authority = inspected.value;
  const prompt = renderImplementationRevisionPrompt({
    authority,
    review: parsedReview.data,
  });
  provenance = createProvenance({
    provider: input.agent.name,
    execution: input.execution,
    reviewedRevision: parsedReview.data.reviewedRevision,
    prompt,
    schemaSha256: resultSchema.sha256,
    source: sourceProvenance(authority),
  });

  let result: AgentRunResult | undefined;
  let thrownError: unknown;
  try {
    result = await input.agent.run({
      workspace: input.workspace,
      prompt,
      schemaPath: IMPLEMENTATION_REVISION_RESULT_SCHEMA_PATH,
      model: input.execution.model,
      modelReasoningEffort: input.execution.modelReasoningEffort,
      session: normalizedInputSession.session,
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
  if (!verified.ok) return failure("source-integrity", verified.error, provenance);

  if (thrownError !== undefined) {
    return failure(
      input.execution.signal?.aborted ? "cancelled" : "provider",
      `Implementation revision agent failed: ${errorMessage(thrownError)}`,
      provenance,
    );
  }
  if (!result) {
    return failure("provider", "Implementation revision agent returned no result.", provenance);
  }
  if (!result.ok) return failure(agentFailureKind(result), result.error, provenance);

  const returnedSession = normalizeAgentSessionForProvider(input.agent.name, result.session);
  if (!returnedSession.ok || !returnedSession.session) {
    const detail = returnedSession.ok
      ? "Implementation revision agent returned no continuation session."
      : returnedSession.error.error;
    return failure("invalid-session", detail, provenance);
  }
  const authorSession = ImplementationRevisionAuthorSessionSchema.safeParse({
    version: 1,
    provider: returnedSession.session.provider,
    id: returnedSession.session.id,
  });
  if (!authorSession.success) {
    return failure(
      "invalid-session",
      `Invalid returned implementation author session: ${formatZodError(authorSession.error.issues)}`,
      provenance,
    );
  }

  const decision = ImplementationRevisionDecisionSchema.safeParse(result.structuredOutput);
  if (!decision.success) {
    return failure(
      "invalid-output",
      `Invalid implementation revision structured output: ${formatZodError(decision.error.issues)}`,
      provenance,
    );
  }
  const responseError = validateFindingResponses(decision.data, parsedReview.data);
  if (responseError) return failure("invalid-output", responseError, provenance);
  const evidenceError = validateSelectedSourceEvidence(decision.data, authority);
  if (evidenceError) return failure("invalid-output", evidenceError, provenance);

  // Repository inspection and checkpoint acceptance remain caller-owned.
  return {
    ok: true,
    decision: decision.data,
    authorSession: authorSession.data,
    provenance,
  };
}

function validateFindingIdentities(review: ImplementationRevisionReview): string | null {
  for (const finding of review.findings) {
    const expectedId = createImplementationReviewFindingId({
      reviewedRevision: review.reviewedRevision,
      reviewer: finding.reviewer,
      finding: canonicalImplementationReviewFinding(finding),
    });
    if (finding.id !== expectedId) {
      return `Invalid implementation revision review: finding ${compactFindingId(finding.id)} is not bound to the reviewed revision, reviewer, and content.`;
    }
  }
  return null;
}

function validateFindingResponses(
  decision: ImplementationRevisionDecision,
  review: ImplementationRevisionReview,
): string | null {
  const expectedIds = review.findings.map((finding) => finding.id);
  const responseIds = decision.responses.map((response) => response.findingId);
  const uniqueResponseIds = new Set(responseIds);
  if (uniqueResponseIds.size !== responseIds.length) {
    return "Invalid implementation revision output: duplicate finding responses.";
  }

  const expected = new Set(expectedIds);
  const unknown = responseIds.filter((id) => !expected.has(id));
  const missing = expectedIds.filter((id) => !uniqueResponseIds.has(id));
  if (unknown.length > 0 || missing.length > 0) {
    return `Invalid implementation revision output: finding response set mismatch (unknown: ${formatFindingIds(unknown)}; missing: ${formatFindingIds(missing)}).`;
  }
  return null;
}

function validateSelectedSourceEvidence(
  decision: ImplementationRevisionDecision,
  authority: ImplementationSourceAuthority,
): string | null {
  const expectedPath = authority.source.kind === "plan" ? authority.source.path : null;
  const evidence: readonly ImplementationRevisionEvidence[] = decision.responses.flatMap(
    (response) => response.evidence,
  );
  for (const item of evidence) {
    if (item.source === "selected-source" && item.path !== expectedPath) {
      return `Invalid implementation revision source evidence: expected ${String(expectedPath)}, received ${String(item.path)}.`;
    }
  }
  return null;
}

function createProvenance(input: {
  provider: AgentProviderName;
  execution: ImplementationRevisionExecution;
  reviewedRevision: string | null;
  prompt: string | null;
  schemaSha256: string | null;
  source: ImplementationSourceProvenance | null;
}): ImplementationRevisionProvenance {
  return {
    provider: input.provider,
    model: input.execution.model,
    modelReasoningEffort: input.execution.modelReasoningEffort,
    policyVersion: IMPLEMENTATION_REVISION_POLICY_VERSION,
    resultSchemaVersion: IMPLEMENTATION_REVISION_RESULT_SCHEMA_VERSION,
    reviewedRevision: input.reviewedRevision,
    promptSha256: input.prompt === null ? null : sha256(input.prompt),
    schemaSha256: input.schemaSha256,
    source: input.source,
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
      sha256: sha256(readFileSync(IMPLEMENTATION_REVISION_RESULT_SCHEMA_PATH)),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Implementation revision result schema is unavailable: ${errorMessage(error)}`,
    };
  }
}

function agentFailureKind(
  result: Extract<AgentRunResult, { ok: false }>,
): ImplementationRevisionFailureKind {
  if (result.aborted) return "cancelled";
  if (result.exitCode === 124) return "timeout";
  if (result.failureKind === "workspace-guard") return "workspace-guard";
  return "provider";
}

function failure(
  failureKind: ImplementationRevisionFailureKind,
  error: string,
  provenance: ImplementationRevisionProvenance,
): Extract<ImplementationRevisionResult, { ok: false }> {
  return { ok: false, failureKind, error, provenance };
}

function formatFindingIds(ids: readonly string[]): string {
  if (ids.length === 0) return "0";
  return `${ids.length} [${ids.map(compactFindingId).join(", ")}]`;
}

function compactFindingId(id: string): string {
  const prefixLength = "implementation-review-finding-".length;
  return id.slice(prefixLength, prefixLength + 8);
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatZodError(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}
