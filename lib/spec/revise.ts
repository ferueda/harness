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
import { createSpecReviewFindingId } from "../spec-review/finding-identity.ts";
import {
  SpecReviewArtifactSchema,
  type SpecReviewArtifact,
  type SpecReviewCitation,
} from "../spec-review/schema.ts";
import { inspectSpecArtifact, specArtifactPath } from "./artifact.ts";
import { renderSpecRevisionPrompt, SPEC_REVISION_POLICY_VERSION } from "./revise-prompt.ts";
import {
  SPEC_REVISION_RESULT_SCHEMA_VERSION,
  SpecRevisionAuthorSessionSchema,
  SpecRevisionDecisionDraftSchema,
  SpecRevisionReviewSchema,
  type SpecRevisionAuthorSession,
  type SpecRevisionDecision,
  type SpecRevisionReview,
} from "./revise-schema.ts";
import { SpecWorkItemContextSchema, type SpecWorkItemContext } from "./schema.ts";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HARNESS_ROOT = basename(MODULE_ROOT) === "dist" ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;

export const SPEC_REVISION_RESULT_SCHEMA_PATH = join(
  HARNESS_ROOT,
  "schemas/spec-revision-result.schema.json",
);

export type SpecRevisionExecution = Readonly<{
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  maxRuntimeMs: number;
  logPath?: string;
  signal?: AbortSignal;
}>;

export type SpecRevisionProvenance = Readonly<{
  provider: AgentProviderName;
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  policyVersion: string;
  resultSchemaVersion: string;
  reviewRubricVersion: string | null;
  promptSha256: string | null;
  schemaSha256: string | null;
  artifactBeforeSha256: string | null;
  artifactAfterSha256: string | null;
}>;

export type SpecRevisionFailureKind =
  | "provider"
  | "timeout"
  | "cancelled"
  | "invalid-output"
  | "invalid-artifact"
  | "invalid-session"
  | "invalid-review"
  | "stale-review"
  | "workspace-guard"
  | "insufficient-context";

export type SpecRevisionResult =
  | Readonly<{
      ok: true;
      artifact: SpecReviewArtifact;
      decision: SpecRevisionDecision;
      authorSession: SpecRevisionAuthorSession;
      provenance: SpecRevisionProvenance;
    }>
  | Readonly<{
      ok: false;
      failureKind: SpecRevisionFailureKind;
      error: string;
      provenance: SpecRevisionProvenance;
    }>;

