import type { FacetType } from "./identifiers.js";

export type PricingModel = "PAY_PER_RUN" | "PAY_PER_RESULT";

export interface StoredPricingOption {
  model: PricingModel;
  priceAtomic: string;
  maxItemsCap?: number | null;
  maxAmountAtomic?: string;
  payTo?: string | null;
  isPrimary?: boolean;
}

export interface PaidQuote {
  pricingModel: PricingModel;
  unitPriceAtomic: string;
  maxItemsCap?: number;
  amount: string;
  payTo: string;
  creatorPayTo: string;
  isPrimary: boolean;
}

export interface FacetExecutionConfig {
  facetId: string;
  versionId: string;
  facetType: FacetType;
  facetDisplayName?: string;
  actorCode: string | null;
  imageDigest: string | null;
  pricingModel: PricingModel;
  priceAtomic: string;
  pricingOptions?: StoredPricingOption[] | null;
  maxItemsCap?: number | null;
  payTo: string | null;
  erc8004TokenId: string | null;
  erc8004Registry: string | null;
  agentTaskKind: string | null;
  timeoutMs: number;
}

const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CANONICAL_ERC8004 = "0x8004a818bfb912233c491871b3d84c89a494bd9e";

export function isNonLocalEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === "production" ||
    (Boolean(env.FACET_ENV) && env.FACET_ENV !== "local")
  );
}

export function quoteVersionOptions(
  version: FacetExecutionConfig,
  feeSplitAddress: string | undefined,
  maxAmount: bigint,
  options?: { isNonLocal?: boolean; fallbackPayTo?: string },
): PaidQuote[] {
  const nonLocal = options?.isNonLocal ?? isNonLocalEnv();
  const normalizedFeeSplit = feeSplitAddress?.trim() || undefined;
  if (
    normalizedFeeSplit !== undefined &&
    (!ADDRESS.test(normalizedFeeSplit) ||
      normalizedFeeSplit.toLowerCase() === ZERO_ADDRESS)
  ) {
    throw new Error("PAYMENT_RECIPIENT_INVALID");
  }

  const rawOptions: StoredPricingOption[] =
    Array.isArray(version.pricingOptions) && version.pricingOptions.length > 0
      ? version.pricingOptions
      : [
          {
            model: version.pricingModel,
            priceAtomic: version.priceAtomic,
            ...(version.pricingModel === "PAY_PER_RESULT"
              ? { maxItemsCap: version.maxItemsCap ?? 20 }
              : {}),
            isPrimary: true,
          },
        ];

  const seenModels = new Set<PricingModel>();
  const quotes: PaidQuote[] = rawOptions.map((opt) => {
    if (
      !opt ||
      typeof opt !== "object" ||
      (opt.model !== "PAY_PER_RUN" && opt.model !== "PAY_PER_RESULT")
    ) {
      throw new Error("PAYMENT_PRICE_INVALID");
    }
    if (seenModels.has(opt.model)) throw new Error("PAYMENT_PRICE_INVALID");
    seenModels.add(opt.model);

    if (
      typeof opt.priceAtomic !== "string" ||
      !/^[1-9][0-9]*$/u.test(opt.priceAtomic)
    ) {
      throw new Error("PAYMENT_PRICE_INVALID");
    }

    let maxItemsCap: number | undefined;
    if (opt.model === "PAY_PER_RESULT") {
      const cap = opt.maxItemsCap ?? version.maxItemsCap ?? 20;
      if (
        typeof cap !== "number" ||
        !Number.isSafeInteger(cap) ||
        cap < 1 ||
        cap > 1000
      ) {
        throw new Error("PAYMENT_PRICE_INVALID");
      }
      maxItemsCap = cap;
    } else if (opt.maxItemsCap !== undefined && opt.maxItemsCap !== null) {
      throw new Error("PAYMENT_PRICE_INVALID");
    }

    const rawPayTo =
      (typeof opt.payTo === "string" && opt.payTo.trim()
        ? opt.payTo.trim()
        : undefined) ??
      (typeof version.payTo === "string" && version.payTo.trim()
        ? version.payTo.trim()
        : undefined) ??
      (nonLocal ? undefined : options?.fallbackPayTo?.trim() || undefined);

    if (
      !rawPayTo ||
      !ADDRESS.test(rawPayTo) ||
      rawPayTo.toLowerCase() === ZERO_ADDRESS
    ) {
      throw new Error("PAYMENT_RECIPIENT_INVALID");
    }

    const unitPrice = BigInt(opt.priceAtomic);
    const amountBig =
      opt.model === "PAY_PER_RESULT"
        ? unitPrice * BigInt(maxItemsCap!)
        : unitPrice;
    if (
      opt.maxAmountAtomic !== undefined &&
      opt.maxAmountAtomic !== null &&
      opt.maxAmountAtomic !== amountBig.toString()
    ) {
      throw new Error("PAYMENT_PRICE_INVALID");
    }
    if (amountBig > maxAmount) throw new Error("PAYMENT_AMOUNT_EXCEEDS_CAP");
    if (version.facetType !== "API" && !normalizedFeeSplit) {
      throw new Error("FEE_SPLIT_CONTRACT_REQUIRED");
    }
    if (opt.model === "PAY_PER_RESULT" && !normalizedFeeSplit) {
      throw new Error("FEE_SPLIT_CONTRACT_REQUIRED");
    }
    const payTo = normalizedFeeSplit ?? rawPayTo;
    return {
      pricingModel: opt.model,
      unitPriceAtomic: opt.priceAtomic,
      ...(maxItemsCap !== undefined ? { maxItemsCap } : {}),
      amount: amountBig.toString(),
      payTo,
      creatorPayTo: rawPayTo,
      isPrimary: opt.isPrimary === true,
    };
  });

  if (!quotes.some((quote) => quote.isPrimary)) {
    const fallbackPrimary =
      quotes.find((quote) => quote.pricingModel === "PAY_PER_RUN") ?? quotes[0];
    if (fallbackPrimary) fallbackPrimary.isPrimary = true;
  }

  return quotes;
}

