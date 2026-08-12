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

export const ImplementationWorkRequestDataSchema = WorkRequestDataSchema.extend({
  sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type ImplementationWorkRequestData = Readonly<
  z.infer<typeof ImplementationWorkRequestDataSchema>
>;

export const TriageWorkRequestedEvent = eventType(WORK_REQUEST_EVENT_NAMES.triage, {
  schema: WorkRequestDataSchema,
  version: WORK_REQUEST_EVENT_VERSION,
});

export const SpecWorkRequestedEvent = eventType(WORK_REQUEST_EVENT_NAMES.spec, {
  schema: WorkRequestDataSchema,
  version: WORK_REQUEST_EVENT_VERSION,
});

export const ImplementationWorkRequestedEvent = eventType(WORK_REQUEST_EVENT_NAMES.implement, {
  schema: ImplementationWorkRequestDataSchema,
  version: WORK_REQUEST_EVENT_VERSION,
});

export function workRequestEventId(route: "implement", data: ImplementationWorkRequestData): string;
export function workRequestEventId(route: "triage" | "spec", data: WorkRequestData): string;
export function workRequestEventId(
  route: WorkRequestRoute,
  data: WorkRequestData | ImplementationWorkRequestData,
): string {
  const parsed =
    route === "implement"
      ? ImplementationWorkRequestDataSchema.parse(data)
      : WorkRequestDataSchema.parse(data);
  const identity = [
    "harness-work-request",
    1,
    WORK_REQUEST_EVENT_NAMES[route],
    WORK_REQUEST_EVENT_VERSION,
    parsed.issueId,
    route,
    parsed.snapshotGeneration,
    implementationSourceFingerprint(route, data),
  ];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${WORK_REQUEST_EVENT_ID_PREFIX}${digest}`;
}

function implementationSourceFingerprint(
  route: WorkRequestRoute,
  data: WorkRequestData | ImplementationWorkRequestData,
): string | null {
  return route === "implement"
    ? ImplementationWorkRequestDataSchema.parse(data).sourceFingerprint
    : null;
}

export function createWorkRequestedEvent(
  route: "implement",
  data: ImplementationWorkRequestData,
): ReturnType<typeof ImplementationWorkRequestedEvent.create>;
export function createWorkRequestedEvent(
  route: "triage" | "spec",
  data: WorkRequestData,
):
  | ReturnType<typeof TriageWorkRequestedEvent.create>
  | ReturnType<typeof SpecWorkRequestedEvent.create>;
export function createWorkRequestedEvent(
  route: WorkRequestRoute,
  data: WorkRequestData | ImplementationWorkRequestData,
) {
  if (route === "implement") {
    const parsed = ImplementationWorkRequestDataSchema.parse(data);
    return ImplementationWorkRequestedEvent.create(parsed, {
      id: workRequestEventId(route, parsed),
    });
  }
  const base = WorkRequestDataSchema.parse(data);
  const options = { id: workRequestEventId(route, base) };
  return route === "triage"
    ? TriageWorkRequestedEvent.create(base, options)
    : SpecWorkRequestedEvent.create(base, options);
}
