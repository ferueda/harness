import { createHash } from "node:crypto";
import { eventType } from "inngest";
import { z } from "zod";

export const WORK_REQUEST_EVENT_VERSION = "1";
export const WORK_REQUEST_EVENT_ID_PREFIX = "harness-work-request-v1-";

export const WORK_REQUEST_EVENT_NAMES = {
  triage: "work/triage.requested",
  spec: "work/spec.requested",
  implement: "work/implementation.requested",
} as const;

export type WorkRequestRoute = keyof typeof WORK_REQUEST_EVENT_NAMES;

const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "");

export const WorkRequestDataSchema = z
  .object({
    issueId: nonEmptyStringSchema,
    issueIdentifier: nonEmptyStringSchema,
    causationEventId: nonEmptyStringSchema,
    snapshotGeneration: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type WorkRequestData = Readonly<z.infer<typeof WorkRequestDataSchema>>;

export const TriageWorkRequestedEvent = eventType(WORK_REQUEST_EVENT_NAMES.triage, {
  schema: WorkRequestDataSchema,
  version: WORK_REQUEST_EVENT_VERSION,
});

export const SpecWorkRequestedEvent = eventType(WORK_REQUEST_EVENT_NAMES.spec, {
  schema: WorkRequestDataSchema,
  version: WORK_REQUEST_EVENT_VERSION,
});

export const ImplementationWorkRequestedEvent = eventType(WORK_REQUEST_EVENT_NAMES.implement, {
  schema: WorkRequestDataSchema,
  version: WORK_REQUEST_EVENT_VERSION,
});

export function workRequestEventId(route: WorkRequestRoute, data: WorkRequestData): string {
  const parsed = WorkRequestDataSchema.parse(data);
  const identity = [
    "harness-work-request",
    1,
    WORK_REQUEST_EVENT_NAMES[route],
    WORK_REQUEST_EVENT_VERSION,
    parsed.issueId,
    route,
    parsed.snapshotGeneration,
  ];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${WORK_REQUEST_EVENT_ID_PREFIX}${digest}`;
}

export function createWorkRequestedEvent(route: WorkRequestRoute, data: WorkRequestData) {
  const parsed = WorkRequestDataSchema.parse(data);
  const options = { id: workRequestEventId(route, parsed) };
  switch (route) {
    case "triage":
      return TriageWorkRequestedEvent.create(parsed, options);
    case "spec":
      return SpecWorkRequestedEvent.create(parsed, options);
    case "implement":
      return ImplementationWorkRequestedEvent.create(parsed, options);
  }
}
