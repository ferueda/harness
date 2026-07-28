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
import { inspectSpecArtifact, specArtifactPath } from "../spec/artifact.ts";
import {
  renderSpecReviewPrompt,
  SPEC_REVIEW_PROMPT_VERSION,
  SPEC_REVIEW_RUBRIC_VERSION,
} from "./prompt.ts";
import {
  SPEC_REVIEW_RESULT_SCHEMA_VERSION,
  SpecReviewArtifactSchema,
  SpecReviewDecisionDraftSchema,
  SpecReviewDecisionSchema,
  SpecReviewFindingSchema,
  SpecReviewWorkItemContextSchema,
  type SpecReviewArtifact,
  type SpecReviewDecision,
  type SpecReviewDecisionDraft,
  type SpecReviewFinding,
  type SpecReviewFindingDraft,
  type SpecReviewWorkItemContext,
} from "./schema.ts";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HARNESS_ROOT = basename(MODULE_ROOT) === "dist" ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;

export const SPEC_REVIEW_RESULT_SCHEMA_PATH = join(
  HARNESS_ROOT,
  "schemas/spec-review-result.schema.json",
);

export type SpecReviewExecution = Readonly<{
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  maxRuntimeMs: number;
  logPath?: string;
  signal?: AbortSignal;
}>;

export type SpecReviewProvenance = Readonly<{
  provider: AgentProviderName;
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  rubricVersion: string;
  promptVersion: string;
  resultSchemaVersion: string;
  promptSha256: string | null;
  schemaSha256: string | null;
  artifactSha256: string | null;
}>;

export type SpecReviewFailureKind =
  | "provider"
  | "timeout"
  | "cancelled"
  | "invalid-output"
  | "invalid-artifact"
  | "workspace-guard"
  | "insufficient-context";

export type SpecReviewResult =
  | Readonly<{
      ok: true;
      artifact: SpecReviewArtifact;
      decision: SpecReviewDecision;
      provenance: SpecReviewProvenance;
    }>
  | Readonly<{
      ok: false;
      failureKind: SpecReviewFailureKind;
      error: string;
      provenance: SpecReviewProvenance;
    }>;

