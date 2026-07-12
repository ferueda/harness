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
  evidence: [{ kind: "repo-state", path: null, summary: "(dry-run placeholder)" }],
  questions: ["(dry-run placeholder)"],
  reconsiderWhen: null,
  suggestedNext: { action: "ask-human", command: null, artifact: null },
} satisfies FactoryTriageOutput;

const ROUTE_PLANS = {
  "ready-to-implement": {
    route: "ready-to-implement",
    nextAction: "implement-directly",
    statusLabel: "ready-to-implement",
    artifactRelPath: "factory-route.md",
    humanSummary: "Ready for direct implementation after human check.",
  },
  "ready-to-plan": {
    route: "ready-to-plan",
    nextAction: "create-plan",
    statusLabel: "ready-to-plan",
    artifactRelPath: "factory-route.md",
    humanSummary: "Needs an implementation plan before coding.",
  },
  "needs-info": {
    route: "needs-info",
    nextAction: "ask-human",
    statusLabel: "needs-info",
    artifactRelPath: "factory-route.md",
    humanSummary: "Needs human clarification before routing further.",
  },
  "wait-to-implement": {
    route: "wait-to-implement",
    nextAction: "park",
    statusLabel: "wait-to-implement",
    artifactRelPath: "factory-route.md",
    humanSummary: "Parked until the reconsideration condition changes.",
  },
} satisfies Record<FactoryRoute, FactoryRoutePlan>;

export function buildFactoryRoutePlan(
  _workItem: FactoryWorkItem,
  triageOutput: FactoryTriageOutput,
  options: { nextLiveRunRequiresRerun?: boolean; isDryRun?: boolean } = {},
): FactoryRoutePlan {
  const routePlan = ROUTE_PLANS[triageOutput.route];
  const repeatableRoute =
    triageOutput.route === "needs-info" || triageOutput.route === "wait-to-implement";
  let guidanceSuffix: string | undefined;
  if (options.nextLiveRunRequiresRerun) {
    guidanceSuffix = "Use --rerun for the intentional repeat.";
  } else if (options.isDryRun) {
    guidanceSuffix = "Run live factory triage without --rerun for the first recorded triage.";
  }
  return FactoryRoutePlanSchema.parse(
    repeatableRoute && guidanceSuffix && "command" in routePlan && routePlan.command
      ? { ...routePlan, command: `${routePlan.command} ${guidanceSuffix}` }
      : routePlan,
  );
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
