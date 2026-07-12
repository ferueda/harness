import { expect, test } from "vitest";
import {
  buildFactoryRoutePlan,
  renderFactoryRouteMarkdown,
  renderFactoryTriageSummary,
} from "../lib/factory-intake.ts";
import {
  FactoryWorkItemMetadataSchema,
  FactoryTriageOutputSchema,
  FactoryWorkItemSchema,
  parseFactoryWorkItemMetadata,
  parseFactoryTriageOutput,
  type FactoryTriageOutput,
} from "../lib/factory-schemas.ts";

const WORK_ITEM = FactoryWorkItemSchema.parse({
  id: "item-1",
  source: "file",
  title: "Fix export crash",
  body: "Export crashes when the output directory is missing.",
});

const BASE_TRIAGE = {
  confidence: "high",
  rationale: "The item is narrow and supported by repo evidence.",
  evidence: [{ kind: "docs", path: "README.md", summary: "Export is supported." }],
} satisfies Pick<FactoryTriageOutput, "confidence" | "rationale" | "evidence">;

const NO_FOLLOWUP = {
  questions: [],
  reconsiderWhen: null,
} satisfies Pick<FactoryTriageOutput, "questions" | "reconsiderWhen">;

test("work items default labels and reject unknown fields", () => {
  const parsed = FactoryWorkItemSchema.parse({
    id: "manual-1",
    source: "manual",
    title: "Investigate flaky test",
    body: "",
  });

  expect(parsed.labels).toEqual([]);
  expect(
    FactoryWorkItemSchema.safeParse({
      ...parsed,
      extra: true,
    }).success,
  ).toBe(false);
});

test("work item metadata reserves factory tracker and handoff keys", () => {
  const metadata = parseFactoryWorkItemMetadata({
    tracker: {
      source: "github",
      id: "ferueda/harness#123",
      url: "https://github.com/ferueda/harness/issues/123",
    },
    factoryRoute: "ready-to-plan",
    factoryNextAction: "create-plan",
    factoryStage: "plan-pr-open",
    factoryRunId: "20260707-120000",
    approvedPlanPath: "dev/plans/GH-123.md",
    approvedPlanPrUrl: "https://github.com/ferueda/harness/pull/123",
    approvedPlanCommit: "abc1234",
    adapterSpecificField: { project: "Factory" },
  });

  expect(metadata.tracker?.id).toBe("ferueda/harness#123");
  expect(metadata.adapterSpecificField).toEqual({ project: "Factory" });
  expect(
    FactoryWorkItemMetadataSchema.safeParse({
      tracker: { source: "unknown", id: "123" },
    }).success,
  ).toBe(false);
  expect(
    FactoryWorkItemMetadataSchema.safeParse({
      factoryStage: "reviewer-invented-stage",
    }).success,
  ).toBe(false);
});

test("ready-to-implement maps to deterministic direct implementation plan", () => {
  const triage = parseFactoryTriageOutput({
    ...BASE_TRIAGE,
    ...NO_FOLLOWUP,
    route: "ready-to-implement",
    suggestedNext: { action: "implement-directly", command: "ignored", artifact: null },
  });

  const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
  expect(routePlan).toMatchObject({
    route: "ready-to-implement",
    nextAction: "implement-directly",
    statusLabel: "ready-to-implement",
    artifactRelPath: "factory-route.md",
  });
  expect(routePlan.command).toBeUndefined();
});

test("ready-to-plan maps to a non-executable planning reaction", () => {
  const triage = parseFactoryTriageOutput({
    ...BASE_TRIAGE,
    ...NO_FOLLOWUP,
    route: "ready-to-plan",
    suggestedNext: { action: "create-plan", command: null, artifact: null },
  });

  const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
  expect(routePlan.nextAction).toBe("create-plan");
  expect(routePlan.command).toBeUndefined();
});

