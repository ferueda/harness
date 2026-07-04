import {
  FactoryRoutePlanSchema,
  type FactoryRoute,
  type FactoryRoutePlan,
  type FactoryTriageOutput,
  type FactoryWorkItem,
} from "./factory-schemas.ts";

export const DRY_RUN_FACTORY_TRIAGE = {
  route: "needs-info",
  confidence: "low",
  rationale: "(dry-run placeholder)",
  evidence: [{ kind: "repo-state", summary: "(dry-run placeholder)" }],
  questions: ["(dry-run placeholder)"],
  suggestedNext: { action: "ask-human" },
} satisfies FactoryTriageOutput;

const ROUTE_PLANS = {
  "ready-to-implement": {
    route: "ready-to-implement",
    nextAction: "implement-directly",
    statusLabel: "ready-to-implement",
    artifactRelPath: "factory-route.md",
    humanSummary: "Ready for direct implementation after human check.",
    command: "Run implementation directly after human confirmation; no harness command in PR 1.",
  },
  "ready-to-plan": {
    route: "ready-to-plan",
    nextAction: "create-plan",
    statusLabel: "ready-to-plan",
    artifactRelPath: "factory-route.md",
    humanSummary: "Needs an implementation plan before coding.",
    command:
      "Use the planning-workflow coordinator to invoke create-plan, then run: harness run plan-review --plan <plan-path>",
  },
  "needs-info": {
    route: "needs-info",
    nextAction: "ask-human",
    statusLabel: "needs-info",
    artifactRelPath: "factory-route.md",
    humanSummary: "Needs human clarification before routing further.",
    command: "Ask the emitted questions[]; rerun factory triage after answers arrive.",
  },
  "wait-to-implement": {
    route: "wait-to-implement",
    nextAction: "park",
    statusLabel: "wait-to-implement",
    artifactRelPath: "factory-route.md",
    humanSummary: "Parked until the reconsideration condition changes.",
    command:
      "Park until reconsiderWhen is true; rerun factory triage after that condition changes.",
  },
} satisfies Record<FactoryRoute, FactoryRoutePlan>;

export function buildFactoryRoutePlan(
  _workItem: FactoryWorkItem,
  triageOutput: FactoryTriageOutput,
): FactoryRoutePlan {
  return FactoryRoutePlanSchema.parse(ROUTE_PLANS[triageOutput.route]);
}

export function renderFactoryTriageSummary(
  workItem: FactoryWorkItem,
  triageOutput: FactoryTriageOutput,
  routePlan: FactoryRoutePlan,
): string {
  return [
    "# Factory Triage Summary",
    "",
    `- Work item: ${workItem.id} - ${workItem.title}`,
    `- Route: ${triageOutput.route}`,
    `- Next action: ${routePlan.nextAction}`,
    `- Confidence: ${triageOutput.confidence}`,
    "",
    "## Rationale",
    "",
    triageOutput.rationale,
    "",
    "## Operator Next Step",
    "",
    routePlan.command ?? routePlan.nextAction,
    "",
  ].join("\n");
}

export function renderFactoryRouteMarkdown(
  workItem: FactoryWorkItem,
  triageOutput: FactoryTriageOutput,
  routePlan: FactoryRoutePlan,
): string {
  return [
    "# Factory Route",
    "",
    `- Work item: ${workItem.id} - ${workItem.title}`,
    `- Route: ${triageOutput.route}`,
    `- Next action: ${routePlan.nextAction}`,
    `- Confidence: ${triageOutput.confidence}`,
    "",
    "## Rationale",
    "",
    triageOutput.rationale,
    "",
    "## Evidence",
    "",
    ...triageOutput.evidence.map((item) => {
      const path = item.path ? ` (${item.path})` : "";
      return `- ${item.kind}${path}: ${item.summary}`;
    }),
    "",
    "## Operator Next Step",
    "",
    routePlan.command ?? routePlan.nextAction,
    "",
  ].join("\n");
}
