import { eventType } from "inngest";
import { z } from "zod";

export const LINEAR_WEBHOOK_RECEIVED_EVENT_NAME = "linear/webhook.received";
export const LINEAR_WEBHOOK_RECEIVED_EVENT_VERSION = "1";
export const LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX = "linear-webhook-v1:";

export const LinearWebhookReceivedDataSchema = z
  .object({
    rawBody: z.string(),
    signature: z.string(),
    deliveryId: z.string(),
  })
  .strict();

export type LinearWebhookReceivedData = Readonly<z.infer<typeof LinearWebhookReceivedDataSchema>>;

export const LinearWebhookReceivedEvent = eventType(LINEAR_WEBHOOK_RECEIVED_EVENT_NAME, {
  schema: LinearWebhookReceivedDataSchema,
  version: LINEAR_WEBHOOK_RECEIVED_EVENT_VERSION,
});

/**
 * Paste this plain JavaScript into an Inngest webhook source. It deliberately
 * preserves untrusted input; the consuming function must verify it before use.
 */
export const LINEAR_WEBHOOK_TRANSFORM_SOURCE = `function transform(evt, headers = {}, queryParams = {}, raw = "") {
  var signature = typeof headers["Linear-Signature"] === "string"
    ? headers["Linear-Signature"]
    : "";
  var deliveryId = typeof headers["Linear-Delivery"] === "string"
    ? headers["Linear-Delivery"]
    : "";
  var event = {
    name: "${LINEAR_WEBHOOK_RECEIVED_EVENT_NAME}",
    data: {
      rawBody: typeof raw === "string" ? raw : "",
      signature: signature,
      deliveryId: deliveryId
    }
  };

  if (deliveryId.trim() !== "") {
    event.id = "${LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX}" + deliveryId;
  }

  return event;
}`;