test("needs-info requires questions and maps to ask-human", () => {
  const invalid = {
    ...BASE_TRIAGE,
    ...NO_FOLLOWUP,
    route: "needs-info",
    suggestedNext: { action: "ask-human", command: null, artifact: null },
  };
  expect(FactoryTriageOutputSchema.safeParse(invalid).success).toBe(false);

  const triage = parseFactoryTriageOutput({
    ...invalid,
    questions: ["Which export formats are in scope?"],
  });
  const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
  expect(routePlan.nextAction).toBe("ask-human");
  expect(
    buildFactoryRoutePlan(WORK_ITEM, triage, { nextLiveRunRequiresRerun: true }).command,
  ).toBeUndefined();
  expect(buildFactoryRoutePlan(WORK_ITEM, triage, { isDryRun: true }).command).toBeUndefined();
});

test("wait-to-implement requires reconsiderWhen and maps to park", () => {
  const invalid = {
    ...BASE_TRIAGE,
    ...NO_FOLLOWUP,
    route: "wait-to-implement",
    suggestedNext: { action: "park", command: null, artifact: null },
  };
  expect(FactoryTriageOutputSchema.safeParse(invalid).success).toBe(false);

  const triage = parseFactoryTriageOutput({
    ...invalid,
    reconsiderWhen: "Roadmap includes export shortcuts.",
  });
  const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
  expect(routePlan.nextAction).toBe("park");
  expect(routePlan.command).toBeUndefined();
  expect(
    buildFactoryRoutePlan(WORK_ITEM, triage, { nextLiveRunRequiresRerun: true }).command,
  ).toBeUndefined();
});

test("route/action mismatches fail validation", () => {
  expect(
    FactoryTriageOutputSchema.safeParse({
      ...BASE_TRIAGE,
      ...NO_FOLLOWUP,
      route: "ready-to-plan",
      suggestedNext: { action: "implement-directly", command: null, artifact: null },
    }).success,
  ).toBe(false);
});

test("factory route and summary markdown include stable operator sections", () => {
  const triage = parseFactoryTriageOutput({
    ...BASE_TRIAGE,
    ...NO_FOLLOWUP,
    route: "ready-to-plan",
    suggestedNext: { action: "create-plan", command: null, artifact: null },
  });
  const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
  const routeMarkdown = renderFactoryRouteMarkdown(WORK_ITEM, triage, routePlan);
  const summary = renderFactoryTriageSummary(WORK_ITEM, triage, routePlan);

  expect(routeMarkdown).toContain("# Factory Route");
  expect(routeMarkdown).toContain("- Work item: item-1 - Fix export crash");
  expect(routeMarkdown).toContain("## Evidence");
  expect(routeMarkdown).toContain("- docs (README.md): Export is supported.");
  expect(routeMarkdown).toContain("## Operator Next Step");
  expect(summary).toContain("# Factory Triage Summary");
  expect(summary).toContain("## Operator Next Step");
});

test("factory route markdown includes route-specific operator guidance", () => {
  const cases = [
    {
      route: "ready-to-implement",
      action: "implement-directly",
      questions: [],
      reconsiderWhen: null,
      expected: "implement-directly",
    },
    {
      route: "ready-to-plan",
      action: "create-plan",
      questions: [],
      reconsiderWhen: null,
      expected: "create-plan",
    },
    {
      route: "needs-info",
      action: "ask-human",
      questions: ["Which export formats are in scope?"],
      reconsiderWhen: null,
      expected: "ask-human",
    },
    {
      route: "wait-to-implement",
      action: "park",
      questions: [],
      reconsiderWhen: "Roadmap includes export shortcuts.",
      expected: "park",
    },
  ] as const;

  for (const item of cases) {
    const triage = parseFactoryTriageOutput({
      ...BASE_TRIAGE,
      route: item.route,
      questions: item.questions,
      reconsiderWhen: item.reconsiderWhen,
      suggestedNext: { action: item.action, command: null, artifact: null },
    });
    const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
    expect(renderFactoryRouteMarkdown(WORK_ITEM, triage, routePlan)).toContain(item.expected);
  }
});
