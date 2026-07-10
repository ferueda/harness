import type { FactoryLinearSettings } from "../lib/config.ts";
import type { LinearFactoryAdapter } from "../lib/factory-linear-adapter.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";

export const LINEAR_SETTINGS = {
  teamKey: "ENG",
  statuses: {
    intake: "Backlog",
    parked: "Parked",
    needsInfo: "Needs Clarification",
    needsPlanReview: "Plan Needs Review",
    needsPlan: "Needs Plan",
    readyToImplement: "Ready to Implement",
    implementing: "Implementing",
    implementationFailed: "Implementation Failed",
    triaging: "Triaging",
    planning: "Planning",
    triageFailed: "Triage Failed",
    planningFailed: "Planning Failed",
    done: "Done",
    canceled: "Canceled",
    duplicate: "Duplicate",
  },
} satisfies FactoryLinearSettings;

export const LINEAR_WORK_ITEM = {
  id: "linear:ENG-123",
  source: "linear",
  title: "Linear issue",
  body: "Fetched from Linear.",
  url: "https://linear.app/acme/issue/ENG-123/linear-issue",
  labels: ["factory"],
  metadata: {
    tracker: {
      source: "linear",
      id: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123/linear-issue",
    },
    linearIssueId: "issue-1",
    linearProjectId: "project-1",
    linearProjectName: "Harness",
    linearProjectUrl: "https://linear.app/acme/project/harness-123",
    linearStatus: "Backlog",
  },
} satisfies FactoryWorkItem;

export function fakeLinearAdapter(
  overrides: Partial<LinearFactoryAdapter> = {},
): LinearFactoryAdapter {
  return {
    fetchWorkItem: async () => LINEAR_WORK_ITEM,
    listWorkItemsByStatus: async () => {
      throw new Error("listWorkItemsByStatus should not run");
    },
    createWorkItem: async () => {
      throw new Error("createWorkItem should not run");
    },
    validateStatusMap: async () => ({
      teamKey: "ENG",
      statuses: [],
    }),
    applyTriageStarted: async () => {
      throw new Error("applyTriageStarted should not run");
    },
    applyTriageCompleted: async () => {
      throw new Error("applyTriageCompleted should not run");
    },
    applyTriageFailed: async () => {
      throw new Error("applyTriageFailed should not run");
    },
    applyPlanningStarted: async () => {
      throw new Error("applyPlanningStarted should not run");
    },
    applyPlanningCompleted: async () => {
      throw new Error("applyPlanningCompleted should not run");
    },
    applyPlanningFailed: async () => {
      throw new Error("applyPlanningFailed should not run");
    },
    applyPlanningPublished: async () => {
      throw new Error("applyPlanningPublished should not run");
    },
    applyPlanningMerged: async () => {
      throw new Error("applyPlanningMerged should not run");
    },
    applyImplementationStarted: async () => {
      throw new Error("applyImplementationStarted should not run");
    },
    applyImplementationCompleted: async () => {
      throw new Error("applyImplementationCompleted should not run");
    },
    applyImplementationFailed: async () => {
      throw new Error("applyImplementationFailed should not run");
    },
    ...overrides,
  };
}
