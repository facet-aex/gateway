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
import { isNonLocalEnv, type PaidQuote } from "./multimodal.js";

export interface DemoPaymentConfig {
  facilitatorUrl: string;
  facilitatorToken: string;
  payTo?: string;
  feeSplitAddress?: string;
  amount: string;
}
export interface VersionQuote {
  amount: string;
  payTo: string;
}

export interface FacetVersionRef {
  provider: string;
  facetName: string;
  version: string;
}

const asset = "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f";
const network = "eip155:43113";
const ADDRESS = /^0x[a-f0-9]{40}$/iu;

function isPaidQuote(quote: VersionQuote | PaidQuote): quote is PaidQuote {
  return "pricingModel" in quote;
}

function isValidHttpsOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function readPaymentConfig(
  env: NodeJS.ProcessEnv = process.env,
): DemoPaymentConfig | undefined {
  if (env.FACET_DEMO_X402_ENABLED !== "1") return undefined;
  const nonLocal = isNonLocalEnv(env);
  if (nonLocal && !isValidHttpsOrigin(env.FACET_PUBLIC_GATEWAY_ORIGIN)) {
    throw new Error("PUBLIC_GATEWAY_ORIGIN_REQUIRED");
  }
  const facilitatorUrl = env.FACET_FACILITATOR_URL;
  const facilitatorToken = env.FACET_FACILITATOR_TOKEN;
  const payTo = env.FACET_DEMO_PAY_TO?.trim() || undefined;
  const feeSplitAddress = env.FACET_FEE_SPLIT_ADDRESS?.trim() || undefined;
  const amount = env.FACET_DEMO_AMOUNT_ATOMIC ?? "1000";
  let facilitatorHostname = "";
  if (facilitatorUrl) {
    try {
      facilitatorHostname = new URL(facilitatorUrl).hostname;
    } catch {
      facilitatorHostname = "";
    }
  }
  if (
    !facilitatorUrl ||
    !["127.0.0.1", "x402-facilitator"].includes(facilitatorHostname) ||
    !facilitatorToken ||
    facilitatorToken.length < 32 ||
    (!nonLocal && (!payTo || !ADDRESS.test(payTo))) ||
    (nonLocal && payTo !== undefined && !ADDRESS.test(payTo)) ||
    !/^[1-9][0-9]{0,5}$/u.test(amount)
  )
    throw new Error("PAYMENT_CONFIG_INVALID");
  return {
    facilitatorUrl,
    facilitatorToken,
    ...(payTo ? { payTo } : {}),
    ...(feeSplitAddress ? { feeSplitAddress } : {}),
    amount,
  };
}

export function requirements(
  config: DemoPaymentConfig,
  quote?: VersionQuote | PaidQuote,
): PaymentRequirements {
  const payTo = quote?.payTo ?? config.payTo;
  if (!payTo || !ADDRESS.test(payTo))
    throw new Error("PAYMENT_RECIPIENT_INVALID");
  if (quote && isPaidQuote(quote)) {
    const isContractRoute = config.feeSplitAddress
      ? payTo.toLowerCase() === config.feeSplitAddress.toLowerCase()
      : payTo.toLowerCase() !== quote.creatorPayTo.toLowerCase();
    return {
      scheme: "exact",
      network,
      asset,
      amount: quote.amount,
      payTo,
      maxTimeoutSeconds: 60,
      extra: {
        name: "FACET USD",
        version: "2",
        ...(isContractRoute
          ? { authorizationType: "ReceiveWithAuthorization" }
          : {}),
        pricingModel: quote.pricingModel,
        unitPriceAtomic: quote.unitPriceAtomic,
        ...(quote.pricingModel === "PAY_PER_RESULT" &&
        quote.maxItemsCap !== undefined
          ? { maxItemsCap: quote.maxItemsCap }
          : {}),
        providerPayTo: quote.creatorPayTo,
      },
    };
  }
  const isLegacyContract =
    Boolean(config.feeSplitAddress) &&
    payTo.toLowerCase() === config.feeSplitAddress!.toLowerCase();
  return {
    scheme: "exact",
    network,
    asset,
    amount: quote?.amount ?? config.amount,
    payTo,
    maxTimeoutSeconds: 60,
    extra: {
      name: "FACET USD",
      version: "2",
      ...(isLegacyContract
        ? { authorizationType: "ReceiveWithAuthorization" }
        : {}),
    },
  };
}

function challengeResourceUrl(
  target: FacetVersionRef,
  fingerprint: string,
): string {
  const publicOrigin = process.env.FACET_PUBLIC_GATEWAY_ORIGIN;
  if (isNonLocalEnv() && !isValidHttpsOrigin(publicOrigin)) {
    throw new Error("PUBLIC_GATEWAY_ORIGIN_REQUIRED");
  }
  const origin =
    publicOrigin ??
    `http://127.0.0.1:${process.env.FACET_GATEWAY_PORT ?? "4020"}`;
  return `${new URL(origin).origin}/v1/facets/${encodeURIComponent(target.provider)}/${encodeURIComponent(target.facetName)}/versions/${encodeURIComponent(target.version)}/invoke?fingerprint=${fingerprint}`;
}

