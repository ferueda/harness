import { expect, test, vi } from "vitest";
import {
  createAbortedAgentResult,
  createAgentAbortRace,
  createAgentSignalState,
} from "../lib/agent/signals.ts";

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

test("createAgentSignalState zero timeout creates no timer but keeps external cancellation", () => {
  vi.useFakeTimers();
  try {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    const state = createAgentSignalState(controller.signal, 0);
    expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    expect(state.signal.aborted).toBe(false);
    controller.abort();
    expect(state.signal.aborted).toBe(true);
    expect(state.isExternallyAborted()).toBe(true);
    state.cleanup();
  } finally {
    vi.useRealTimers();
  }
});

test("createAgentSignalState cleanup clears timeout and external listener", () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const state = createAgentSignalState(controller.signal, 1);

    state.cleanup();
    controller.abort();
    vi.advanceTimersByTime(10);

    expect(state.signal.aborted).toBe(false);
    expect(state.isTimedOut()).toBe(false);
    expect(state.isExternallyAborted()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("createAgentAbortRace rejects for already aborted signals", async () => {
  const controller = new AbortController();
  controller.abort();

  const race = createAgentAbortRace(controller.signal);

  await expect(race.promise).rejects.toThrow("abort");
  race.cleanup();
});

test("createAgentAbortRace rejects after subscribe and cleans up its listener", async () => {
  const controller = new AbortController();
  const addEventListener = controller.signal.addEventListener.bind(controller.signal);
  const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
  let abortListeners = 0;
  const trackedAddEventListener: AbortSignal["addEventListener"] = (
    type: string,
    listener: EventListener | EventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ) => {
    if (type === "abort") abortListeners += 1;
    return addEventListener(type, listener, options);
  };
  const trackedRemoveEventListener: AbortSignal["removeEventListener"] = (
    type: string,
    listener: EventListener | EventListenerObject,
    options?: EventListenerOptions | boolean,
  ) => {
    if (type === "abort") abortListeners -= 1;
    return removeEventListener(type, listener, options);
  };
  controller.signal.addEventListener = trackedAddEventListener;
  controller.signal.removeEventListener = trackedRemoveEventListener;
  const race = createAgentAbortRace(controller.signal);

  controller.abort();

  await expect(race.promise).rejects.toThrow("abort");
  race.cleanup();
  expect(abortListeners).toBe(0);
});

test("createAbortedAgentResult returns the shared abort contract", () => {
  expect(createAbortedAgentResult()).toEqual({
    ok: false,
    error: "Agent was aborted",
    exitCode: 130,
    aborted: true,
  });
});
