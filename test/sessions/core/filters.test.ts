import { expect, test } from "vitest";
import { applySessionFilters } from "../../../lib/sessions/core/filters.ts";
import { session } from "../helpers.ts";

test("filters automation by default", () => {
  const sessions = [
    session({ sessionId: "real", isAutomation: false }),
    session({ sessionId: "auto", isAutomation: true }),
  ];
  expect(applySessionFilters(sessions).map((item) => item.sessionId)).toEqual(["real"]);
  expect(
    applySessionFilters(sessions, { excludeAutomation: false }).map((item) => item.sessionId),
  ).toEqual(["real", "auto"]);
});

test("filters by days and workspace prefix", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const sessions = [
    session({
      sessionId: "new",
      workspacePath: "/repo/a",
      updatedAtMs: new Date("2026-06-25T00:00:00.000Z").getTime(),
    }),
    session({
      sessionId: "old",
      workspacePath: "/repo/b",
      updatedAtMs: new Date("2026-06-01T00:00:00.000Z").getTime(),
    }),
  ];
  expect(
    applySessionFilters(sessions, { days: 7, workspacePathPrefix: "/repo/a" }, now).map(
      (item) => item.sessionId,
    ),
  ).toEqual(["new"]);
});

test("filters subagents by default", () => {
  const sessions = [
    session({ sessionId: "real", isSubagent: false }),
    session({ sessionId: "subagent", isSubagent: true }),
  ];

  expect(applySessionFilters(sessions).map((item) => item.sessionId)).toEqual(["real"]);
  expect(
    applySessionFilters(sessions, { excludeSubagent: false }).map((item) => item.sessionId),
  ).toEqual(["real", "subagent"]);
});

test("query matches id, title, workspace, and first user query", () => {
  const sessions = [
    session({
      sessionId: "session-id-match",
      title: "Planning notes",
      firstUserQuery: "Prefer concise status.",
    }),
    session({
      sessionId: "other",
      title: "Debug transcript",
      workspacePath: "/Users/example/dev/search-target",
      firstUserQuery: "Investigate cache rows.",
    }),
  ];

  expect(
    applySessionFilters(sessions, { query: "id-match" }).map((item) => item.sessionId),
  ).toEqual(["session-id-match"]);
  expect(applySessionFilters(sessions, { query: "debug" }).map((item) => item.sessionId)).toEqual([
    "other",
  ]);
  expect(
    applySessionFilters(sessions, { query: "search-target" }).map((item) => item.sessionId),
  ).toEqual(["other"]);
  expect(
    applySessionFilters(sessions, { query: "concise status" }).map((item) => item.sessionId),
  ).toEqual(["session-id-match"]);
});
