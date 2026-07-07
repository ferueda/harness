import { expect, test } from "vitest";
import { factoryTriageCliOutput } from "../bin/factory-triage-cli.ts";
import type { FactoryRunMeta } from "../lib/factory-run-context.ts";

const META = {
  runId: "run-1",
  workflow: "factory-triage",
  status: "dry_run",
  workspace: "/tmp/workspace",
  runDir: "/tmp/workspace/.harness/runs/factory/run-1",
  workItem: {
    id: "linear:ENG-123",
    source: "linear",
    title: "Linear issue",
  },
  agent: {
    name: "cursor",
    model: "composer-2.5",
  },
  startedAt: "2026-07-07T00:00:00.000Z",
  durationMs: 1,
} satisfies FactoryRunMeta;

test("factoryTriageCliOutput includes linearApplied only when provided", () => {
  expect(factoryTriageCliOutput(META)).not.toHaveProperty("linearApplied");
  expect(factoryTriageCliOutput(META, { linearApplied: false })).toMatchObject({
    runId: "run-1",
    status: "dry_run",
    linearApplied: false,
  });
});

test("factoryTriageCliOutput includes Linear apply details", () => {
  expect(
    factoryTriageCliOutput(META, {
      linearApplied: true,
      linearUpdate: {
        started: {
          issueIdentifier: "ENG-123",
          runId: "run-1",
          runDir: "/tmp/workspace/.harness/runs/factory/run-1",
          stage: "start",
          fromStatus: "Backlog",
          targetStatus: "Triaging",
        },
        terminal: {
          issueIdentifier: "ENG-123",
          runId: "run-1",
          runDir: "/tmp/workspace/.harness/runs/factory/run-1",
          stage: "complete",
          fromStatus: "Triaging",
          targetStatus: "Needs Plan",
          commentMarker: "<!-- harness-factory:triage:run-1 -->",
          commentBody: "Factory triage complete.",
        },
      },
    }),
  ).toMatchObject({
    linearApplied: true,
    linearUpdate: {
      started: { targetStatus: "Triaging" },
      terminal: { targetStatus: "Needs Plan" },
    },
  });
});
