import { createHash, randomUUID } from "node:crypto";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import type { PaidQuote } from "../src/multimodal.js";
import type { DemoPaymentConfig } from "../src/payment.js";
import {
  buildPaidMetadata,
  buildRefundedErrorResponse,
  computeEscrowSettlement,
  hasIdempotencyPricingConflict,
  reconstructRunQuote,
  type RunSnapshotRow,
} from "../src/payment-flow.js";
import {
  buildGatewayApp,
  type ContextRow,
  type GatewayPool,
} from "../src/server.js";

const FEE_SPLIT = "0x0000000000000000000000000000000000000004";
const RECEIPT_LOG = "0x0000000000000000000000000000000000000005";
const CREATOR_PAY_TO = "0x0000000000000000000000000000000000000001";
const BUYER_PAYER = "0x0000000000000000000000000000000000000002";
const DEPOSIT_TX = `0x${"d".repeat(64)}`;
const SETTLE_TX = `0x${"e".repeat(64)}`;
const RECEIPT_TX = `0x${"f".repeat(64)}`;
const REFUND_TX = `0x${"c".repeat(64)}`;
const RUNNER_SIG = `0x${"1".repeat(130)}`;
const OUTPUT_HASH = `sha256:${"2".repeat(64)}`;

const PAYMENT_CONFIG: DemoPaymentConfig = {
  facilitatorUrl: "http://127.0.0.1:4022",
  facilitatorToken: "t".repeat(32),
  payTo: CREATOR_PAY_TO,
  amount: "1000",
};

function makeContext(overrides: Partial<ContextRow> = {}): ContextRow {
  return {
    provider: "alice-labs",
    facetName: "vn-tech-news-actor",
    facetDisplayName: "VN Tech News Extractor",
    version: "1.0.0",
    facetId: "019a1234-5678-7abc-8def-123456789abc",
    versionId: "019a1234-5678-7abc-8def-123456789abd",
    facetType: "ACTOR",
    actorCode: "export default async function run(input) { return []; }",
    imageDigest: `sha256:${"a".repeat(64)}`,
    pricingModel: "PAY_PER_RUN",
    priceAtomic: "1000",
    pricingOptions: [
      { model: "PAY_PER_RUN", priceAtomic: "1000", isPrimary: true },
      {
        model: "PAY_PER_RESULT",
        priceAtomic: "500",
        maxItemsCap: 10,
        isPrimary: false,
      },
    ],
    maxItemsCap: 10,
    payTo: CREATOR_PAY_TO,
    erc8004TokenId: null,
    erc8004Registry: null,
    agentTaskKind: null,
    baseUrl: "",
    pathTemplate: "",
    method: "POST",
    authKind: "none",
    timeoutMs: 15_000,
    maxResponseBytes: 1_048_576,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    ...overrides,
  };
}

interface StoredRun extends RunSnapshotRow {
  caller_id: string;
  facet_version_id: string;
  idempotency_key: string;
  facet_type: string | null;
  payment_payload_hash: string | null;
  stale_for_test?: boolean;
}

