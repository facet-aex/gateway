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
export interface VersionQuote {
  amount: string;
  payTo: string;
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
    !["127.0.0.1", "x402-facilitator"].includes(
      new URL(facilitatorUrl).hostname,
    ) ||
    !facilitatorToken ||
    facilitatorToken.length < 32 ||
    !payTo ||
    !/^0x[a-f0-9]{40}$/iu.test(payTo) ||
    !/^[1-9][0-9]{0,5}$/u.test(amount)
  )
    throw new Error("PAYMENT_CONFIG_INVALID");
  return { facilitatorUrl, facilitatorToken, payTo, amount };
}

export function requirements(
  config: DemoPaymentConfig,
  quote?: VersionQuote,
): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset,
    amount: quote?.amount ?? config.amount,
    payTo: quote?.payTo ?? config.payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "FACET USD", version: "2" },
  };
}

export function paymentChallenge(
  config: DemoPaymentConfig,
  versionId: string,
  fingerprint: string,
  quote?: VersionQuote,
) {
  const required: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: `http://127.0.0.1:${process.env.FACET_GATEWAY_PORT ?? "4020"}/v1/facet-versions/${versionId}/invoke?fingerprint=${fingerprint}`,
      description: "FACET demo read-only API call",
      mimeType: "application/json",
    },
    accepts: [requirements(config, quote)],
  };
  return { header: encodePaymentRequiredHeader(required), body: required };
}

export function decodeAndCheckPayment(
  header: string,
  config: DemoPaymentConfig,
  versionId: string,
  fingerprint: string,
  quote?: VersionQuote,
): PaymentPayload {
  const payload = decodePaymentSignatureHeader(header);
  const accepted = payload.accepted;
  const expected = requirements(config, quote);
  const expectedResource = paymentChallenge(
    config,
    versionId,
    fingerprint,
    quote,
  ).body.resource.url;
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

export function verifiedPaymentPayer(
  payload: PaymentPayload,
  verified: VerifyResponse,
): string {
  const raw = payload.payload as Record<string, unknown>;
  const authorization = raw.authorization as
    Record<string, unknown> | undefined;
  const payer = verified.payer;
  if (
    !verified.isValid ||
    typeof payer !== "string" ||
    !/^0x[a-f0-9]{40}$/iu.test(payer) ||
    typeof authorization?.from !== "string" ||
    authorization.from.toLowerCase() !== payer.toLowerCase()
  ) {
    throw new Error("PAYMENT_PAYER_INVALID");
  }
  return payer.toLowerCase();
}

async function facilitatorCall<T>(
  config: DemoPaymentConfig,
  operation: "verify" | "settle",
  paymentPayload: PaymentPayload,
  quote?: VersionQuote,
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
        paymentRequirements: requirements(config, quote),
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
  quote?: VersionQuote,
) => facilitatorCall<VerifyResponse>(config, "verify", payload, quote);
export const settlePayment = (
  config: DemoPaymentConfig,
  payload: PaymentPayload,
  quote?: VersionQuote,
) => facilitatorCall<SettleResponse>(config, "settle", payload, quote);

export type ContractPhase =
  "DEPOSIT" | "SETTLE_RUN" | "SETTLE_RESULT" | "REFUND";

export class FacilitatorRequestError extends Error {
  constructor(
    public readonly status: number,
    operation: string,
  ) {
    super(`FACILITATOR_${operation}_HTTP_${status}`);
  }
}

export async function contractPaymentCall(
  config: DemoPaymentConfig,
  phase: ContractPhase,
  body: Record<string, unknown>,
): Promise<{ status: "PENDING" | "CONFIRMED"; transaction: string }> {
  const response = await fetch(
    new URL(`/v1/contract/${phase}`, config.facilitatorUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-facet-facilitator-token": config.facilitatorToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    },
  );
  if (!response.ok)
    throw new FacilitatorRequestError(response.status, `CONTRACT_${phase}`);
  const result = (await response.json()) as Record<string, unknown>;
  if (
    !["PENDING", "CONFIRMED"].includes(String(result.status)) ||
    typeof result.transaction !== "string" ||
    !/^0x[0-9a-f]{64}$/iu.test(result.transaction)
  )
    throw new Error("CONTRACT_RESPONSE_INVALID");
  return result as { status: "PENDING" | "CONFIRMED"; transaction: string };
}

export async function recordReceiptCall(
  config: DemoPaymentConfig,
  body: Record<string, unknown>,
): Promise<{ status: "PENDING" | "CONFIRMED"; transaction: string }> {
  const response = await fetch(new URL("/v1/receipt", config.facilitatorUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-facet-facilitator-token": config.facilitatorToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) throw new Error("RECEIPT_CALL_FAILED");
  const result = (await response.json()) as Record<string, unknown>;
  if (
    !["PENDING", "CONFIRMED"].includes(String(result.status)) ||
    typeof result.transaction !== "string" ||
    !/^0x[0-9a-f]{64}$/iu.test(result.transaction)
  )
    throw new Error("RECEIPT_RESPONSE_INVALID");
  return result as { status: "PENDING" | "CONFIRMED"; transaction: string };
}
