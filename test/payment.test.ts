import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { describe, expect, it } from "vitest";
import {
  decodeAndCheckPayment,
  paymentChallenge,
  requirements,
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