function createMockPool(
  context: ContextRow | undefined,
  options: { simulateInsertConflictRun?: StoredRun } = {},
) {
  const runs: StoredRun[] = [];
  let conflictInjected = false;

  const pool: GatewayPool = {
    async query<R = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ): Promise<{ rows: R[] }> {
      const sql = text.replace(/\s+/g, " ").trim();

      if (sql.startsWith("SELECT u.username AS")) {
        return { rows: (context ? [context] : []) as unknown as R[] };
      }

      if (sql.includes("FROM facet_demo_runs WHERE payment_payload_hash=$1")) {
        const hash = values[0] as string;
        const match = runs.find((r) => r.payment_payload_hash === hash);
        return { rows: (match ? [match] : []) as unknown as R[] };
      }

      if (
        sql.includes(
          "FROM facet_demo_runs WHERE caller_id=$1 AND facet_version_id=$2 AND idempotency_key=$3",
        )
      ) {
        const [callerId, versionId, key] = values as [string, string, string];
        const match = runs.find(
          (r) =>
            r.caller_id === callerId &&
            r.facet_version_id === versionId &&
            r.idempotency_key === key,
        );
        return { rows: (match ? [match] : []) as unknown as R[] };
      }

      if (sql.startsWith("INSERT INTO facet_demo_runs")) {
        if (options.simulateInsertConflictRun && !conflictInjected) {
          conflictInjected = true;
          runs.push(options.simulateInsertConflictRun);
          return { rows: [] };
        }
        const [
          id,
          callerId,
          versionId,
          key,
          fingerprint,
          inputHash,
          facetType,
          paymentState,
          paymentPayloadRaw,
          paymentPayloadHash,
          pricingModel,
          unitPriceAtomic,
          maxItemsCap,
          maxAmountAtomic,
        ] = values as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          "PAY_PER_RUN" | "PAY_PER_RESULT" | null,
          string | null,
          number | null,
          string | null,
        ];
        const existing = runs.find(
          (r) =>
            r.caller_id === callerId &&
            r.facet_version_id === versionId &&
            r.idempotency_key === key,
        );
        if (existing) return { rows: [] };
        const row: StoredRun = {
          id,
          caller_id: callerId,
          facet_version_id: versionId,
          idempotency_key: key,
          request_fingerprint: fingerprint,
          input_hash: inputHash,
          status: "EXECUTING",
          facet_type: facetType,
          result: null,
          error_code: null,
          payment_state: paymentState,
          payment_payload: paymentPayloadRaw
            ? (JSON.parse(paymentPayloadRaw) as PaymentPayload)
            : null,
          payment_payload_hash: paymentPayloadHash,
          payment_tx_hash: null,
          dataset: null,
          usage_meta: null,
          receipt_tx_hash: null,
          pricing_model: pricingModel,
          unit_price_atomic: unitPriceAtomic,
          max_items_cap: maxItemsCap,
          max_amount_atomic: maxAmountAtomic,
          deposit_tx_hash: null,
          refund_amount_atomic: null,
        };
        runs.push(row);
        return { rows: [{ ...row }] as unknown as R[] };
      }

      if (
        sql.startsWith("UPDATE facet_demo_runs SET payment_state='SETTLING'")
      ) {
        const run = runs.find(
          (r) =>
            r.id === values[0] &&
            ["VERIFIED", "ESCROW_LOCKED", "PENDING"].includes(r.payment_state),
        );
        if (!run) return { rows: [] };
        run.payment_state = "SETTLING";
        return { rows: [{ id: run.id }] as unknown as R[] };
      }

      if (
        sql.startsWith(
          "UPDATE facet_demo_runs SET payment_state='ESCROW_LOCKED'",
        )
      ) {
        const [id, depositTx] = values as [string, string];
        const run = runs.find(
          (r) =>
            r.id === id && ["VERIFIED", "PENDING"].includes(r.payment_state),
        );
        if (!run) return { rows: [] };
        run.payment_state = "ESCROW_LOCKED";
        run.payment_tx_hash = null;
        run.deposit_tx_hash = depositTx;
        return { rows: [{ id: run.id }] as unknown as R[] };
      }

      if (
        sql.startsWith(
          "UPDATE facet_demo_runs SET payment_state='PENDING', payment_tx_hash=$2, deposit_tx_hash=$2",
        )
      ) {
        const [id, depositTx] = values as [string, string];
        const run = runs.find((r) => r.id === id);
        if (run) {
          run.payment_state = "PENDING";
          run.payment_tx_hash = depositTx;
          run.deposit_tx_hash = depositTx;
        }
        return { rows: [] };
      }

      if (sql.startsWith("UPDATE facet_demo_runs SET status='SUCCEEDED'")) {
        const [id, resultRaw, datasetRaw, usageRaw, inputHash] = values as [
          string,
          string,
          string,
          string | null,
          string,
        ];
        const run = runs.find((r) => r.id === id && r.status === "EXECUTING");
        if (!run) return { rows: [] };
        run.status = "SUCCEEDED";
        run.result = JSON.parse(resultRaw);
        run.dataset = JSON.parse(datasetRaw) as Record<string, unknown>[];
        run.usage_meta = usageRaw
          ? (JSON.parse(usageRaw) as Record<string, unknown>)
          : null;
        run.input_hash = inputHash;
        return { rows: [{ id: run.id }] as unknown as R[] };
      }

      if (
        sql.startsWith(
          "UPDATE facet_demo_runs SET status='FAILED', payment_state='PENDING', error_code='RUN_EXECUTION_UNCERTAIN'",
        )
      ) {
        const run = runs.find(
          (r) =>
            r.id === values[0] &&
            r.status === "EXECUTING" &&
            r.payment_state === "ESCROW_LOCKED" &&
            r.stale_for_test === true,
        );
        if (!run) return { rows: [] };
        run.status = "FAILED";
        run.payment_state = "PENDING";
        run.error_code = "RUN_EXECUTION_UNCERTAIN";
        return { rows: [{ id: run.id }] as unknown as R[] };
      }

      if (
        sql.startsWith(
          "UPDATE facet_demo_runs SET status='FAILED', error_code=$2",
        )
      ) {
        const [id, code] = values as [string, string];
        const run = runs.find((r) => r.id === id && r.status === "EXECUTING");
        if (!run) return { rows: [] };
        run.status = "FAILED";
        run.error_code = code;
        return { rows: [{ id: run.id }] as unknown as R[] };
      }

      if (
        sql.startsWith(
          "UPDATE facet_demo_runs SET payment_state=$2, payment_tx_hash=$3, refund_amount_atomic=$4",
        )
      ) {
        const [id, pState, txHash, refundAmt] = values as [
          string,
          string,
          string,
          string | null,
        ];
        const run = runs.find((r) => r.id === id);
        if (run) {
          run.payment_state = pState;
          run.payment_tx_hash = txHash;
          run.refund_amount_atomic = refundAmt;
        }
        return { rows: [] };
      }

      if (
        sql.startsWith(
          "UPDATE facet_demo_runs SET payment_state='SETTLED', payment_tx_hash=$2, refund_amount_atomic=$3",
        )
      ) {
        const [id, txHash, refundAmt] = values as [
          string,
          string,
          string | null,
        ];
        const run = runs.find((r) => r.id === id);
        if (run) {
          run.payment_state = "SETTLED";
          run.payment_tx_hash = txHash;
          run.refund_amount_atomic = refundAmt;
        }
        return { rows: [] };
      }

      if (sql.startsWith("UPDATE facet_demo_runs SET payment_tx_hash=$2")) {
        const [id, txHash] = values as [string, string];
        const run = runs.find((r) => r.id === id);
        if (run) run.payment_tx_hash = txHash;
        return { rows: [] };
      }

      if (sql.startsWith("UPDATE facet_demo_runs SET receipt_tx_hash=$2")) {
        const [id, txHash] = values as [string, string];
        const run = runs.find((r) => r.id === id);
        if (run) run.receipt_tx_hash = txHash;
        return { rows: [] };
      }

      if (
        sql.startsWith("UPDATE facet_demo_runs SET payment_state='PENDING'")
      ) {
        const run = runs.find((r) => r.id === values[0]);
        if (run) run.payment_state = "PENDING";
        return { rows: [] };
      }

      throw new Error(`Unhandled mock SQL: ${sql}`);
    },
  };

  return { pool, runs };
}