export async function reviseSpec(input: {
  workItem: SpecWorkItemContext;
  artifact: SpecReviewArtifact;
  review: SpecRevisionReview;
  authorSession: SpecRevisionAuthorSession;
  workspace: string;
  agent: Agent;
  execution: SpecRevisionExecution;
}): Promise<SpecRevisionResult> {
  const resultSchema = inspectResultSchema();
  const parsedWorkItem = SpecWorkItemContextSchema.safeParse(input.workItem);
  const parsedArtifact = SpecReviewArtifactSchema.safeParse(input.artifact);
  const parsedReview = SpecRevisionReviewSchema.safeParse(input.review);
  const parsedSession = SpecRevisionAuthorSessionSchema.safeParse(input.authorSession);
  let provenance = createProvenance({
    provider: input.agent.name,
    execution: input.execution,
    schemaSha256: resultSchema.ok ? resultSchema.sha256 : null,
  });

  if (!resultSchema.ok) {
    return failure("provider", resultSchema.error, provenance);
  }
  if (!parsedWorkItem.success) {
    return failure(
      "insufficient-context",
      `Invalid Spec revision work-item context: ${formatZodError(parsedWorkItem.error.issues)}`,
      provenance,
    );
  }
  if (!parsedArtifact.success) {
    return failure(
      "invalid-artifact",
      `Invalid Spec revision artifact reference: ${formatZodError(parsedArtifact.error.issues)}`,
      provenance,
    );
  }
  if (!parsedReview.success) {
    return failure(
      "invalid-review",
      `Invalid Spec revision review: ${formatZodError(parsedReview.error.issues)}`,
      provenance,
    );
  }
  if (!parsedSession.success) {
    return failure(
      "invalid-session",
      `Invalid Spec author session: ${formatZodError(parsedSession.error.issues)}`,
      provenance,
    );
  }

  const workItem = parsedWorkItem.data;
  const artifact = parsedArtifact.data;
  const review = parsedReview.data;
  provenance = { ...provenance, reviewRubricVersion: review.rubricVersion };

  if (Object.values(workItem.completeness).some(Boolean)) {
    return failure(
      "insufficient-context",
      "Spec revision requires complete work-item comments, labels, relations, links, and children.",
      provenance,
    );
  }
  if (artifact.revision !== review.reviewedRevision) {
    return failure(
      "stale-review",
      `Spec review targets ${review.reviewedRevision}, but the supplied artifact is ${artifact.revision}.`,
      provenance,
    );
  }
  const normalizedInputSession = normalizeAgentSessionForProvider(input.agent.name, {
    provider: parsedSession.data.provider,
    id: parsedSession.data.id,
  });
  if (!normalizedInputSession.ok || !normalizedInputSession.session) {
    const detail = normalizedInputSession.ok
      ? "Spec author session is missing."
      : normalizedInputSession.error.error;
    return failure("invalid-session", detail, provenance);
  }

  const expectedPath = specArtifactPath(workItem.reference);
  const before = inspectSpecArtifact({
    workspace: input.workspace,
    expectedPath,
    claimedPath: artifact.path,
  });
  if (!before.ok) {
    return failure("invalid-artifact", before.error, provenance);
  }
  provenance = { ...provenance, artifactBeforeSha256: before.snapshot.sha256 };

  const findingIdentityError = validateFindingIdentities(artifact, review);
  if (findingIdentityError) {
    return failure("invalid-review", findingIdentityError, provenance);
  }

  const prompt = renderSpecRevisionPrompt({ workItem, artifact, review });
  provenance = { ...provenance, promptSha256: sha256(prompt) };

  let result: AgentRunResult | undefined;
  let thrownError: unknown;
  try {
    result = await input.agent.run({
      workspace: input.workspace,
      prompt,
      schemaPath: SPEC_REVISION_RESULT_SCHEMA_PATH,
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

  const after = inspectSpecArtifact({
    workspace: input.workspace,
    expectedPath,
    claimedPath: artifact.path,
  });
  if (!after.ok) {
    return failure("invalid-artifact", after.error, provenance);
  }
  provenance = { ...provenance, artifactAfterSha256: after.snapshot.sha256 };

  if (thrownError !== undefined) {
    return failure(
      input.execution.signal?.aborted ? "cancelled" : "provider",
      `Spec revision agent failed: ${errorMessage(thrownError)}`,
      provenance,
    );
  }
  if (!result) {
    return failure("provider", "Spec revision agent returned no result.", provenance);
  }
  if (!result.ok) {
    return failure(failureKind(result), result.error, provenance);
  }

  const returnedSession = normalizeAgentSessionForProvider(input.agent.name, result.session);
  if (!returnedSession.ok || !returnedSession.session) {
    const detail = returnedSession.ok
      ? "Spec revision agent returned no continuation session."
      : returnedSession.error.error;
    return failure("invalid-session", detail, provenance);
  }
  const parsedReturnedSession = SpecRevisionAuthorSessionSchema.safeParse({
    version: 1,
    provider: returnedSession.session.provider,
    id: returnedSession.session.id,
  });
  if (!parsedReturnedSession.success) {
    return failure(
      "invalid-session",
      `Invalid returned Spec author session: ${formatZodError(parsedReturnedSession.error.issues)}`,
      provenance,
    );
  }

  const decision = SpecRevisionDecisionDraftSchema.safeParse(result.structuredOutput);
  if (!decision.success) {
    return failure(
      "invalid-output",
      `Invalid Spec revision structured output: ${formatZodError(decision.error.issues)}`,
      provenance,
    );
  }

  const responseError = validateFindingResponses(decision.data, review);
  if (responseError) {
    return failure("invalid-output", responseError, provenance);
  }
  const citationError = validateArtifactCitations(decision.data, artifact.path);
  if (citationError) {
    return failure("invalid-output", citationError, provenance);
  }
  const artifactError = validateArtifactEffect(
    decision.data,
    before.snapshot.sha256,
    after.snapshot.sha256,
  );
  if (artifactError) {
    return failure("invalid-artifact", artifactError, provenance);
  }

  // The caller still validates the complete repository change set before checkpointing.
  return {
    ok: true,
    artifact,
    decision: decision.data,
    authorSession: parsedReturnedSession.data,
    provenance,
  };
}

function validateFindingIdentities(
  artifact: SpecReviewArtifact,
  review: SpecRevisionReview,
): string | null {
  for (const finding of review.findings) {
    const expectedId = createSpecReviewFindingId({
      artifact,
      rubricVersion: review.rubricVersion,
      finding,
    });
    if (finding.id !== expectedId) {
      return `Invalid Spec revision review: finding ${finding.id} is not bound to the supplied artifact, rubric, and content.`;
    }
  }
  return null;
}

function validateFindingResponses(
  decision: SpecRevisionDecision,
  review: SpecRevisionReview,
): string | null {
  const expectedIds = review.findings.map((finding) => finding.id);
  const responseIds = decision.responses.map((response) => response.findingId);
  const uniqueResponseIds = new Set(responseIds);
  if (uniqueResponseIds.size !== responseIds.length) {
    return "Invalid Spec revision output: duplicate finding responses.";
  }

  const expected = new Set(expectedIds);
  const unknown = responseIds.filter((id) => !expected.has(id));
  const missing = expectedIds.filter((id) => !uniqueResponseIds.has(id));
  if (unknown.length > 0 || missing.length > 0) {
    return `Invalid Spec revision output: finding response set mismatch (unknown: ${formatFindingIds(unknown)}; missing: ${formatFindingIds(missing)}).`;
  }
  return null;
}

function formatFindingIds(ids: readonly string[]): string {
  if (ids.length === 0) return "0";
  const prefixLength = "spec-review-finding-".length;
  const compactIds = ids.map((id) => id.slice(prefixLength, prefixLength + 8));
  return `${ids.length} [${compactIds.join(", ")}]`;
}

function validateArtifactCitations(
  decision: SpecRevisionDecision,
  artifactPath: string,
): string | null {
  const citations: readonly SpecReviewCitation[] = decision.responses.flatMap(
    (response) => response.evidence,
  );
  for (const citation of citations) {
    if (citation.source === "artifact" && citation.path !== artifactPath) {
      return `Invalid Spec revision artifact citation: expected ${artifactPath}, received ${String(citation.path)}.`;
    }
  }
  return null;
}

function validateArtifactEffect(
  decision: SpecRevisionDecision,
  beforeSha256: string,
  afterSha256: string,
): string | null {
  const changed = beforeSha256 !== afterSha256;
  if (decision.outcome === "updated" && !changed) {
    return "Invalid Spec revision artifact effect: updated requires changed artifact content.";
  }
  if (decision.outcome !== "updated" && changed) {
    return `Invalid Spec revision artifact effect: ${decision.outcome} requires unchanged artifact content.`;
  }
  return null;
}

function createProvenance(input: {
  provider: AgentProviderName;
  execution: SpecRevisionExecution;
  schemaSha256: string | null;
}): SpecRevisionProvenance {
  return {
    provider: input.provider,
    model: input.execution.model,
    modelReasoningEffort: input.execution.modelReasoningEffort,
    policyVersion: SPEC_REVISION_POLICY_VERSION,
    resultSchemaVersion: SPEC_REVISION_RESULT_SCHEMA_VERSION,
    reviewRubricVersion: null,
    promptSha256: null,
    schemaSha256: input.schemaSha256,
    artifactBeforeSha256: null,
    artifactAfterSha256: null,
  };
}

function inspectResultSchema():
  | Readonly<{ ok: true; sha256: string }>
  | Readonly<{ ok: false; error: string }> {
  try {
    return {
      ok: true,
      sha256: sha256(readFileSync(SPEC_REVISION_RESULT_SCHEMA_PATH)),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Spec revision result schema is unavailable: ${errorMessage(error)}`,
    };
  }
}

function failureKind(result: Extract<AgentRunResult, { ok: false }>): SpecRevisionFailureKind {
  if (result.aborted) return "cancelled";
  if (result.exitCode === 124) return "timeout";
  if (result.failureKind === "workspace-guard") return "workspace-guard";
  return "provider";
}

function failure(
  failureKind: SpecRevisionFailureKind,
  error: string,
  provenance: SpecRevisionProvenance,
): SpecRevisionResult {
  return { ok: false, failureKind, error, provenance };
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatZodError(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}
