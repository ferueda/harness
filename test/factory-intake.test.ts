import { expect, test } from "vitest";
import {
  buildFactoryRoutePlan,
  renderFactoryRouteMarkdown,
  renderFactoryTriageSummary,
} from "../lib/factory-intake.ts";
import {
  FactoryTriageOutputSchema,
  FactoryWorkItemSchema,
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

test("ready-to-implement maps to deterministic direct implementation plan", () => {
  const triage = parseFactoryTriageOutput({
    ...BASE_TRIAGE,
    route: "ready-to-implement",
    suggestedNext: { action: "implement-directly", command: "ignored" },
  });

  const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
  expect(routePlan).toMatchObject({
    route: "ready-to-implement",
    nextAction: "implement-directly",
    statusLabel: "ready-to-implement",
    artifactRelPath: "factory-route.md",
  });
  expect(routePlan.command).toContain("no harness command in PR 1");
  expect(routePlan.command).not.toBe("ignored");
});

test("ready-to-plan maps to planning workflow handoff guidance", () => {
  const triage = parseFactoryTriageOutput({
    ...BASE_TRIAGE,
    route: "ready-to-plan",
    suggestedNext: { action: "create-plan" },
  });

  const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
  expect(routePlan.nextAction).toBe("create-plan");
  expect(routePlan.command).toContain("planning-workflow");
  expect(routePlan.command).toContain("harness run plan-review --plan <plan-path>");
});

test("needs-info requires questions and maps to ask-human", () => {
  const invalid = {
    ...BASE_TRIAGE,
    route: "needs-info",
    suggestedNext: { action: "ask-human" },
  };
  expect(FactoryTriageOutputSchema.safeParse(invalid).success).toBe(false);

  const triage = parseFactoryTriageOutput({
    ...invalid,
    questions: ["Which export formats are in scope?"],
  });
  const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
  expect(routePlan.nextAction).toBe("ask-human");
});

test("wait-to-implement requires reconsiderWhen and maps to park", () => {
  const invalid = {
    ...BASE_TRIAGE,
    route: "wait-to-implement",
    suggestedNext: { action: "park" },
  };
  expect(FactoryTriageOutputSchema.safeParse(invalid).success).toBe(false);

  const triage = parseFactoryTriageOutput({
    ...invalid,
    reconsiderWhen: "Roadmap includes export shortcuts.",
  });
  const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
  expect(routePlan.nextAction).toBe("park");
  expect(routePlan.command).toContain("reconsiderWhen");
});

test("route/action mismatches fail validation", () => {
  expect(
    FactoryTriageOutputSchema.safeParse({
      ...BASE_TRIAGE,
      route: "ready-to-plan",
      suggestedNext: { action: "implement-directly" },
    }).success,
  ).toBe(false);
});

test("factory route and summary markdown include stable operator sections", () => {
  const triage = parseFactoryTriageOutput({
    ...BASE_TRIAGE,
    route: "ready-to-plan",
    suggestedNext: { action: "create-plan" },
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
      questions: undefined,
      reconsiderWhen: undefined,
      expected: "no harness command in PR 1",
    },
    {
      route: "ready-to-plan",
      action: "create-plan",
      questions: undefined,
      reconsiderWhen: undefined,
      expected: "planning-workflow coordinator",
    },
    {
      route: "needs-info",
      action: "ask-human",
      questions: ["Which export formats are in scope?"],
      reconsiderWhen: undefined,
      expected: "Ask the emitted questions[]",
    },
    {
      route: "wait-to-implement",
      action: "park",
      questions: undefined,
      reconsiderWhen: "Roadmap includes export shortcuts.",
      expected: "Park until reconsiderWhen is true",
    },
  ] as const;

  for (const item of cases) {
    const triage = parseFactoryTriageOutput({
      ...BASE_TRIAGE,
      route: item.route,
      questions: item.questions,
      reconsiderWhen: item.reconsiderWhen,
      suggestedNext: { action: item.action },
    });
    const routePlan = buildFactoryRoutePlan(WORK_ITEM, triage);
    expect(renderFactoryRouteMarkdown(WORK_ITEM, triage, routePlan)).toContain(item.expected);
  }
});