function buildSignedHeader(
  challengeBody: {
    resource: { url: string; description: string; mimeType: string };
    accepts: Record<string, unknown>[];
  },
  acceptIndex: number,
  nonceSuffix = "2",
) {
  const payload = {
    x402Version: 2,
    resource: challengeBody.resource,
    accepted: challengeBody.accepts[acceptIndex]!,
    payload: {
      authorization: {
        from: BUYER_PAYER,
        nonce: `0x${nonceSuffix.repeat(64)}`,
      },
    },
  };
  return {
    payload: payload as unknown as PaymentPayload,
    header: encodePaymentSignatureHeader(payload as unknown as PaymentPayload),
  };
}

describe("payment-flow pure helpers", () => {
  it("computeEscrowSettlement mirrors Solidity for itemCount=0, itemCount=3, and itemCount=25 > cap=10", () => {
    expect(computeEscrowSettlement("500", "5000", 0)).toEqual({
      actualAmountAtomic: "0",
      refundAmountAtomic: "5000",
    });
    expect(computeEscrowSettlement("500", "5000", 3)).toEqual({
      actualAmountAtomic: "1500",
      refundAmountAtomic: "3500",
    });
    expect(computeEscrowSettlement("500", "5000", 25)).toEqual({
      actualAmountAtomic: "5000",
      refundAmountAtomic: "0",
    });
  });

  it("hasIdempotencyPricingConflict returns true on different pricingModel with identical input fingerprint and false when omitted on matching replay", () => {
    const fp = "a".repeat(64);
    const run = {
      request_fingerprint: fp,
      pricing_model: "PAY_PER_RUN" as const,
    };
    expect(hasIdempotencyPricingConflict(run, fp, undefined, undefined)).toBe(
      false,
    );
    expect(
      hasIdempotencyPricingConflict(run, fp, "PAY_PER_RUN", "PAY_PER_RUN"),
    ).toBe(false);
    expect(hasIdempotencyPricingConflict(run, fp, "PAY_PER_RESULT")).toBe(true);
    expect(
      hasIdempotencyPricingConflict(run, fp, undefined, "PAY_PER_RESULT"),
    ).toBe(true);
    expect(hasIdempotencyPricingConflict(run, "b".repeat(64))).toBe(true);
  });

  it("reconstructRunQuote & buildPaidMetadata preserve pricingModel, unitPriceAtomic, maxItemsCap, depositedAmountAtomic, refundAmountAtomic, depositTxHash", () => {
    const context = makeContext();
    const run: RunSnapshotRow = {
      id: randomUUID(),
      request_fingerprint: "a".repeat(64),
      input_hash: `sha256:${"a".repeat(64)}`,
      status: "SUCCEEDED",
      result: [{ title: "item" }],
      error_code: null,
      payment_state: "SETTLED",
      payment_payload: null,
      payment_tx_hash: SETTLE_TX,
      dataset: [{ title: "1" }, { title: "2" }, { title: "3" }],
      usage_meta: {
        itemCount: 3,
        durationMs: 42,
        outputHash: OUTPUT_HASH,
        runnerSignature: RUNNER_SIG,
      },
      receipt_tx_hash: RECEIPT_TX,
      pricing_model: "PAY_PER_RESULT",
      unit_price_atomic: "500",
      max_items_cap: 10,
      max_amount_atomic: "5000",
      deposit_tx_hash: DEPOSIT_TX,
      refund_amount_atomic: "3500",
    };

    const quote = reconstructRunQuote(run, context, FEE_SPLIT);
    expect(quote).toEqual({
      pricingModel: "PAY_PER_RESULT",
      unitPriceAtomic: "500",
      maxItemsCap: 10,
      amount: "5000",
      payTo: FEE_SPLIT,
      creatorPayTo: CREATOR_PAY_TO,
      isPrimary: false,
    });

    const meta = buildPaidMetadata(quote, BUYER_PAYER, SETTLE_TX, run);
    expect(meta).toEqual({
      transaction: SETTLE_TX,
      network: "eip155:43113",
      pricingModel: "PAY_PER_RESULT",
      amountAtomic: "1500",
      unitPriceAtomic: "500",
      maxItemsCap: 10,
      depositedAmountAtomic: "5000",
      refundAmountAtomic: "3500",
      depositTxHash: DEPOSIT_TX,
      payer: BUYER_PAYER,
      providerPayTo: CREATOR_PAY_TO,
      payTo: FEE_SPLIT,
    });

    expect(
      buildRefundedErrorResponse("EXEC_FAIL", run.id, REFUND_TX, "5000"),
    ).toEqual({
      error: { code: "EXEC_FAIL" },
      runId: run.id,
      payment: {
        status: "refunded",
        transaction: REFUND_TX,
        refundAmountAtomic: "5000",
      },
    });
  });
});

