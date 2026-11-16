import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { describe, expect, it, vi } from "vitest";
import {
  decodeAndCheckPayment,
  paymentChallenge,
  requirements,
  readPaymentConfig,
  contractPaymentCall,
  type DemoPaymentConfig,
} from "../src/payment.js";

const config: DemoPaymentConfig = {
  facilitatorUrl: "http://127.0.0.1:4022",
  facilitatorToken: "a".repeat(32),
  payTo: "0x0000000000000000000000000000000000000001",
  amount: "1000",
};
const versionId = "00000000-0000-4000-8000-000000000001";
const fingerprint = "a".repeat(64);

describe("Gateway x402 challenge", () => {
  it("sends contract phases only to authenticated internal facilitator", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "PENDING",
          transaction: `0x${"a".repeat(64)}`,
        }),
        { status: 202 },
      ),
    );
    try {
      expect(
        await contractPaymentCall(config, "DEPOSIT", { runId: versionId }),
      ).toMatchObject({ status: "PENDING" });
      expect(fetchMock).toHaveBeenCalledWith(
        new URL("/v1/contract/DEPOSIT", config.facilitatorUrl),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-facet-facilitator-token": config.facilitatorToken,
          }),
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("accepts the Compose-internal facilitator hostname", () => {
    const previous = { ...process.env };
    try {
      process.env.FACET_DEMO_X402_ENABLED = "1";
      process.env.FACET_FACILITATOR_URL = "http://x402-facilitator:4022";
      process.env.FACET_FACILITATOR_TOKEN = "a".repeat(32);
      process.env.FACET_DEMO_PAY_TO = config.payTo;
      expect(readPaymentConfig()?.facilitatorUrl).toBe(
        "http://x402-facilitator:4022",
      );
    } finally {
      process.env = previous;
    }
  });
  it("uses a per-version quote for Actor requirements", () => {
    const quote = {
      amount: "10000",
      payTo: "0x0000000000000000000000000000000000000002",
    };
    const challenge = paymentChallenge(config, versionId, fingerprint, quote);
    expect(challenge.body.accepts[0]).toMatchObject(quote);
    const payload = {
      x402Version: 2,
      resource: challenge.body.resource,
      accepted: challenge.body.accepts[0]!,
      payload: {},
    };
    expect(
      decodeAndCheckPayment(
        encodePaymentSignatureHeader(payload),
        config,
        versionId,
        fingerprint,
        quote,
      ),
    ).toEqual(payload);
  });
  it("issues one exact Fuji requirement bound to the requested version and input fingerprint", () => {
    const challenge = paymentChallenge(config, versionId, fingerprint);
    expect(decodePaymentRequiredHeader(challenge.header)).toEqual(
      challenge.body,
    );
    expect(challenge.body.resource.url).toContain(
      `/${versionId}/invoke?fingerprint=${fingerprint}`,
    );
    expect(challenge.body.accepts).toEqual([requirements(config)]);
  });

  it("rejects a signed payload for another resource or amount", () => {
    const challenge = paymentChallenge(config, versionId, fingerprint).body;
    const payload = {
      x402Version: 2,
      resource: challenge.resource,
      accepted: challenge.accepts[0]!,
      payload: {},
    };
    const valid = encodePaymentSignatureHeader(payload);
    expect(
      decodeAndCheckPayment(valid, config, versionId, fingerprint),
    ).toEqual(payload);
    expect(() =>
      decodeAndCheckPayment(valid, config, versionId, "b".repeat(64)),
    ).toThrow("PAYMENT_REQUIREMENTS_MISMATCH");
    expect(() =>
      decodeAndCheckPayment(
        encodePaymentSignatureHeader({
          ...payload,
          accepted: { ...payload.accepted, amount: "2000" },
        }),
        config,
        versionId,
        fingerprint,
      ),
    ).toThrow("PAYMENT_REQUIREMENTS_MISMATCH");
  });
});
