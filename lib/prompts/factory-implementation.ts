import type { FactoryStationAgentMeta } from "../factory-agent-meta.ts";
import type { FactoryImplementationInput } from "../factory-implementation-input.ts";

export type FactoryImplementationPromptInput = {
  implementationInput: FactoryImplementationInput;
  implementerAgent: FactoryStationAgentMeta;
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
    "## Station Boundaries",
    "",
    "- This station does not own tracker mutation.",
    "- This station does not own PR creation.",
    "- This station does not own branch or worktree orchestration.",
    "- This station does not own change-review execution.",
    "- This station does not own lifecycle updates.",
    "",
  ].join("\n");
}

export function renderFactoryImplementationChangeReviewHandoff(
  input: FactoryImplementationPromptInput,
): string {
  const implementationInput = input.implementationInput;
  const modeNotes =
    implementationInput.mode === "planned"
      ? [
          `- Mode: planned`,
          `- Approved plan path: \`${implementationInput.approvedPlanPath}\``,
          `- Absolute plan path: \`${implementationInput.planPath}\``,
          `- Approved plan commit: \`${implementationInput.approvedPlanCommit}\``,
        ]
      : [
          `- Mode: direct`,
          `- Source title: ${implementationInput.sourceMaterial.title}`,
          ...(implementationInput.sourceMaterial.url
            ? [`- Source URL: ${implementationInput.sourceMaterial.url}`]
            : []),
          `- Labels: ${renderLabels(implementationInput.sourceMaterial.labels)}`,
          ...(implementationInput.sourceMaterial.tracker
            ? [`- Tracker: ${JSON.stringify(implementationInput.sourceMaterial.tracker)}`]
            : []),
          ...(implementationInput.sourceMaterial.body
            ? [`- Body excerpt: ${excerpt(implementationInput.sourceMaterial.body)}`]
            : []),
        ];

  return [
    "## Goal",
    "",
    `Implement ${implementationInput.workItem.id}: ${implementationInput.workItem.title}.`,
    "",
    "## Scope",
    "",
    ...modeNotes,
    "- Stay within the factory implementation input boundaries.",
    "",
    "## Files changed",
    "",
    "_To be filled after implementation._",
    "",
    "## Implementation notes",
    "",
    "_To be filled after implementation._",
    "",
    "## Verification",
    "",
    "_Not run yet._",
    "",
    "## Risks to scrutinize",
    "",
    "- Verify the implementation follows the resolved factory implementation input.",
    "- Verify no unrelated tracker, lifecycle, branch, worktree, or PR automation was added.",
    "",
    "## Open items",
    "",
    "_To be filled after implementation._",
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
