import { resolve } from "node:path";
import { readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
  type FactoryReaction,
} from "./factory-state-machine.ts";

export type FactoryInspection = {
  workItemKey: string;
  artifactRoots: {
    repository: string;
    "factory-store": string;
  };
  state: FactoryLifecycleState | null;
  latestEvent: FactoryLifecycleEvent | null;
  reaction: FactoryReaction | null;
};

export function inspectFactoryWorkItem(input: {
  workItemKey: string;
  workspace: string;
  factoryStateRoot: string;
  factoryStoreProjectRoot: string;
}): FactoryInspection {
  const events = readFactoryActionEvents(input.factoryStateRoot, input.workItemKey, {
    mode: "inspection",
  });
  const state = reduceFactoryLifecycleEvents(events) ?? null;
  const latestEvent = events.at(-1) ?? null;
  const reaction = state && latestEvent ? decideNextFactoryAction(state, latestEvent) : null;
  return {
    workItemKey: input.workItemKey,
    artifactRoots: {
      repository: resolve(input.workspace),
      "factory-store": resolve(input.factoryStoreProjectRoot),
    },
    state,
    latestEvent,
    reaction,
  };
}
