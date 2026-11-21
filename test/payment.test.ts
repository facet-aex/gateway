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
  recordReceiptCall,
  verifiedPaymentPayer,
  type DemoPaymentConfig,
  type FacetVersionRef,
} from "../src/payment.js";
import type { PaidQuote } from "../src/multimodal.js";

const config: DemoPaymentConfig = {
  facilitatorUrl: "http://127.0.0.1:4022",
  facilitatorToken: "a".repeat(32),
  payTo: "0x0000000000000000000000000000000000000001",
  amount: "1000",
};
const versionId = "00000000-0000-4000-8000-000000000001";
const target: FacetVersionRef = {
  provider: "alice-labs",
  facetName: "vn-gold-fx-actor",
  version: "1.0.0",
};
const fingerprint = "a".repeat(64);

describe("Gateway x402 challenge", () => {
  it("uses only a facilitator-verified payer matching the authorization", () => {
    const payload = {
      x402Version: 2,
      resource: {
        url: "https://facet.example/invoke",
        description: "run",
        mimeType: "application/json",
      },
      accepted: requirements(config),
      payload: {
        authorization: { from: "0x0000000000000000000000000000000000000002" },
      },
    };
    expect(
      verifiedPaymentPayer(payload, {
        isValid: true,
        payer: "0x0000000000000000000000000000000000000002",
      }),
    ).toBe("0x0000000000000000000000000000000000000002");
    expect(() =>
      verifiedPaymentPayer(payload, {
        isValid: true,
        payer: "0x0000000000000000000000000000000000000003",
      }),
    ).toThrow("PAYMENT_PAYER_INVALID");
    expect(() =>
      verifiedPaymentPayer(payload, {
        isValid: false,
        payer: "0x0000000000000000000000000000000000000002",
      }),
    ).toThrow("PAYMENT_PAYER_INVALID");
  });
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
  it("requires a confirmed or pending receipt transaction response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "CONFIRMED",
          transaction: `0x${"b".repeat(64)}`,
        }),
      ),
    );
    try {
      expect(
        await recordReceiptCall(config, { runId: versionId }),
      ).toMatchObject({ status: "CONFIRMED" });
      expect(fetchMock).toHaveBeenCalledWith(
        new URL("/v1/receipt", config.facilitatorUrl),
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
    const challenge = paymentChallenge(config, target, fingerprint, quote);
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
        target,
        fingerprint,
        quote,
      ),
    ).toEqual(payload);
  });
  it("issues one exact Fuji requirement bound to natural Option B route and input fingerprint", () => {
    const challenge = paymentChallenge(config, target, fingerprint);
    expect(decodePaymentRequiredHeader(challenge.header)).toEqual(
      challenge.body,
    );
    expect(challenge.body.resource.url).toContain(
      `/v1/facets/alice-labs/vn-gold-fx-actor/versions/1.0.0/invoke?fingerprint=${fingerprint}`,
    );
    expect(challenge.body.accepts).toEqual([requirements(config)]);
  });
  it("uses the public HTTPS origin for a production payment resource", () => {
    const previous = { ...process.env };
    try {
      process.env.FACET_PUBLIC_GATEWAY_ORIGIN = "https://facet.example";
      expect(
        paymentChallenge(config, target, fingerprint).body.resource.url,
      ).toBe(
        `https://facet.example/v1/facets/alice-labs/vn-gold-fx-actor/versions/1.0.0/invoke?fingerprint=${fingerprint}`,
      );
    } finally {
      process.env = previous;
    }
  });

  it("rejects a signed payload for another resource or amount", () => {
    const challenge = paymentChallenge(config, target, fingerprint).body;
    const payload = {
      x402Version: 2,
      resource: challenge.resource,
      accepted: challenge.accepts[0]!,
      payload: {},
    };
    const valid = encodePaymentSignatureHeader(payload);
    expect(decodeAndCheckPayment(valid, config, target, fingerprint)).toEqual(
      payload,
    );
    expect(() =>
      decodeAndCheckPayment(valid, config, target, "b".repeat(64)),
    ).toThrow("PAYMENT_REQUIREMENTS_MISMATCH");
    expect(() =>
      decodeAndCheckPayment(
        encodePaymentSignatureHeader({
          ...payload,
          accepted: { ...payload.accepted, amount: "2000" },
        }),
        config,
        target,
        fingerprint,
      ),
    ).toThrow("PAYMENT_REQUIREMENTS_MISMATCH");
  });

  it("allows missing FACET_DEMO_PAY_TO when non-local (NODE_ENV=production or FACET_ENV=staging)", () => {
    const previous = { ...process.env };
    try {
      process.env.FACET_DEMO_X402_ENABLED = "1";
      process.env.FACET_FACILITATOR_URL = "http://x402-facilitator:4022";
      process.env.FACET_FACILITATOR_TOKEN = "a".repeat(32);
      process.env.FACET_PUBLIC_GATEWAY_ORIGIN =
        "https://staging.facet.briandev.space";
      delete process.env.FACET_DEMO_PAY_TO;
      process.env.NODE_ENV = "production";
      expect(readPaymentConfig()?.payTo).toBeUndefined();

      delete process.env.NODE_ENV;
      process.env.FACET_ENV = "staging";
      expect(readPaymentConfig()?.payTo).toBeUndefined();

      process.env.FACET_ENV = "local";
      expect(() => readPaymentConfig()).toThrow("PAYMENT_CONFIG_INVALID");
    } finally {
      process.env = previous;
    }
  });

  it("paymentChallenge emits accepts[] with PAY_PER_RUN and PAY_PER_RESULT extra metadata", () => {
    const feeSplit = "0x0000000000000000000000000000000000000004";
    const creator = "0x0000000000000000000000000000000000000001";
    const quotes: PaidQuote[] = [
      {
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "1000",
        amount: "1000",
        payTo: feeSplit,
        creatorPayTo: creator,
        isPrimary: true,
      },
      {
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 10,
        amount: "5000",
        payTo: feeSplit,
        creatorPayTo: creator,
        isPrimary: false,
      },
    ];
    const challenge = paymentChallenge(config, target, fingerprint, quotes);
    expect(challenge.body.accepts).toHaveLength(2);
    expect(challenge.body.accepts[0]?.extra).toEqual({
      name: "FACET USD",
      version: "2",
      authorizationType: "ReceiveWithAuthorization",
      pricingModel: "PAY_PER_RUN",
      unitPriceAtomic: "1000",
      providerPayTo: creator,
    });
    expect(challenge.body.accepts[0]?.extra).not.toHaveProperty("maxItemsCap");
    expect(challenge.body.accepts[1]?.extra).toEqual({
      name: "FACET USD",
      version: "2",
      authorizationType: "ReceiveWithAuthorization",
      pricingModel: "PAY_PER_RESULT",
      unitPriceAtomic: "500",
      maxItemsCap: 10,
      providerPayTo: creator,
    });
  });

  it("decodeAndCheckPayment disambiguates identical-amount PAY_PER_RUN vs PAY_PER_RESULT via accepted.extra", () => {
    const feeSplit = "0x0000000000000000000000000000000000000004";
    const creator = "0x0000000000000000000000000000000000000001";
    const quotes: PaidQuote[] = [
      {
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "10000",
        amount: "10000",
        payTo: feeSplit,
        creatorPayTo: creator,
        isPrimary: true,
      },
      {
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 20,
        amount: "10000",
        payTo: feeSplit,
        creatorPayTo: creator,
        isPrimary: false,
      },
    ];
    const challenge = paymentChallenge(
      config,
      target,
      fingerprint,
      quotes,
    ).body;
    const resultPayload = {
      x402Version: 2,
      resource: challenge.resource,
      accepted: {
        ...challenge.accepts[1]!,
        extra: {
          ...challenge.accepts[1]!.extra,
          providerPayTo: creator.toUpperCase(),
        },
      },
      payload: {
        authorization: { from: "0x0000000000000000000000000000000000000002" },
      },
    };
    const decoded = decodeAndCheckPayment(
      encodePaymentSignatureHeader(resultPayload),
      config,
      target,
      fingerprint,
      quotes,
    );
    expect(decoded.selectedQuote).toEqual(quotes[1]);

    // Rejects tampered extra even when amount & payTo match
    expect(() =>
      decodeAndCheckPayment(
        encodePaymentSignatureHeader({
          ...resultPayload,
          accepted: {
            ...challenge.accepts[1]!,
            extra: {
              ...challenge.accepts[1]!.extra,
              maxItemsCap: 19,
            },
          },
        }),
        config,
        target,
        fingerprint,
        quotes,
      ),
    ).toThrow("PAYMENT_REQUIREMENTS_MISMATCH");

    expect(() =>
      decodeAndCheckPayment(
        encodePaymentSignatureHeader({
          ...resultPayload,
          accepted: {
            ...challenge.accepts[0]!,
            extra: {
              ...challenge.accepts[0]!.extra,
              maxItemsCap: 20,
            },
          },
        }),
        config,
        target,
        fingerprint,
        quotes,
      ),
    ).toThrow("PAYMENT_REQUIREMENTS_MISMATCH");

    expect(() =>
      decodeAndCheckPayment(
        encodePaymentSignatureHeader({
          ...resultPayload,
          accepted: {
            scheme: "exact",
            network: "eip155:43113",
          } as unknown as (typeof resultPayload)["accepted"],
        }),
        config,
        target,
        fingerprint,
        quotes,
      ),
    ).toThrow("PAYMENT_REQUIREMENTS_MISMATCH");
  });
});
