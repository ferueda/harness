import type { AgentSessionRef } from "../agents.ts";
import type { FactoryStationAgentMeta } from "../factory-agent-meta.ts";
import type { FactoryImplementationInput } from "../factory-implementation-input.ts";

export type FactoryImplementationPromptInput = {
  implementationInput: FactoryImplementationInput;
  implementerAgent: FactoryStationAgentMeta;
  linearApplyRequested?: boolean;
};

export type FactoryImplementationHandoffInput =
  | {
      mode: "dry-run";
      implementationInput: FactoryImplementationInput;
      implementerAgent: FactoryStationAgentMeta;
    }
  | {
      mode: "live";
      status: "implementation-complete" | "implementation-failed";
      implementationInput: FactoryImplementationInput;
      implementerAgent: FactoryStationAgentMeta;
      artifacts: {
        diff: string;
        rawOutput: string;
        workspaceStatus: string;
        changeReviewHandoff: string;
        streamLog?: string;
      };
      changedFiles: string[];
      provider: {
        session?: AgentSessionRef;
        error?: string;
      };
      review?: {
        reviewBase: string;
        reviewHead: string;
        reviewCommitSha: string;
      };
      warnings: {
        dirtyBefore: boolean;
        emptyPatchWithStatusChange: boolean;
        patchTruncated: boolean;
      };
    };

export function renderFactoryImplementationPrompt(input: FactoryImplementationPromptInput): string {
  const details =
    input.implementationInput.mode === "planned"
      ? renderPlannedPromptDetails(input.implementationInput)
      : renderDirectPromptDetails(input.implementationInput);

  return [
    "# Factory Implementation",
    "",
    `Mode: ${input.implementationInput.mode}`,
    "",
    "## Implementer Role",
    "",
    renderAgent(input.implementerAgent),
    "",
    details,
    "",
    renderExecutionAlignment(input.implementationInput),
    "",
    "## Station Boundaries",
    "",
    input.linearApplyRequested
      ? "- The implementer must not mutate the tracker; the Harness command owns requested start and terminal Linear projection."
      : "- This station does not own tracker mutation.",
    "- This station does not own PR creation.",
    "- This station does not own branch or worktree orchestration.",
    "- This station does not own change-review execution.",
    "- The implementer agent must not run git commit, branch, checkout, push, update-ref, or other ref-mutating git commands. The harness command owns the internal review ref after the provider returns.",
    "- The implementer agent must not append or mutate lifecycle state; the harness command owns lifecycle writes before/after provider invocation.",
    "",
  ].join("\n");
}

function renderExecutionAlignment(input: FactoryImplementationInput): string {
  const taskAuthority =
    input.mode === "planned"
      ? "2. The approved plan at the absolute plan path."
      : "2. The resolved source request under Direct Implementation.";

  return [
    "## Execution Alignment",
    "",
    "Implementation authority, in order:",
    "1. Repository invariants and documented project intent.",
    taskAuthority,
    "3. Verified current repository facts as the implementation baseline.",
    "Historical branches and superseded implementations are context only.",
    "Before editing, reconcile any named post-change ownership, removals, cutover order, and required compatibility.",
    "Success means the accepted outcome is complete, relevant non-destructive repository validation has run, unavailable validation is reported, and the final diff is reconciled against the accepted decisions.",
    "If a material conflict invalidates the approach or completion requires material scope expansion, stop and report the conflict or exact decision needed.",
  ].join("\n");
}

