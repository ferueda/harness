import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  verifyLinearIssueChangedWebhook,
  type VerifyLinearIssueChangedWebhookInput,
} from "./webhook.ts";

const SECRET = "linear-webhook-secret";
const DELIVERY_ID = "234d1a4e-b617-4388-90fe-adc3633d6b72";
const RECEIVED_AT = Date.parse("2026-07-19T15:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "create",
    type: "Issue",
    organizationId: "organization-1",
    webhookTimestamp: RECEIVED_AT,
    data: {
      id: "issue-1",
      updatedAt: "2026-07-19T08:00:00-07:00",
    },
    ...overrides,
  };
}

function rawBody(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

function signature(body: Buffer, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function verify(body: Buffer, overrides: Partial<VerifyLinearIssueChangedWebhookInput> = {}) {
  return verifyLinearIssueChangedWebhook({
    secret: SECRET,
    rawBody: body,
    signature: signature(body),
    deliveryId: DELIVERY_ID,
    receivedAt: RECEIVED_AT,
    ...overrides,
  });
}

describe("Linear issue-changed webhook verification", () => {
  it.each(["create", "update"] as const)(
    "returns the small normalized Issue/%s delivery",
    (action) => {
      const payload = issuePayload({ action });
      const body = rawBody(payload);

      const result = verify(body);

      expect(result).toEqual({
        deliveryId: DELIVERY_ID,
        organizationId: "organization-1",
        action,
        issueId: "issue-1",
        issueUpdatedAt: "2026-07-19T15:00:00.000Z",
        webhookTimestamp: payload.webhookTimestamp,
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    },
  );

  it("uses current update data and ignores updatedFrom", () => {
    const payload = issuePayload({
      action: "update",
      updatedFrom: {
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    });
    const body = rawBody(payload);

    const result = verify(body);

    expect(result?.issueUpdatedAt).toBe("2026-07-19T15:00:00.000Z");
  });

  it.each([
    ["issue removal", issuePayload({ action: "remove", data: null })],
    ["unsupported issue action", issuePayload({ action: "archive", data: null })],
    [
      "another entity",
      issuePayload({
        type: "Comment",
        data: null,
      }),
    ],
  ])("returns null for authentic %s", (_label, payload) => {
    const body = rawBody(payload);

    expect(verify(body)).toBeNull();
  });

  it("rejects a signature for different raw bytes", () => {
    const original = rawBody(issuePayload());
    const changed = Buffer.concat([original, Buffer.from(" ")]);

    expect(() => verify(changed, { signature: signature(original) })).toThrowError(
      expect.objectContaining({ code: "rejected" }),
    );
  });

  it.each([
    ["secret", { secret: "" }, "invalid-config"],
    ["signature", { signature: "" }, "invalid-input"],
    ["delivery ID", { deliveryId: "" }, "invalid-input"],
    ["receipt time", { receivedAt: 0 }, "invalid-input"],
    ["raw body", { rawBody: Buffer.alloc(0) }, "invalid-input"],
  ] satisfies Array<
    [string, Partial<VerifyLinearIssueChangedWebhookInput>, "invalid-config" | "invalid-input"]
  >)("rejects a missing %s", (_label, overrides, code) => {
    const body = rawBody(issuePayload());

    expect(() => verify(body, overrides)).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects an invalid signature", () => {
    const body = rawBody(issuePayload());

    expect(() => verify(body, { signature: "invalid" })).toThrowError(
      expect.objectContaining({ code: "rejected" }),
    );
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s webhook timestamp", (_label, webhookTimestamp) => {
    const body = rawBody(issuePayload({ webhookTimestamp }));

    expect(() => verify(body)).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });

  it.each([
    ["expired", -61_000],
    ["future", 61_000],
  ])("rejects a webhook timestamp outside the freshness window: %s", (_label, offset) => {
    const body = rawBody(issuePayload({ webhookTimestamp: RECEIVED_AT + offset }));

    expect(() => verify(body)).toThrowError(expect.objectContaining({ code: "rejected" }));
  });

  it("uses receipt time when durable processing starts later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(RECEIVED_AT + 24 * 60 * 60 * 1_000);
    const body = rawBody(issuePayload());

    expect(verify(body)).toMatchObject({ webhookTimestamp: RECEIVED_AT });
  });

  it("rejects malformed JSON", () => {
    const body = Buffer.from("{");

    expect(() => verify(body)).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });

  it.each([
    ["body", []],
    ["type", issuePayload({ type: undefined })],
    ["action", issuePayload({ action: undefined })],
    ["organization", issuePayload({ organizationId: undefined })],
    ["data", issuePayload({ data: null })],
    [
      "issue ID",
      issuePayload({
        data: { updatedAt: "2026-07-19T15:00:00.000Z" },
      }),
    ],
    [
      "issue update time",
      issuePayload({
        data: { id: "issue-1", updatedAt: "not-a-date" },
      }),
    ],
  ])("rejects a malformed target %s", (_label, payload) => {
    const body = rawBody(payload);

    expect(() => verify(body)).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });

  it("rejects malformed Issue/update data", () => {
    const body = rawBody(
      issuePayload({
        action: "update",
        data: { id: "issue-1", updatedAt: "not-a-date" },
      }),
    );

    expect(() => verify(body)).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });
});