export function quoteVersion(
  version: FacetExecutionConfig,
  feeSplitAddress: string | undefined,
  maxAmount: bigint,
  options?: { isNonLocal?: boolean; fallbackPayTo?: string },
) {
  const quotes = quoteVersionOptions(
    version,
    feeSplitAddress,
    maxAmount,
    options,
  );
  const primary = quotes.find((q) => q.isPrimary) ?? quotes[0]!;
  return {
    pricingModel: primary.pricingModel,
    amount: primary.amount,
    payTo: primary.payTo,
    creatorPayTo: primary.creatorPayTo,
  };
}

export function buildExecutorRequest(
  version: FacetExecutionConfig,
  runId: string,
  input: Record<string, unknown>,
) {
  const base = {
    runId,
    facetId: version.facetId,
    input,
    timeoutMs: Math.min(version.timeoutMs || 15_000, 30_000),
  };
  if (version.facetType === "ACTOR") {
    if (
      !version.actorCode ||
      !/^sha256:[0-9a-f]{64}$/iu.test(version.imageDigest ?? "")
    )
      throw new Error("ACTOR_BUNDLE_INVALID");
    return {
      ...base,
      facetType: "ACTOR" as const,
      actorBundle: {
        code: version.actorCode,
        entrypoint: "run" as const,
        imageDigest: version.imageDigest,
      },
    };
  }
  if (version.facetType === "AGENT") {
    if (
      !version.erc8004TokenId ||
      !/^[1-9][0-9]*$/u.test(version.erc8004TokenId) ||
      version.erc8004Registry?.toLowerCase() !== CANONICAL_ERC8004 ||
      !version.agentTaskKind
    )
      throw new Error("AGENT_CONFIG_INVALID");
    return {
      ...base,
      facetType: "AGENT" as const,
      agentConfig: {
        erc8004ChainId: 43113 as const,
        erc8004Registry: version.erc8004Registry,
        erc8004TokenId: version.erc8004TokenId,
        taskKind: version.agentTaskKind,
      },
    };
  }
  throw new Error("EXECUTOR_TYPE_INVALID");
}

export async function executeViaExecutor(
  request: ReturnType<typeof buildExecutorRequest>,
  url: string,
  token: string,
) {
  if (token.length < 32) throw new Error("EXECUTOR_TOKEN_MISSING");
  const response = await fetch(new URL("/v1/execute", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-facet-executor-token": token,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(request.timeoutMs + 5_000),
  });
  if (!response.ok) throw new Error("EXECUTOR_RUN_FAILED");
  const data = (await response.json()) as Record<string, unknown>;
  if (
    data.status !== "SUCCEEDED" ||
    !Array.isArray(data.dataset) ||
    !data.dataset.every(
      (item) => item && typeof item === "object" && !Array.isArray(item),
    ) ||
    !data.usage ||
    typeof data.usage !== "object" ||
    (data.usage as Record<string, unknown>).itemCount !== data.dataset.length
  )
    throw new Error("EXECUTOR_RESPONSE_INVALID");
  return data as {
    status: "SUCCEEDED";
    result: unknown;
    dataset: Record<string, unknown>[];
    logs: string[];
    usage: {
      itemCount: number;
      durationMs: number;
      outputHash: string;
      runnerSignature: string;
    };
  };
}

export async function signExternalApiResult(
  runId: string,
  facetId: string,
  input: Record<string, unknown>,
  result: unknown,
  url: string,
  token: string,
) {
  if (token.length < 32) throw new Error("EXECUTOR_TOKEN_MISSING");
  const response = await fetch(new URL("/v1/sign-external-result", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-facet-executor-token": token,
    },
    body: JSON.stringify({ runId, facetId, input, result }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("EXECUTOR_SIGNING_FAILED");
  const proof = (await response.json()) as Record<string, unknown>;
  if (
    proof.itemCount !== 1 ||
    typeof proof.inputHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/iu.test(proof.inputHash) ||
    typeof proof.outputHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/iu.test(proof.outputHash) ||
    typeof proof.runnerSignature !== "string" ||
    !/^0x[0-9a-f]{130}$/iu.test(proof.runnerSignature)
  )
    throw new Error("EXECUTOR_PROOF_INVALID");
  return proof as {
    inputHash: string;
    outputHash: string;
    itemCount: 1;
    runnerSignature: string;
  };
}