export async function reviewSpec(input: {
  workItem: SpecReviewWorkItemContext;
  artifact: SpecReviewArtifact;
  workspace: string;
  agent: Agent;
  execution: SpecReviewExecution;
}): Promise<SpecReviewResult> {
  const resultSchema = inspectResultSchema();
  const parsedWorkItem = SpecReviewWorkItemContextSchema.safeParse(input.workItem);
  const parsedArtifact = SpecReviewArtifactSchema.safeParse(input.artifact);
  let provenance = createProvenance({
    provider: input.agent.name,
    execution: input.execution,
    prompt: null,
    schemaSha256: resultSchema.ok ? resultSchema.sha256 : null,
    artifactSha256: null,
  });

  if (!resultSchema.ok) {
    return failure("provider", resultSchema.error, provenance);
  }
  if (!parsedWorkItem.success) {
    return failure(
      "insufficient-context",
      `Invalid Spec review work-item context: ${formatZodError(parsedWorkItem.error.issues)}`,
      provenance,
    );
  }
  if (!parsedArtifact.success) {
    return failure(
      "invalid-artifact",
      `Invalid Spec review artifact reference: ${formatZodError(parsedArtifact.error.issues)}`,
      provenance,
    );
  }

  const workItem = parsedWorkItem.data;
  const artifact = parsedArtifact.data;
  const prompt = renderSpecReviewPrompt({ workItem, artifact });
  provenance = { ...provenance, promptSha256: sha256(prompt) };
  if (Object.values(workItem.completeness).some(Boolean)) {
    return failure(
      "insufficient-context",
      "Spec review requires complete work-item comments, labels, relations, links, and children.",
      provenance,
    );
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
  provenance = { ...provenance, artifactSha256: before.snapshot.sha256 };

  let result: AgentRunResult | undefined;
  let thrownError: unknown;
  try {
    result = await input.agent.run({
      workspace: input.workspace,
      prompt,
      schemaPath: SPEC_REVIEW_RESULT_SCHEMA_PATH,
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
    thrownError = error;
  }

  const after = inspectSpecArtifact({
    workspace: input.workspace,
    expectedPath,
    claimedPath: artifact.path,
  });
  if (!after.ok || after.snapshot.sha256 !== before.snapshot.sha256) {
    const detail = after.ok ? "its content changed." : after.error;
    return failure(
      "workspace-guard",
      `Spec reviewer mutated or invalidated ${artifact.path}: ${detail}`,
      provenance,
    );
  }

  if (thrownError !== undefined) {
    return failure(
      input.execution.signal?.aborted ? "cancelled" : "provider",
      `Spec review agent failed: ${errorMessage(thrownError)}`,
      provenance,
    );
  }
  if (!result) {
    return failure("provider", "Spec review agent returned no result.", provenance);
  }
  if (!result.ok) {
    return failure(failureKind(result), result.error, provenance);
  }

  const draft = SpecReviewDecisionDraftSchema.safeParse(result.structuredOutput);
  if (!draft.success) {
    return failure(
      "invalid-output",
      `Invalid Spec review structured output: ${formatZodError(draft.error.issues)}`,
      provenance,
    );
  }

  if (draft.data.outcome === "insufficient-context") {
    return failure(
      "insufficient-context",
      `Spec reviewer lacks required context: ${draft.data.rationale}`,
      provenance,
    );
  }

  const citationError = validateArtifactCitations(draft.data, artifact.path);
  if (citationError) {
    return failure("invalid-output", citationError, provenance);
  }

  let decision: SpecReviewDecision;
  if (draft.data.outcome === "approved") {
    decision = SpecReviewDecisionSchema.parse({
      outcome: "approved",
      rationale: draft.data.rationale,
      evidence: draft.data.evidence,
      findings: [],
    });
  } else {
    const findings = addTrustedFindingIds(draft.data.findings, artifact);
    if (!findings.ok) {
      return failure("invalid-output", findings.error, provenance);
    }
    decision = SpecReviewDecisionSchema.parse({
      outcome: "changes-requested",
      rationale: draft.data.rationale,
      findings: findings.value,
    });
  }

  return {
    ok: true,
    artifact,
    decision,
    provenance,
  };
}

function createProvenance(input: {
  provider: AgentProviderName;
  execution: SpecReviewExecution;
  prompt: string | null;
  schemaSha256: string | null;
  artifactSha256: string | null;
}): SpecReviewProvenance {
  return {
    provider: input.provider,
    model: input.execution.model,
    modelReasoningEffort: input.execution.modelReasoningEffort,
    rubricVersion: SPEC_REVIEW_RUBRIC_VERSION,
    promptVersion: SPEC_REVIEW_PROMPT_VERSION,
    resultSchemaVersion: SPEC_REVIEW_RESULT_SCHEMA_VERSION,
    promptSha256: input.prompt === null ? null : sha256(input.prompt),
    schemaSha256: input.schemaSha256,
    artifactSha256: input.artifactSha256,
  };
}

function inspectResultSchema():
  | Readonly<{ ok: true; sha256: string }>
  | Readonly<{ ok: false; error: string }> {
  try {
    return {
      ok: true,
      sha256: sha256(readFileSync(SPEC_REVIEW_RESULT_SCHEMA_PATH)),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Spec review result schema is unavailable: ${errorMessage(error)}`,
    };
  }
}

function validateArtifactCitations(
  decision: SpecReviewDecisionDraft,
  artifactPath: string,
): string | null {
  const citations =
    decision.outcome === "approved"
      ? decision.evidence
      : decision.findings.flatMap((finding) => finding.evidence);

  for (const citation of citations) {
    if (citation.source === "artifact" && citation.path !== artifactPath) {
      return `Invalid Spec review artifact citation: expected ${artifactPath}, received ${String(citation.path)}.`;
    }
  }
  return null;
}

function addTrustedFindingIds(
  drafts: readonly SpecReviewFindingDraft[],
  artifact: SpecReviewArtifact,
): Readonly<{ ok: true; value: SpecReviewFinding[] }> | Readonly<{ ok: false; error: string }> {
  const canonicalFindings = new Set<string>();
  const findingIds = new Set<string>();
  const findings: SpecReviewFinding[] = [];

  for (const draft of drafts) {
    const canonical = canonicalFinding(draft);
    if (canonicalFindings.has(canonical)) {
      return { ok: false, error: "Invalid Spec review output: duplicate canonical finding." };
    }
    canonicalFindings.add(canonical);

    const id = `spec-review-finding-${sha256(
      JSON.stringify({
        artifact,
        rubricVersion: SPEC_REVIEW_RUBRIC_VERSION,
        finding: JSON.parse(canonical) as unknown,
      }),
    )}`;
    if (findingIds.has(id)) {
      return { ok: false, error: `Invalid Spec review output: duplicate finding ID ${id}.` };
    }
    findingIds.add(id);
    findings.push(SpecReviewFindingSchema.parse({ ...draft, id }));
  }

  return { ok: true, value: findings };
}

function canonicalFinding(finding: SpecReviewFindingDraft): string {
  const evidence = finding.evidence
    .map((citation) => ({
      source: citation.source,
      path: citation.path,
      lineStart: citation.lineStart,
      lineEnd: citation.lineEnd,
      summary: citation.summary,
    }))
    // Finding identity must not depend on process locale or provider citation order.
    .toSorted((left, right) => compareCanonicalJson(left, right));

  // Explicit field order makes identity independent of object construction order.
  return JSON.stringify({
    criterion: finding.criterion,
    artifactLocation: {
      section: finding.artifactLocation.section,
      lineStart: finding.artifactLocation.lineStart,
      lineEnd: finding.artifactLocation.lineEnd,
    },
    evidence,
    problem: finding.problem,
    requiredOutcome: finding.requiredOutcome,
  });
}

function compareCanonicalJson(left: object, right: object): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  if (leftJson < rightJson) return -1;
  if (leftJson > rightJson) return 1;
  return 0;
}

function failureKind(result: Extract<AgentRunResult, { ok: false }>): SpecReviewFailureKind {
  if (result.aborted) return "cancelled";
  if (result.exitCode === 124) return "timeout";
  if (result.failureKind === "workspace-guard") return "workspace-guard";
  return "provider";
}

function failure(
  failureKind: SpecReviewFailureKind,
  error: string,
  provenance: SpecReviewProvenance,
): SpecReviewResult {
  return { ok: false, failureKind, error, provenance };
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatZodError(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}
