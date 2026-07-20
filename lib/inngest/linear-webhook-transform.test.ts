import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX,
  LINEAR_WEBHOOK_RECEIVED_EVENT_NAME,
  LINEAR_WEBHOOK_RECEIVED_EVENT_VERSION,
  LINEAR_WEBHOOK_TRANSFORM_SOURCE,
  LinearWebhookReceivedDataSchema,
  LinearWebhookReceivedEvent,
} from "./linear-webhook-transform.ts";

type WebhookTransform = (
  event: unknown,
  headers?: Record<string, unknown>,
  queryParameters?: Record<string, unknown>,
  rawBody?: unknown,
) => unknown;

function loadTransform(): WebhookTransform {
  const value: unknown = new Script(
    `${LINEAR_WEBHOOK_TRANSFORM_SOURCE}\ntransform`,
  ).runInNewContext(Object.create(null));
  if (typeof value !== "function") throw new Error("Linear webhook transform did not load.");
  return value as WebhookTransform;
}

describe("Linear Inngest webhook transform", () => {
  it("locks the typed untrusted event contract", () => {
    expect(LinearWebhookReceivedEvent).toMatchObject({
      name: LINEAR_WEBHOOK_RECEIVED_EVENT_NAME,
      version: LINEAR_WEBHOOK_RECEIVED_EVENT_VERSION,
    });
    expect(
      LinearWebhookReceivedDataSchema.safeParse({
        rawBody: "",
        signature: "",
        deliveryId: "",
      }).success,
    ).toBe(true);
    expect(
      LinearWebhookReceivedDataSchema.safeParse({
        rawBody: "{}",
        signature: "signature",
        deliveryId: "delivery",
        issueId: "untrusted",
      }).success,
    ).toBe(false);
  });

  it("preserves the exact raw body and canonical verification headers", () => {
    const transform = loadTransform();
    const rawBody = '{\n  "type": "Issue", "action": "create"\n}\n';

    const result = transform(
      { type: "Issue", action: "create" },
      {
        "Linear-Signature": "signature-1",
        "Linear-Delivery": "delivery-1",
      },
      {},
      rawBody,
    );

    expect(result).toEqual({
      id: `${LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX}delivery-1`,
      name: LINEAR_WEBHOOK_RECEIVED_EVENT_NAME,
      data: {
        rawBody,
        signature: "signature-1",
        deliveryId: "delivery-1",
      },
    });
    expect(
      LinearWebhookReceivedDataSchema.safeParse((result as { data: unknown }).data).success,
    ).toBe(true);
  });

  it.each([
    [{ type: "Issue", action: "remove" }],
    [{ type: "Comment", action: "create" }],
    [{ type: "untrusted/type", action: "untrusted.action" }],
  ])("uses one constant event name for untrusted payload %#", (payload) => {
    const result = loadTransform()(payload, {}, {}, JSON.stringify(payload));

    expect(result).toMatchObject({ name: LINEAR_WEBHOOK_RECEIVED_EVENT_NAME });
  });

  it("keeps missing headers untrusted without inventing an event identity", () => {
    const result = loadTransform()({ type: "Issue" }, {}, {}, "{}");

    expect(result).toEqual({
      name: LINEAR_WEBHOOK_RECEIVED_EVENT_NAME,
      data: {
        rawBody: "{}",
        signature: "",
        deliveryId: "",
      },
    });
  });

  it("does not set a source timestamp or depend on imports", () => {
    const result = loadTransform()({}, {}, {}, "{}");

    expect(result).not.toHaveProperty("ts");
    expect(LINEAR_WEBHOOK_TRANSFORM_SOURCE).not.toMatch(/\b(?:import|require)\b/);
  });
});