export function renderFactoryImplementationChangeReviewHandoff(
  input: FactoryImplementationHandoffInput,
): string {
  const statusLine =
    input.mode === "dry-run"
      ? "**Status:** in_progress"
      : input.status === "implementation-complete"
        ? undefined
        : "**Status:** blocked";

  const implementationInput = input.implementationInput;
  const modeNotes =
    implementationInput.mode === "planned"
      ? [
          "- Mode: planned",
          `- Approved plan: \`${implementationInput.planPath}\``,
          `- Approved plan commit: \`${implementationInput.approvedPlanCommit}\``,
        ]
      : [
          "- Mode: direct",
          `- Source title: ${implementationInput.sourceMaterial.title}`,
          ...(implementationInput.sourceMaterial.url
            ? [`- Source URL: ${implementationInput.sourceMaterial.url}`]
            : []),
          ...(implementationInput.sourceMaterial.body
            ? [`- Task context: ${excerpt(implementationInput.sourceMaterial.body)}`]
            : []),
        ];

  const statusLines = statusLine ? [statusLine, ""] : [];

  if (input.mode === "dry-run") {
    return [
      "## Review Handoff",
      "",
      ...statusLines,
      "### Goal",
      "",
      `Implement ${implementationInput.workItem.id}: ${implementationInput.workItem.title}.`,
      "",
      "### Decisions and boundaries",
      "",
      ...modeNotes,
      "- Stay within the factory implementation input boundaries.",
      "",
      "### Verification",
      "",
      "Not run yet.",
      "",
      "### Scrutiny",
      "",
      "- Verify the implementation follows the resolved factory implementation input.",
      "- Verify no unrelated tracker, lifecycle, branch, worktree, or PR automation was added.",
      "",
    ].join("\n");
  }

  const warnings: string[] = [];
  if (input.warnings.dirtyBefore) {
    warnings.push(
      "- Pre-run porcelain status was non-empty; live v1 fails closed before provider invocation when the workspace is dirty.",
    );
  }
  if (input.warnings.emptyPatchWithStatusChange) {
    warnings.push(
      "- `implementation/diff.patch` is empty while porcelain status changed; inspect `workspace-status.json` for the status-derived file list.",
    );
  }
  if (input.warnings.patchTruncated) {
    warnings.push(
      "- Best-effort workspace patch capture truncated untracked expansion under the v1 file/byte cap; inspect `workspace-status.json` for truncation details. On completed runs, the review-ref diff remains authoritative.",
    );
  }

  const reviewNotes = input.review
    ? [
        `- Review base: \`${input.review.reviewBase}\``,
        `- Review head: \`${input.review.reviewHead}\``,
        `- Review commit: \`${input.review.reviewCommitSha}\``,
        `- Next operator step: \`harness run change-review --base ${input.review.reviewBase} --head ${input.review.reviewHead} --handoff-stdin --verbose\` with this handoff.`,
      ]
    : ["- Review ref: not created."];

  const providerFailure = input.provider.error ? [`- Provider error: ${input.provider.error}`] : [];

  return [
    "## Review Handoff",
    "",
    ...statusLines,
    "### Goal",
    "",
    `Implement ${implementationInput.workItem.id}: ${implementationInput.workItem.title}.`,
    "",
    "### Decisions and boundaries",
    "",
    ...modeNotes,
    "- Stay within the factory implementation input boundaries.",
    "",
    ...reviewNotes,
    "- This handoff does not claim approval, PR readiness, or merge readiness.",
    "",
    "### Verification",
    "",
    "Not run by factory implementation station.",
    "",
    "### Scrutiny",
    "",
    "- Verify the implementation follows the resolved factory implementation input.",
    "- Verify no unrelated tracker, lifecycle, branch, worktree, or PR automation was added.",
    "- Verify the internal review ref matches the candidate changes before running change-review.",
    ...providerFailure,
    ...warnings,
    ...(input.status === "implementation-complete"
      ? []
      : ["- Resolve the implementation failure, then retry from preserved plan/direct context."]),
    "",
  ].join("\n");
}

function renderPlannedPromptDetails(
  input: Extract<FactoryImplementationInput, { mode: "planned" }>,
): string {
  return [
    "## Planned Implementation",
    "",
    `- Work item: ${input.workItem.id} - ${input.workItem.title}`,
    `- Approved plan path: \`${input.approvedPlanPath}\``,
    `- Absolute plan path: \`${input.planPath}\``,
    `- Approved plan commit: \`${input.approvedPlanCommit}\``,
    "",
    "Follow the approved plan at the absolute plan path. The approved plan commit is a",
    "provenance/readiness marker in this v1 shell; this station has not checked out or",
    "verified that Git object.",
  ].join("\n");
}

function renderDirectPromptDetails(
  input: Extract<FactoryImplementationInput, { mode: "direct" }>,
): string {
  return [
    "## Direct Implementation",
    "",
    "Implement only the direct scoped request from the source material.",
    "",
    `- Title: ${input.sourceMaterial.title}`,
    ...(input.sourceMaterial.url ? [`- URL: ${input.sourceMaterial.url}`] : []),
    `- Labels: ${renderLabels(input.sourceMaterial.labels)}`,
    "",
    "### Body",
    "",
    input.sourceMaterial.body || "(empty)",
    "",
    "### Tracker",
    "",
    input.sourceMaterial.tracker ? JSON.stringify(input.sourceMaterial.tracker, null, 2) : "(none)",
  ].join("\n");
}

function renderAgent(agent: FactoryStationAgentMeta): string {
  const lines = [`- Agent: ${agent.name}`, `- Model: ${agent.model}`];
  if (agent.sandboxMode) lines.push(`- Sandbox mode: ${agent.sandboxMode}`);
  if (agent.approvalPolicy) lines.push(`- Approval policy: ${agent.approvalPolicy}`);
  if (agent.modelReasoningEffort) {
    lines.push(`- Reasoning effort: ${agent.modelReasoningEffort}`);
  }
  return lines.join("\n");
}

function renderLabels(labels: string[]): string {
  return labels.length > 0 ? labels.join(", ") : "none";
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}
