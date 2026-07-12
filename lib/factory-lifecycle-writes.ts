import {
  appendFactoryActionEvent,
  type AppendFactoryActionEventInput,
} from "./factory-lifecycle-kernel.ts";

/** Single write authority for the clean Factory action store. */
export function appendFactoryLifecycleEvent(input: AppendFactoryActionEventInput) {
  return appendFactoryActionEvent(input);
}
