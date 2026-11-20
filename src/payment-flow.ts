import type { PaymentPayload } from "@x402/core/types";
import type {
  FacetExecutionConfig,
  PaidQuote,
  PricingModel,
} from "./multimodal.js";

export interface RunSnapshotRow {
  id: string;
  request_fingerprint: string;
  input_hash?: string | null;
  status: string;
  result: unknown;
  error_code: string | null;
  payment_state: string;
  payment_payload: PaymentPayload | null;
  payment_tx_hash: string | null;
  dataset: Record<string, unknown>[] | null;
  usage_meta: Record<string, unknown> | null;
  receipt_tx_hash: string | null;
  pricing_model?: PricingModel | null;
  unit_price_atomic?: string | null;
  max_items_cap?: number | null;
  max_amount_atomic?: string | null;
  deposit_tx_hash?: string | null;
  refund_amount_atomic?: string | null;
}

export interface InvokeFacetPaymentV016 {
  transaction: string;
  network: "eip155:43113";
  pricingModel: PricingModel;
  amountAtomic: string;
  unitPriceAtomic?: string;
  maxItemsCap?: number;
  depositedAmountAtomic?: string;
  refundAmountAtomic?: string;
  depositTxHash?: string;
  payer: string;
  providerPayTo: string;
  payTo?: string;
}

export interface InvokeFacetRefundedErrorResponse {
  error: {
    code: string;
    message?: string;
  };
  runId: string;
  payment?: {
    status: "refunded";
    transaction: string;
    refundAmountAtomic: string;
  };
}

const ADDRESS = /^0x[0-9a-f]{40}$/iu;

export function usageProof(
  run: Pick<
    RunSnapshotRow,
    "request_fingerprint" | "input_hash" | "usage_meta"
  >,
) {
  const usage = run.usage_meta;
  if (
    !usage ||
    !Number.isSafeInteger(usage.itemCount) ||
    Number(usage.itemCount) < 0 ||
    typeof usage.outputHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/iu.test(usage.outputHash) ||
    typeof usage.runnerSignature !== "string" ||
    !/^0x[0-9a-f]{130}$/iu.test(usage.runnerSignature)
  ) {
    throw new Error("RUN_USAGE_INVALID");
  }
  const inputHash =
    run.input_hash && /^sha256:[0-9a-f]{64}$/iu.test(run.input_hash)
      ? run.input_hash
      : run.input_hash && /^[0-9a-f]{64}$/iu.test(run.input_hash)
        ? `sha256:${run.input_hash}`
        : `sha256:${run.request_fingerprint}`;
  return {
    inputHash,
    outputHash: usage.outputHash,
    itemCount: Number(usage.itemCount),
    runnerSignature: usage.runnerSignature,
  };
}

export function computeEscrowSettlement(
  unitPriceAtomic: string,
  maxAmountAtomic: string,
  itemCount: number,
): { actualAmountAtomic: string; refundAmountAtomic: string } {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new Error("RUN_USAGE_INVALID");
  }
  const unitPrice = BigInt(unitPriceAtomic);
  const maxAmount = BigInt(maxAmountAtomic);
  const rawActual = unitPrice * BigInt(itemCount);
  const actual = rawActual > maxAmount ? maxAmount : rawActual;
  const refund = maxAmount - actual;
  return {
    actualAmountAtomic: actual.toString(),
    refundAmountAtomic: refund.toString(),
  };
}