describe("gateway server invoke handler multi-pricing & escrow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unpaid 2-option returns 402 with 2 accepts; pricingModel filter returns 1 accept; unoffered pricingModel returns 400 PRICING_MODEL_UNSUPPORTED", async () => {
    const context = makeContext();
    const { pool } = createMockPool(context);
    const app = buildGatewayApp({
      pool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      isNonLocal: false,
    });

    const unpaidAll = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": randomUUID() },
      payload: { input: { query: "ai" } },
    });
    expect(unpaidAll.statusCode).toBe(402);
    const requiredAll = decodePaymentRequiredHeader(
      unpaidAll.headers["payment-required"] as string,
    );
    expect(requiredAll.accepts).toHaveLength(2);
    expect(requiredAll.accepts[0]?.extra).toMatchObject({
      pricingModel: "PAY_PER_RUN",
      unitPriceAtomic: "1000",
      providerPayTo: CREATOR_PAY_TO,
    });
    expect(requiredAll.accepts[1]?.extra).toMatchObject({
      pricingModel: "PAY_PER_RESULT",
      unitPriceAtomic: "500",
      maxItemsCap: 10,
      providerPayTo: CREATOR_PAY_TO,
    });

    const unpaidFiltered = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": randomUUID() },
      payload: { input: { query: "ai" }, pricingModel: "PAY_PER_RESULT" },
    });
    expect(unpaidFiltered.statusCode).toBe(402);
    const requiredFiltered = decodePaymentRequiredHeader(
      unpaidFiltered.headers["payment-required"] as string,
    );
    expect(requiredFiltered.accepts).toHaveLength(1);
    expect(requiredFiltered.accepts[0]?.extra?.pricingModel).toBe(
      "PAY_PER_RESULT",
    );

    const singleOptionPool = createMockPool(
      makeContext({
        pricingOptions: [
          { model: "PAY_PER_RUN", priceAtomic: "1000", isPrimary: true },
        ],
      }),
    ).pool;
    const appSingle = buildGatewayApp({
      pool: singleOptionPool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      isNonLocal: false,
    });
    const unsupported = await appSingle.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": randomUUID() },
      payload: { input: { query: "ai" }, pricingModel: "PAY_PER_RESULT" },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toEqual({
      error: { code: "PRICING_MODEL_UNSUPPORTED" },
    });
  });

  it("rejects missing payTo in non-local mode with zero FACET_DEMO_PAY_TO fallback", async () => {
    const context = makeContext({
      facetType: "API",
      payTo: null,
      baseUrl: "https://api.example.com",
      pathTemplate: "/items",
      method: "GET",
      authKind: "none",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "object",
            properties: { q: { type: "string" } },
          },
        },
      },
    });
    const { pool } = createMockPool(context);
    const nonLocalApp = buildGatewayApp({
      pool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      isNonLocal: true,
    });
    const res = await nonLocalApp.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": randomUUID() },
      payload: { input: { query: { q: "ai" } } },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: "PAYMENT_RECIPIENT_INVALID" },
    });

    const localApp = buildGatewayApp({
      pool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      isNonLocal: false,
    });
    const localRes = await localApp.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": randomUUID() },
      payload: { input: { query: { q: "ai" } } },
    });
    expect(localRes.statusCode).toBe(402);
    expect(localRes.json().accepts[0]?.extra?.providerPayTo).toBe(
      PAYMENT_CONFIG.payTo,
    );
  });

  it("PAY_PER_RESULT passes maxItemsCap to DEPOSIT, keeps depositTxHash on first 200, includes facetDisplayName, and settles clamped amount", async () => {
    const context = makeContext();
    const { pool, runs } = createMockPool(context);
    const app = buildGatewayApp({
      pool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      executorUrl: "http://127.0.0.1:4030",
      executorToken: "e".repeat(32),
      isNonLocal: false,
    });

    const key = randomUUID();
    const challengeRes = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key },
      payload: { input: { query: "ai" }, pricingModel: "PAY_PER_RESULT" },
    });
    const challengeBody = challengeRes.json();
    const { header: sigHeader } = buildSignedHeader(challengeBody, 0);

    let depositBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const targetUrl = String(url);
      if (targetUrl.endsWith("/verify")) {
        return new Response(
          JSON.stringify({ isValid: true, payer: BUYER_PAYER }),
        );
      }
      if (targetUrl.endsWith("/v1/contract/DEPOSIT")) {
        depositBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: DEPOSIT_TX }),
        );
      }
      if (targetUrl.endsWith("/v1/execute")) {
        // Return 25 items when maxItemsCap is 10 -> must clamp to 5000!
        const dataset = Array.from({ length: 25 }, (_, i) => ({ idx: i }));
        return new Response(
          JSON.stringify({
            status: "SUCCEEDED",
            result: { count: 25 },
            dataset,
            logs: [],
            usage: {
              itemCount: 25,
              durationMs: 12,
              outputHash: OUTPUT_HASH,
              runnerSignature: RUNNER_SIG,
            },
          }),
        );
      }
      if (targetUrl.endsWith("/v1/contract/SETTLE_RESULT")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: SETTLE_TX }),
        );
      }
      if (targetUrl.endsWith("/v1/receipt")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: RECEIPT_TX }),
        );
      }
      throw new Error(`Unexpected fetch: ${targetUrl}`);
    });

    const paidRes = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: {
        "idempotency-key": key,
        "payment-signature": sigHeader,
      },
      payload: { input: { query: "ai" }, pricingModel: "PAY_PER_RESULT" },
    });

    expect(paidRes.statusCode).toBe(200);
    expect(depositBody?.unitPriceAtomic).toBe("500");
    expect(depositBody?.maxItemsCap).toBe(10);
    const body = paidRes.json();
    expect(body.facetDisplayName).toBe("VN Tech News Extractor");
    expect(body.replayed).toBe(false);
    expect(body.payment).toEqual({
      transaction: SETTLE_TX,
      network: "eip155:43113",
      pricingModel: "PAY_PER_RESULT",
      amountAtomic: "5000",
      unitPriceAtomic: "500",
      maxItemsCap: 10,
      depositedAmountAtomic: "5000",
      refundAmountAtomic: "0",
      depositTxHash: DEPOSIT_TX,
      payer: BUYER_PAYER,
      providerPayTo: CREATOR_PAY_TO,
      payTo: FEE_SPLIT,
    });
    expect(runs[0]?.deposit_tx_hash).toBe(DEPOSIT_TX);
    expect(runs[0]?.refund_amount_atomic).toBe("0");
    expect(runs[0]?.input_hash).toBe(
      `sha256:${createHash("sha256")
        .update(canonicalJson({ query: "ai" }))
        .digest("hex")}`,
    );
  });

  it("crash-recovery retry on SUCCEEDED + ESCROW_LOCKED settles using persisted run snapshot and returns 200 (existing-run AND concurrent race paths)", async () => {
    const context = makeContext();
    const key = randomUUID();
    const input = { query: "recovery" };
    const fp = createHash("sha256").update(canonicalJson(input)).digest("hex");

    const { pool, runs } = createMockPool(context);
    const app = buildGatewayApp({
      pool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      executorUrl: "http://127.0.0.1:4030",
      executorToken: "e".repeat(32),
    });

    const challengeRes = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key },
      payload: { input },
    });
    const { payload, header: sigHeader } = buildSignedHeader(
      challengeRes.json(),
      1,
    );
    const payloadHash = createHash("sha256")
      .update(canonicalJson(payload))
      .digest("hex");

    runs.push({
      id: randomUUID(),
      caller_id: BUYER_PAYER,
      facet_version_id: context.versionId,
      idempotency_key: key,
      request_fingerprint: fp,
      input_hash: `sha256:${fp}`,
      status: "SUCCEEDED",
      facet_type: "ACTOR",
      result: { ok: true },
      error_code: null,
      payment_state: "ESCROW_LOCKED",
      payment_payload: payload,
      payment_payload_hash: payloadHash,
      payment_tx_hash: null,
      dataset: [{ a: 1 }, { a: 2 }, { a: 3 }],
      usage_meta: {
        itemCount: 3,
        durationMs: 10,
        outputHash: OUTPUT_HASH,
        runnerSignature: RUNNER_SIG,
      },
      receipt_tx_hash: null,
      pricing_model: "PAY_PER_RESULT",
      unit_price_atomic: "500",
      max_items_cap: 10,
      max_amount_atomic: "5000",
      deposit_tx_hash: DEPOSIT_TX,
      refund_amount_atomic: null,
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const targetUrl = String(url);
      if (targetUrl.endsWith("/verify")) {
        return new Response(
          JSON.stringify({ isValid: true, payer: BUYER_PAYER }),
        );
      }
      if (targetUrl.endsWith("/v1/contract/SETTLE_RESULT")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: SETTLE_TX }),
        );
      }
      if (targetUrl.endsWith("/v1/receipt")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: RECEIPT_TX }),
        );
      }
      throw new Error(`Unexpected fetch: ${targetUrl}`);
    });

    const recovered = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: {
        "idempotency-key": key,
        "payment-signature": sigHeader,
      },
      payload: { input },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().facetDisplayName).toBe("VN Tech News Extractor");
    expect(recovered.json().payment).toMatchObject({
      pricingModel: "PAY_PER_RESULT",
      amountAtomic: "1500",
      refundAmountAtomic: "3500",
      depositTxHash: DEPOSIT_TX,
    });

    // Now test the concurrent ON CONFLICT re-select path
    const raceKey = randomUUID();
    const raceChallenge = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": raceKey },
      payload: { input },
    });
    const { payload: racePayload, header: raceSig } = buildSignedHeader(
      raceChallenge.json(),
      1,
      "3",
    );
    const racePool = createMockPool(context, {
      simulateInsertConflictRun: {
        id: randomUUID(),
        caller_id: BUYER_PAYER,
        facet_version_id: context.versionId,
        idempotency_key: raceKey,
        request_fingerprint: fp,
        input_hash: `sha256:${fp}`,
        status: "SUCCEEDED",
        facet_type: "ACTOR",
        result: { ok: true },
        error_code: null,
        payment_state: "ESCROW_LOCKED",
        payment_payload: racePayload,
        payment_payload_hash: createHash("sha256")
          .update(canonicalJson(racePayload))
          .digest("hex"),
        payment_tx_hash: null,
        dataset: [{ a: 1 }],
        usage_meta: {
          itemCount: 1,
          durationMs: 10,
          outputHash: OUTPUT_HASH,
          runnerSignature: RUNNER_SIG,
        },
        receipt_tx_hash: null,
        pricing_model: "PAY_PER_RESULT",
        unit_price_atomic: "500",
        max_items_cap: 10,
        max_amount_atomic: "5000",
        deposit_tx_hash: DEPOSIT_TX,
        refund_amount_atomic: null,
      },
    }).pool;
    const raceApp = buildGatewayApp({
      pool: racePool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
    });
    const raceRes = await raceApp.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: {
        "idempotency-key": raceKey,
        "payment-signature": raceSig,
      },
      payload: { input },
    });
    expect(raceRes.statusCode).toBe(200);
    expect(raceRes.json().payment).toMatchObject({
      pricingModel: "PAY_PER_RESULT",
      amountAtomic: "500",
      refundAmountAtomic: "4500",
      depositTxHash: DEPOSIT_TX,
    });
  });

  it("execution failure, stale EXECUTING+ESCROW_LOCKED, FAILED+PENDING retry, and FAILED+REFUNDED replay ALL persist refund_amount_atomic and return 502 refunded proof", async () => {
    const context = makeContext();
    const { pool, runs } = createMockPool(context);
    const app = buildGatewayApp({
      pool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      executorUrl: "http://127.0.0.1:4030",
      executorToken: "e".repeat(32),
    });

    // 1. Execution failure -> REFUND confirmed -> 502 with refunded proof + replay 502
    const key1 = randomUUID();
    const input = { query: "fail" };
    const fp = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const c1 = (
      await app.inject({
        method: "POST",
        url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
        headers: { "idempotency-key": key1 },
        payload: { input, pricingModel: "PAY_PER_RESULT" },
      })
    ).json();
    const { header: sig1 } = buildSignedHeader(c1, 0, "4");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const targetUrl = String(url);
      if (targetUrl.endsWith("/verify")) {
        return new Response(
          JSON.stringify({ isValid: true, payer: BUYER_PAYER }),
        );
      }
      if (targetUrl.endsWith("/v1/contract/DEPOSIT")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: DEPOSIT_TX }),
        );
      }
      if (targetUrl.endsWith("/v1/execute")) {
        return new Response("boom", { status: 500 });
      }
      if (targetUrl.endsWith("/v1/contract/REFUND")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: REFUND_TX }),
        );
      }
      throw new Error(`Unexpected fetch: ${targetUrl}`);
    });

    const failedRes = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key1, "payment-signature": sig1 },
      payload: { input, pricingModel: "PAY_PER_RESULT" },
    });
    expect(failedRes.statusCode).toBe(502);
    expect(failedRes.json()).toEqual({
      error: { code: "UPSTREAM_REQUEST_FAILED" },
      runId: runs[0]!.id,
      payment: {
        status: "refunded",
        transaction: REFUND_TX,
        refundAmountAtomic: "5000",
      },
    });
    expect(runs[0]?.refund_amount_atomic).toBe("5000");

    // Replay FAILED + REFUNDED -> still 502 with refunded proof
    const replayFailed = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key1, "payment-signature": sig1 },
      payload: { input },
    });
    expect(replayFailed.statusCode).toBe(502);
    expect(replayFailed.json()).toEqual(failedRes.json());

    // 2. Stale EXECUTING + ESCROW_LOCKED -> 502 with refunded proof
    const key2 = randomUUID();
    const c2 = (
      await app.inject({
        method: "POST",
        url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
        headers: { "idempotency-key": key2 },
        payload: { input, pricingModel: "PAY_PER_RESULT" },
      })
    ).json();
    const { payload: p2, header: sig2 } = buildSignedHeader(c2, 0, "5");
    const staleId = randomUUID();
    runs.push({
      id: staleId,
      caller_id: BUYER_PAYER,
      facet_version_id: context.versionId,
      idempotency_key: key2,
      request_fingerprint: fp,
      input_hash: `sha256:${fp}`,
      status: "EXECUTING",
      facet_type: "ACTOR",
      result: null,
      error_code: null,
      payment_state: "ESCROW_LOCKED",
      payment_payload: p2,
      payment_payload_hash: createHash("sha256")
        .update(canonicalJson(p2))
        .digest("hex"),
      payment_tx_hash: null,
      dataset: null,
      usage_meta: null,
      receipt_tx_hash: null,
      pricing_model: "PAY_PER_RESULT",
      unit_price_atomic: "500",
      max_items_cap: 10,
      max_amount_atomic: "5000",
      deposit_tx_hash: DEPOSIT_TX,
      refund_amount_atomic: null,
      stale_for_test: true,
    });
    const staleRes = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key2, "payment-signature": sig2 },
      payload: { input },
    });
    expect(staleRes.statusCode).toBe(502);
    expect(staleRes.json()).toEqual({
      error: { code: "RUN_EXECUTION_UNCERTAIN" },
      runId: staleId,
      payment: {
        status: "refunded",
        transaction: REFUND_TX,
        refundAmountAtomic: "5000",
      },
    });
    expect(runs.find((r) => r.id === staleId)?.refund_amount_atomic).toBe(
      "5000",
    );

    // 3. FAILED + PENDING retry -> 502 with refunded proof (NOT falling through to 409!)
    const key3 = randomUUID();
    const c3 = (
      await app.inject({
        method: "POST",
        url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
        headers: { "idempotency-key": key3 },
        payload: { input, pricingModel: "PAY_PER_RESULT" },
      })
    ).json();
    const { payload: p3, header: sig3 } = buildSignedHeader(c3, 0, "6");
    const pendingRefundId = randomUUID();
    runs.push({
      id: pendingRefundId,
      caller_id: BUYER_PAYER,
      facet_version_id: context.versionId,
      idempotency_key: key3,
      request_fingerprint: fp,
      input_hash: `sha256:${fp}`,
      status: "FAILED",
      facet_type: "ACTOR",
      result: null,
      error_code: "UPSTREAM_TIMEOUT",
      payment_state: "PENDING",
      payment_payload: p3,
      payment_payload_hash: createHash("sha256")
        .update(canonicalJson(p3))
        .digest("hex"),
      payment_tx_hash: null,
      dataset: null,
      usage_meta: null,
      receipt_tx_hash: null,
      pricing_model: "PAY_PER_RESULT",
      unit_price_atomic: "500",
      max_items_cap: 10,
      max_amount_atomic: "5000",
      deposit_tx_hash: DEPOSIT_TX,
      refund_amount_atomic: null,
    });
    const pendingRefundRes = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key3, "payment-signature": sig3 },
      payload: { input },
    });
    expect(pendingRefundRes.statusCode).toBe(502);
    expect(pendingRefundRes.json()).toEqual({
      error: { code: "UPSTREAM_TIMEOUT" },
      runId: pendingRefundId,
      payment: {
        status: "refunded",
        transaction: REFUND_TX,
        refundAmountAtomic: "5000",
      },
    });
    expect(
      runs.find((r) => r.id === pendingRefundId)?.refund_amount_atomic,
    ).toBe("5000");
  });

  it("same Idempotency-Key + different pricingModel returns 409 IDEMPOTENCY_CONFLICT while keeping inputHash = sha256(canonicalJson(input))", async () => {
    const context = makeContext();
    const { pool, runs } = createMockPool(context);
    const app = buildGatewayApp({
      pool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      executorUrl: "http://127.0.0.1:4030",
      executorToken: "e".repeat(32),
    });

    const key = randomUUID();
    const input = { query: "conflict" };
    const expectedInputHash = `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;

    const c = (
      await app.inject({
        method: "POST",
        url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
        headers: { "idempotency-key": key },
        payload: { input },
      })
    ).json();
    const { header: sigRun } = buildSignedHeader(c, 0, "7");
    const { header: sigResult } = buildSignedHeader(c, 1, "8");

    let recordedInputHash: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const targetUrl = String(url);
      if (targetUrl.endsWith("/verify")) {
        return new Response(
          JSON.stringify({ isValid: true, payer: BUYER_PAYER }),
        );
      }
      if (targetUrl.endsWith("/v1/execute")) {
        return new Response(
          JSON.stringify({
            status: "SUCCEEDED",
            result: { ok: true },
            dataset: [{ ok: true }],
            logs: [],
            usage: {
              itemCount: 1,
              durationMs: 5,
              outputHash: OUTPUT_HASH,
              runnerSignature: RUNNER_SIG,
            },
          }),
        );
      }
      if (targetUrl.endsWith("/v1/contract/SETTLE_RUN")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: SETTLE_TX }),
        );
      }
      if (targetUrl.endsWith("/v1/receipt")) {
        recordedInputHash = (
          JSON.parse(String(init?.body)) as { inputHash: string }
        ).inputHash;
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: RECEIPT_TX }),
        );
      }
      throw new Error(`Unexpected fetch: ${targetUrl}`);
    });

    const firstRun = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key, "payment-signature": sigRun },
      payload: { input, pricingModel: "PAY_PER_RUN" },
    });
    expect(firstRun.statusCode).toBe(200);
    expect(recordedInputHash).toBe(expectedInputHash);
    expect(runs[0]?.input_hash).toBe(expectedInputHash);

    // Retry with SAME signature (PAY_PER_RUN) but body requesting PAY_PER_RESULT -> 409 IDEMPOTENCY_CONFLICT
    const conflictViaBody = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key, "payment-signature": sigRun },
      payload: { input, pricingModel: "PAY_PER_RESULT" },
    });
    expect(conflictViaBody.statusCode).toBe(409);
    expect(conflictViaBody.json()).toEqual({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    // Retry with NEW signature signed for PAY_PER_RESULT + same Idempotency-Key -> 409 IDEMPOTENCY_CONFLICT
    const conflictViaSig = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key, "payment-signature": sigResult },
      payload: { input },
    });
    expect(conflictViaSig.statusCode).toBe(409);
    expect(conflictViaSig.json()).toEqual({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("disambiguates identical-amount options (10000 vs 500*20) and handles DEPOSIT 202 retry + replayed 200 preserving depositTxHash", async () => {
    const context = makeContext({
      pricingOptions: [
        { model: "PAY_PER_RUN", priceAtomic: "10000", isPrimary: true },
        {
          model: "PAY_PER_RESULT",
          priceAtomic: "500",
          maxItemsCap: 20,
          isPrimary: false,
        },
      ],
      maxItemsCap: 20,
    });
    const { pool, runs } = createMockPool(context);
    const app = buildGatewayApp({
      pool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      executorUrl: "http://127.0.0.1:4030",
      executorToken: "e".repeat(32),
    });

    const key = randomUUID();
    const input = { query: "collision" };
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
        headers: { "idempotency-key": key },
        payload: { input },
      })
    ).json();
    expect(challenge.accepts).toHaveLength(2);
    expect(challenge.accepts[0].amount).toBe("10000");
    expect(challenge.accepts[1].amount).toBe("10000");

    // Sign PAY_PER_RESULT option (index 1) without passing body.pricingModel
    const { header: sigResult } = buildSignedHeader(challenge, 1, "a");

    let depositCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const targetUrl = String(url);
      if (targetUrl.endsWith("/verify")) {
        return new Response(
          JSON.stringify({ isValid: true, payer: BUYER_PAYER }),
        );
      }
      if (targetUrl.endsWith("/v1/contract/DEPOSIT")) {
        depositCalls++;
        return new Response(
          JSON.stringify({
            status: depositCalls === 1 ? "PENDING" : "CONFIRMED",
            transaction: DEPOSIT_TX,
          }),
          { status: depositCalls === 1 ? 202 : 200 },
        );
      }
      if (targetUrl.endsWith("/v1/execute")) {
        const dataset = [{ item: 1 }, { item: 2 }, { item: 3 }];
        return new Response(
          JSON.stringify({
            status: "SUCCEEDED",
            result: { count: 3 },
            dataset,
            logs: [],
            usage: {
              itemCount: 3,
              durationMs: 9,
              outputHash: OUTPUT_HASH,
              runnerSignature: RUNNER_SIG,
            },
          }),
        );
      }
      if (targetUrl.endsWith("/v1/contract/SETTLE_RESULT")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: SETTLE_TX }),
        );
      }
      if (targetUrl.endsWith("/v1/receipt")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: RECEIPT_TX }),
        );
      }
      throw new Error(`Unexpected fetch: ${targetUrl}`);
    });

    // Attempt 1 -> 202 escrow_pending
    const first = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key, "payment-signature": sigResult },
      payload: { input },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({
      runId: runs[0]!.id,
      payment: { status: "escrow_pending", transaction: DEPOSIT_TX },
    });
    expect(runs[0]?.deposit_tx_hash).toBe(DEPOSIT_TX);
    expect(runs[0]?.pricing_model).toBe("PAY_PER_RESULT");

    // Attempt 2 -> DEPOSIT confirms -> 200 with depositTxHash and partial refund (10000 - 1500 = 8500)
    const second = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key, "payment-signature": sigResult },
      payload: { input },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(false);
    expect(second.json().payment).toEqual({
      transaction: SETTLE_TX,
      network: "eip155:43113",
      pricingModel: "PAY_PER_RESULT",
      amountAtomic: "1500",
      unitPriceAtomic: "500",
      maxItemsCap: 20,
      depositedAmountAtomic: "10000",
      refundAmountAtomic: "8500",
      depositTxHash: DEPOSIT_TX,
      payer: BUYER_PAYER,
      providerPayTo: CREATOR_PAY_TO,
      payTo: FEE_SPLIT,
    });

    // Attempt 3 -> replayed: true preserving all snapshot fields & facetDisplayName
    const third = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key, "payment-signature": sigResult },
      payload: { input },
    });
    expect(third.statusCode).toBe(200);
    expect(third.json().replayed).toBe(true);
    expect(third.json().facetDisplayName).toBe("VN Tech News Extractor");
    expect(third.json().payment).toEqual(second.json().payment);
  });

  it("PAY_PER_RESULT settles itemCount=0 with amountAtomic='0' and 100% refund", async () => {
    const context = makeContext();
    const { pool, runs } = createMockPool(context);
    const app = buildGatewayApp({
      pool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      executorUrl: "http://127.0.0.1:4030",
      executorToken: "e".repeat(32),
    });

    const key = randomUUID();
    const challengeRes = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key },
      payload: { input: { query: "empty" }, pricingModel: "PAY_PER_RESULT" },
    });
    const { header: sigHeader } = buildSignedHeader(
      challengeRes.json(),
      0,
      "b",
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const targetUrl = String(url);
      if (targetUrl.endsWith("/verify")) {
        return new Response(
          JSON.stringify({ isValid: true, payer: BUYER_PAYER }),
        );
      }
      if (targetUrl.endsWith("/v1/contract/DEPOSIT")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: DEPOSIT_TX }),
        );
      }
      if (targetUrl.endsWith("/v1/execute")) {
        return new Response(
          JSON.stringify({
            status: "SUCCEEDED",
            result: [],
            dataset: [],
            logs: [],
            usage: {
              itemCount: 0,
              durationMs: 4,
              outputHash: OUTPUT_HASH,
              runnerSignature: RUNNER_SIG,
            },
          }),
        );
      }
      if (targetUrl.endsWith("/v1/contract/SETTLE_RESULT")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: SETTLE_TX }),
        );
      }
      if (targetUrl.endsWith("/v1/receipt")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: RECEIPT_TX }),
        );
      }
      throw new Error(`Unexpected fetch: ${targetUrl}`);
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/vn-tech-news-actor/versions/1.0.0/invoke",
      headers: { "idempotency-key": key, "payment-signature": sigHeader },
      payload: { input: { query: "empty" }, pricingModel: "PAY_PER_RESULT" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().payment).toEqual({
      transaction: SETTLE_TX,
      network: "eip155:43113",
      pricingModel: "PAY_PER_RESULT",
      amountAtomic: "0",
      unitPriceAtomic: "500",
      maxItemsCap: 10,
      depositedAmountAtomic: "5000",
      refundAmountAtomic: "5000",
      depositTxHash: DEPOSIT_TX,
      payer: BUYER_PAYER,
      providerPayTo: CREATOR_PAY_TO,
      payTo: FEE_SPLIT,
    });
    expect(runs[0]?.refund_amount_atomic).toBe("5000");
  });
});
