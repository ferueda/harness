import { expect, test } from "vitest";
import {
  createAbortedAgentResult,
  createAgentAbortRace,
  createAgentSignalState,
} from "../lib/agent-signals.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("createAgentSignalState marks pre-aborted external signals", () => {
  const controller = new AbortController();
  controller.abort();

  const state = createAgentSignalState(controller.signal, 1_000);

  expect(state.signal.aborted).toBe(true);
  expect(state.isExternallyAborted()).toBe(true);
  expect(state.isTimedOut()).toBe(false);
  state.cleanup();
});

test("createAgentSignalState tracks external abort before timeout", () => {
  const controller = new AbortController();
  const state = createAgentSignalState(controller.signal, 1_000);

  controller.abort();

  expect(state.signal.aborted).toBe(true);
  expect(state.isExternallyAborted()).toBe(true);
  expect(state.isTimedOut()).toBe(false);
  state.cleanup();
});

test("createAgentSignalState tracks timeout before later external abort", async () => {
  const controller = new AbortController();
  const state = createAgentSignalState(controller.signal, 1);

  await delay(10);
  controller.abort();

  expect(state.signal.aborted).toBe(true);
  expect(state.isTimedOut()).toBe(true);
  expect(state.isExternallyAborted()).toBe(false);
  state.cleanup();
});

test("createAgentSignalState cleanup clears timeout and external listener", async () => {
  const controller = new AbortController();
  const state = createAgentSignalState(controller.signal, 1);

  state.cleanup();
  controller.abort();
  await delay(10);

  expect(state.signal.aborted).toBe(false);
  expect(state.isTimedOut()).toBe(false);
  expect(state.isExternallyAborted()).toBe(false);
});

test("createAgentAbortRace rejects for already aborted signals", async () => {
  const controller = new AbortController();
  controller.abort();

  const race = createAgentAbortRace(controller.signal);

  await expect(race.promise).rejects.toThrow("abort");
  race.cleanup();
});

test("createAbortedAgentResult returns the shared abort contract", () => {
  expect(createAbortedAgentResult()).toEqual({
    ok: false,
    error: "Agent was aborted",
    exitCode: 130,
    aborted: true,
  });
});
