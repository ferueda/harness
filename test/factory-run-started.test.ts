import { expect, test } from "vitest";
import {
  announceFactoryRunStarted,
  type FactoryRunStartedProgress,
} from "../lib/factory-run-started.ts";

test("announceFactoryRunStarted writes one stderr JSON progress line", () => {
  const lines: string[] = [];
  const progress = announceFactoryRunStarted(
    {
      station: "triage",
      runId: "20260709-000000-abcdef",
      runDir: "/tmp/run",
      workspace: "/tmp/ws",
    },
    (line) => lines.push(line),
  );

  expect(progress).toEqual({
    harnessFactory: "run-started",
    station: "triage",
    runId: "20260709-000000-abcdef",
    runDir: "/tmp/run",
    workspace: "/tmp/ws",
  } satisfies FactoryRunStartedProgress);
  expect(lines).toEqual([JSON.stringify(progress)]);
  expect(JSON.parse(lines[0]!)).not.toHaveProperty("type");
});