export function reconstructRunQuote(
  run: RunSnapshotRow,
  config: Pick<
    FacetExecutionConfig,
    "pricingModel" | "priceAtomic" | "pricingOptions" | "maxItemsCap" | "payTo"
  >,
  feeSplitAddress?: string,
  fallbackPayTo?: string,
): PaidQuote {
  const acceptedExtra = (
    run.payment_payload?.accepted as
      { extra?: Record<string, unknown> } | undefined
  )?.extra;
  const extraPricingModel =
    acceptedExtra?.pricingModel === "PAY_PER_RUN" ||
    acceptedExtra?.pricingModel === "PAY_PER_RESULT"
      ? acceptedExtra.pricingModel
      : undefined;

  const pricingModel: PricingModel =
    run.pricing_model === "PAY_PER_RUN" ||
    run.pricing_model === "PAY_PER_RESULT"
      ? run.pricing_model
      : (extraPricingModel ?? config.pricingModel);

  const optionMatch = Array.isArray(config.pricingOptions)
    ? config.pricingOptions.find((opt) => opt.model === pricingModel)
    : undefined;

  const unitPriceAtomic =
    run.unit_price_atomic ??
    (typeof acceptedExtra?.unitPriceAtomic === "string"
      ? acceptedExtra.unitPriceAtomic
      : undefined) ??
    optionMatch?.priceAtomic ??
    config.priceAtomic;

  const maxItemsCap =
    pricingModel === "PAY_PER_RESULT"
      ? (run.max_items_cap ??
        (typeof acceptedExtra?.maxItemsCap === "number"
          ? acceptedExtra.maxItemsCap
          : undefined) ??
        optionMatch?.maxItemsCap ??
        config.maxItemsCap ??
        20)
      : undefined;

  const amount =
    run.max_amount_atomic ??
    (pricingModel === "PAY_PER_RESULT"
      ? (BigInt(unitPriceAtomic) * BigInt(maxItemsCap!)).toString()
      : unitPriceAtomic);

  const creatorPayTo =
    (typeof optionMatch?.payTo === "string" && optionMatch.payTo.trim()
      ? optionMatch.payTo.trim()
      : undefined) ??
    (typeof config.payTo === "string" && config.payTo.trim()
      ? config.payTo.trim()
      : undefined) ??
    (typeof acceptedExtra?.providerPayTo === "string" &&
    ADDRESS.test(acceptedExtra.providerPayTo)
      ? acceptedExtra.providerPayTo
      : undefined) ??
    fallbackPayTo;

  if (!creatorPayTo || !ADDRESS.test(creatorPayTo)) {
    throw new Error("PAYMENT_RECIPIENT_INVALID");
  }

  const normalizedFeeSplit = feeSplitAddress?.trim() || undefined;
  const acceptedPayTo =
    typeof run.payment_payload?.accepted?.payTo === "string" &&
    ADDRESS.test(run.payment_payload.accepted.payTo)
      ? run.payment_payload.accepted.payTo
      : undefined;

  const payTo = acceptedPayTo ?? normalizedFeeSplit ?? creatorPayTo;
  const isPrimary =
    optionMatch?.isPrimary ?? pricingModel === config.pricingModel;

  return {
    pricingModel,
    unitPriceAtomic,
    ...(maxItemsCap !== undefined ? { maxItemsCap } : {}),
    amount,
    payTo,
    creatorPayTo,
    isPrimary,
  };
}

export function hasIdempotencyPricingConflict(
  run: Pick<RunSnapshotRow, "request_fingerprint" | "pricing_model">,
  fingerprint: string,
  requestedPricingModel?: PricingModel,
  selectedPricingModel?: PricingModel,
): boolean {
  if (run.request_fingerprint !== fingerprint) return true;
  if (
    run.pricing_model === "PAY_PER_RUN" ||
    run.pricing_model === "PAY_PER_RESULT"
  ) {
    if (
      requestedPricingModel !== undefined &&
      requestedPricingModel !== run.pricing_model
    ) {
      return true;
    }
    if (
      selectedPricingModel !== undefined &&
      selectedPricingModel !== run.pricing_model
    ) {
      return true;
    }
  }
  return false;
}

export function buildPaidMetadata(
  quote: PaidQuote,
  payer: string,
  transaction: string,
  run: RunSnapshotRow,
): InvokeFacetPaymentV016 {
  if (quote.pricingModel === "PAY_PER_RESULT") {
    const depositedAmountAtomic = run.max_amount_atomic ?? quote.amount;
    const settlement = computeEscrowSettlement(
      quote.unitPriceAtomic,
      depositedAmountAtomic,
      usageProof(run).itemCount,
    );
    const refundAmountAtomic =
      run.refund_amount_atomic ?? settlement.refundAmountAtomic;
    const maxItemsCap = quote.maxItemsCap ?? run.max_items_cap ?? 20;
    return {
      transaction,
      network: "eip155:43113",
      pricingModel: "PAY_PER_RESULT",
      amountAtomic: settlement.actualAmountAtomic,
      unitPriceAtomic: quote.unitPriceAtomic,
      maxItemsCap,
      depositedAmountAtomic,
      refundAmountAtomic,
      ...(run.deposit_tx_hash ? { depositTxHash: run.deposit_tx_hash } : {}),
      payer,
      providerPayTo: quote.creatorPayTo,
      payTo: quote.payTo,
    };
  }
  return {
    transaction,
    network: "eip155:43113",
    pricingModel: "PAY_PER_RUN",
    amountAtomic: quote.amount,
    payer,
    providerPayTo: quote.creatorPayTo,
    payTo: quote.payTo,
  };
}

export function buildRefundedErrorResponse(
  errorCode: string,
  runId: string,
  refundTxHash: string,
  refundAmountAtomic: string,
): InvokeFacetRefundedErrorResponse {
  return {
    error: { code: errorCode },
    runId,
    payment: {
      status: "refunded",
      transaction: refundTxHash,
      refundAmountAtomic,
    },
  };
}
