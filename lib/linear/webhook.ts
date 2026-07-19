import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { LinearError } from "./error.ts";

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
  const webhookTimestamp = requiredWebhookTimestamp(payload.webhookTimestamp);

  try {
    new LinearWebhookClient(secret).verify(input.rawBody, signature, webhookTimestamp);
  } catch (cause) {
    throw new LinearError("rejected", "Linear webhook verification failed.", { cause });
  }

  const type = requiredString(payload.type, "payload type");
  const action = requiredString(payload.action, "payload action");
  if (type !== "Issue" || action !== "create") return null;

  const organizationId = requiredString(payload.organizationId, "organizationId");
  const data = requiredRecord(payload.data, "data");
  const issueId = requiredString(data.id, "data.id");
  const issueUpdatedAt = normalizedDate(data.updatedAt, "data.updatedAt");

  return {
    deliveryId,
    organizationId,
    issueId,
    issueUpdatedAt,
    webhookTimestamp,
  };
}

function parsePayload(rawBody: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch (cause) {
    throw new LinearError("invalid-input", "Linear webhook body must be valid JSON.", { cause });
  }
  return requiredRecord(value, "body");
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidInput(`Linear webhook ${label} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function requiredWebhookTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidInput("Linear webhook webhookTimestamp must be a positive safe integer.");
  }
  return value;
}

function normalizedDate(value: unknown, label: string): string {
  const text = requiredString(value, label);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw invalidInput(`Linear webhook ${label} must be a valid date.`);
  }
  return new Date(timestamp).toISOString();
}

function invalidInput(message: string): LinearError {
  return new LinearError("invalid-input", message);
}
