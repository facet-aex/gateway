import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

export interface DemoPaymentConfig {
  facilitatorUrl: string;
  facilitatorToken: string;
  payTo: string;
  amount: string;
}

const asset = "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f";
const network = "eip155:43113";

export function readPaymentConfig(): DemoPaymentConfig | undefined {
  if (process.env.FACET_DEMO_X402_ENABLED !== "1") return undefined;
  const facilitatorUrl = process.env.FACET_FACILITATOR_URL;
  const facilitatorToken = process.env.FACET_FACILITATOR_TOKEN;
  const payTo = process.env.FACET_DEMO_PAY_TO;
  const amount = process.env.FACET_DEMO_AMOUNT_ATOMIC ?? "1000";
  if (
    !facilitatorUrl ||
    new URL(facilitatorUrl).hostname !== "127.0.0.1" ||
    !facilitatorToken ||
    facilitatorToken.length < 32 ||
    !payTo ||
    !/^0x[a-f0-9]{40}$/iu.test(payTo) ||
    !/^[1-9][0-9]{0,5}$/u.test(amount)
  )
    throw new Error("PAYMENT_CONFIG_INVALID");
  return { facilitatorUrl, facilitatorToken, payTo, amount };
}

export function requirements(config: DemoPaymentConfig): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset,
    amount: config.amount,
    payTo: config.payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "FACET USD", version: "2" },
  };
}

export function paymentChallenge(
  config: DemoPaymentConfig,
  versionId: string,
  fingerprint: string,
) {
  const required: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: `http://127.0.0.1:${process.env.FACET_GATEWAY_PORT ?? "4020"}/v1/facet-versions/${versionId}/invoke?fingerprint=${fingerprint}`,
      description: "FACET demo read-only API call",
      mimeType: "application/json",
    },
    accepts: [requirements(config)],
  };
  return { header: encodePaymentRequiredHeader(required), body: required };
}

export function decodeAndCheckPayment(
  header: string,
  config: DemoPaymentConfig,
  versionId: string,
  fingerprint: string,
): PaymentPayload {
  const payload = decodePaymentSignatureHeader(header);
  const accepted = payload.accepted;
  const expected = requirements(config);
  const expectedResource = paymentChallenge(config, versionId, fingerprint).body
    .resource.url;
  if (
    payload.x402Version !== 2 ||
    payload.resource?.url !== expectedResource ||
    accepted.scheme !== expected.scheme ||
    accepted.network !== expected.network ||
    accepted.asset.toLowerCase() !== expected.asset.toLowerCase() ||
    accepted.amount !== expected.amount ||
    accepted.payTo.toLowerCase() !== expected.payTo.toLowerCase() ||
    accepted.maxTimeoutSeconds !== 60 ||
    accepted.extra?.name !== "FACET USD" ||
    accepted.extra?.version !== "2"
  )
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
  return payload;
}

async function facilitatorCall<T>(
  config: DemoPaymentConfig,
  operation: "verify" | "settle",
  paymentPayload: PaymentPayload,
): Promise<T> {
  const response = await fetch(
    new URL(`/${operation}`, config.facilitatorUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-facet-facilitator-token": config.facilitatorToken,
      },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements: requirements(config),
      }),
      signal: AbortSignal.timeout(35_000),
    },
  );
  if (!response.ok)
    throw new Error(`FACILITATOR_${operation.toUpperCase()}_FAILED`);
  return (await response.json()) as T;
}

export const verifyPayment = (
  config: DemoPaymentConfig,
  payload: PaymentPayload,
) => facilitatorCall<VerifyResponse>(config, "verify", payload);
export const settlePayment = (
  config: DemoPaymentConfig,
  payload: PaymentPayload,
) => facilitatorCall<SettleResponse>(config, "settle", payload);