export function paymentChallenge(
  config: DemoPaymentConfig,
  target: FacetVersionRef,
  fingerprint: string,
  quoteOrQuotes?: VersionQuote | PaidQuote | PaidQuote[],
) {
  const accepts = Array.isArray(quoteOrQuotes)
    ? (() => {
        if (quoteOrQuotes.length === 0) throw new Error("PAYMENT_QUOTES_EMPTY");
        return quoteOrQuotes.map((quote) => requirements(config, quote));
      })()
    : [requirements(config, quoteOrQuotes)];
  const required: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: challengeResourceUrl(target, fingerprint),
      description: "FACET paid capability execution",
      mimeType: "application/json",
    },
    accepts,
  };
  return { header: encodePaymentRequiredHeader(required), body: required };
}

export function decodeAndCheckPayment(
  header: string,
  config: DemoPaymentConfig,
  target: FacetVersionRef,
  fingerprint: string,
  quotes: PaidQuote[],
): { payload: PaymentPayload; selectedQuote: PaidQuote };
export function decodeAndCheckPayment(
  header: string,
  config: DemoPaymentConfig,
  target: FacetVersionRef,
  fingerprint: string,
  quote?: VersionQuote | PaidQuote,
): PaymentPayload;
export function decodeAndCheckPayment(
  header: string,
  config: DemoPaymentConfig,
  target: FacetVersionRef,
  fingerprint: string,
  quoteOrQuotes?: VersionQuote | PaidQuote | PaidQuote[],
): PaymentPayload | { payload: PaymentPayload; selectedQuote: PaidQuote } {
  const payload = decodePaymentSignatureHeader(header);
  const accepted = payload.accepted;
  const expectedResource = challengeResourceUrl(target, fingerprint);
  if (
    payload.x402Version !== 2 ||
    payload.resource?.url !== expectedResource ||
    !accepted ||
    typeof accepted !== "object" ||
    accepted.scheme !== "exact" ||
    accepted.network !== network ||
    typeof accepted.asset !== "string" ||
    accepted.asset.toLowerCase() !== asset.toLowerCase() ||
    typeof accepted.payTo !== "string" ||
    accepted.maxTimeoutSeconds !== 60 ||
    accepted.extra?.name !== "FACET USD" ||
    accepted.extra?.version !== "2"
  ) {
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
  }

  if (Array.isArray(quoteOrQuotes)) {
    const extra = accepted.extra as Record<string, unknown>;
    const selectedQuote = quoteOrQuotes.find((quote) => {
      const expected = requirements(config, quote);
      if (
        accepted.amount !== expected.amount ||
        accepted.payTo.toLowerCase() !== expected.payTo.toLowerCase()
      ) {
        return false;
      }
      if (extra.authorizationType !== expected.extra?.authorizationType)
        return false;
      if (extra.pricingModel !== quote.pricingModel) return false;
      if (extra.unitPriceAtomic !== quote.unitPriceAtomic) return false;
      if (
        typeof extra.providerPayTo !== "string" ||
        extra.providerPayTo.toLowerCase() !== quote.creatorPayTo.toLowerCase()
      ) {
        return false;
      }
      if (quote.pricingModel === "PAY_PER_RESULT") {
        if (extra.maxItemsCap !== quote.maxItemsCap) return false;
      } else if (extra.maxItemsCap !== undefined) {
        return false;
      }
      return true;
    });
    if (!selectedQuote) throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
    return { payload, selectedQuote };
  }

  const expected = requirements(config, quoteOrQuotes);
  if (
    accepted.amount !== expected.amount ||
    accepted.payTo.toLowerCase() !== expected.payTo.toLowerCase()
  ) {
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
  }
  if (quoteOrQuotes && isPaidQuote(quoteOrQuotes)) {
    const extra = accepted.extra as Record<string, unknown>;
    if (
      extra.authorizationType !== expected.extra?.authorizationType ||
      extra.pricingModel !== quoteOrQuotes.pricingModel ||
      extra.unitPriceAtomic !== quoteOrQuotes.unitPriceAtomic ||
      typeof extra.providerPayTo !== "string" ||
      extra.providerPayTo.toLowerCase() !==
        quoteOrQuotes.creatorPayTo.toLowerCase() ||
      (quoteOrQuotes.pricingModel === "PAY_PER_RESULT"
        ? extra.maxItemsCap !== quoteOrQuotes.maxItemsCap
        : extra.maxItemsCap !== undefined)
    ) {
      throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
    }
  }
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
  quote?: VersionQuote | PaidQuote,
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
  quote?: VersionQuote | PaidQuote,
) => facilitatorCall<VerifyResponse>(config, "verify", payload, quote);
export const settlePayment = (
  config: DemoPaymentConfig,
  payload: PaymentPayload,
  quote?: VersionQuote | PaidQuote,
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
): Promise<{
  status: "PENDING" | "CONFIRMED";
  transaction: string;
  escrowExpiresAt?: string;
  alreadyRefunded?: boolean;
}> {
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
  return result as {
    status: "PENDING" | "CONFIRMED";
    transaction: string;
    escrowExpiresAt?: string;
    alreadyRefunded?: boolean;
  };
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
