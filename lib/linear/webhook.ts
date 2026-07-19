import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { z } from "zod";
import { LinearError } from "./error.ts";

const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "");
const webhookEnvelopeSchema = z
  .object({
    webhookTimestamp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .passthrough();
const webhookEventSchema = webhookEnvelopeSchema.extend({
  type: nonEmptyStringSchema,
  action: nonEmptyStringSchema,
});
const issueCreatedPayloadSchema = webhookEventSchema.extend({
  type: z.literal("Issue"),
  action: z.literal("create"),
  organizationId: nonEmptyStringSchema,
  data: z.object({
    id: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema
      .refine((value) => Number.isFinite(Date.parse(value)))
      .transform((value) => new Date(Date.parse(value)).toISOString()),
  }),
});

export type VerifyLinearIssueCreatedWebhookInput = Readonly<{
  secret: string;
  rawBody: Buffer;
  signature: string;
  deliveryId: string;
}>;

export type LinearIssueCreatedDelivery = Readonly<{
  deliveryId: string;
  organizationId: string;
  issueId: string;
  issueUpdatedAt: string;
  webhookTimestamp: number;
}>;

export function verifyLinearIssueCreatedWebhook(
  input: VerifyLinearIssueCreatedWebhookInput,
): LinearIssueCreatedDelivery | null {
  const secret = requiredString(input.secret, "secret", "invalid-config");
  const signature = requiredString(input.signature, "signature");
  const deliveryId = requiredString(input.deliveryId, "deliveryId");
  if (!Buffer.isBuffer(input.rawBody) || input.rawBody.length === 0) {
    throw invalidInput("Linear webhook rawBody must be a non-empty Buffer.");
  }

  const payload = parsePayload(input.rawBody);
  const envelope = webhookEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw invalidInput(
      "Linear webhook body must include a valid webhookTimestamp.",
      envelope.error,
    );
  }
  const { webhookTimestamp } = envelope.data;

  try {
    new LinearWebhookClient(secret).verify(input.rawBody, signature, webhookTimestamp);
  } catch (cause) {
    throw new LinearError("rejected", "Linear webhook verification failed.", { cause });
  }

  const event = webhookEventSchema.safeParse(payload);
  if (!event.success) {
    throw invalidInput("Linear webhook body must include a valid type and action.", event.error);
  }
  const { type, action } = event.data;
  if (type !== "Issue" || action !== "create") return null;

  const issueCreated = issueCreatedPayloadSchema.safeParse(payload);
  if (!issueCreated.success) {
    throw invalidInput("Linear Issue/create webhook body is invalid.", issueCreated.error);
  }

  return {
    deliveryId,
    organizationId: issueCreated.data.organizationId,
    issueId: issueCreated.data.data.id,
    issueUpdatedAt: issueCreated.data.data.updatedAt,
    webhookTimestamp,
  };
}

function parsePayload(rawBody: Buffer): unknown {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch (cause) {
    throw new LinearError("invalid-input", "Linear webhook body must be valid JSON.", { cause });
  }
  return value;
}

function requiredString(
  value: unknown,
  label: string,
  code: "invalid-config" | "invalid-input" = "invalid-input",
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LinearError(code, `Linear webhook ${label} must be a non-empty string.`);
  }
  return value;
}

function invalidInput(message: string, cause?: unknown): LinearError {
  return new LinearError("invalid-input", message, { cause });
}
