import { createHash, randomUUID } from "node:crypto";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import {
  requirements,
  type DemoPaymentConfig,
  type FacetVersionRef,
} from "../src/payment.js";
import {
  buildPaidMetadata,
  usageProof,
  type RunSnapshotRow,
} from "../src/payment-flow.js";
import {
  buildGatewayApp,
  reconcileStaleEscrows,
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
const ESCROW_SIG = `0x${"9".repeat(130)}`;
const OUTPUT_HASH = `sha256:${"2".repeat(64)}`;

const PAYMENT_CONFIG: DemoPaymentConfig = {
  facilitatorUrl: "http://127.0.0.1:4022",
  facilitatorToken: "t".repeat(32),
  feeSplitAddress: FEE_SPLIT,
  amount: "1000",
};

const TARGET: FacetVersionRef = {
  provider: "alice-labs",
  facetName: "vn-tech-news-actor",
  version: "1.0.0",
};

function makeContext(): ContextRow {
  return {
    provider: TARGET.provider,
    facetName: TARGET.facetName,
    facetDisplayName: "VN Tech News",
    version: TARGET.version,
    facetId: "019a1234-5678-7abc-8def-123456789abc",
    versionId: "019a1234-5678-7abc-8def-123456789abd",
    facetType: "ACTOR",
    actorCode: "export default async function run(input) { return []; }",
    imageDigest: `sha256:${"a".repeat(64)}`,
    pricingModel: "PAY_PER_RESULT",
    priceAtomic: "500",
    pricingOptions: [
      {
        model: "PAY_PER_RESULT",
        priceAtomic: "500",
        maxItemsCap: 10,
        isPrimary: true,
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
  };
}

describe("Gateway ReceiveWithAuthorization & Escrow Timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits extra.authorizationType=ReceiveWithAuthorization for contract quotes and omits it for direct EOA", () => {
    const contractReq = requirements(PAYMENT_CONFIG, {
      pricingModel: "PAY_PER_RESULT",
      unitPriceAtomic: "500",
      maxItemsCap: 10,
      amount: "5000",
      payTo: FEE_SPLIT,
      creatorPayTo: CREATOR_PAY_TO,
      isPrimary: true,
    });
    expect(contractReq.extra?.authorizationType).toBe(
      "ReceiveWithAuthorization",
    );

    const directReq = requirements(
      {
        facilitatorUrl: "http://127.0.0.1:4022",
        facilitatorToken: "t".repeat(32),
        amount: "1000",
      },
      {
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "1000",
        amount: "1000",
        payTo: CREATOR_PAY_TO,
        creatorPayTo: CREATOR_PAY_TO,
        isPrimary: true,
      },
    );
    expect(directReq.extra?.authorizationType).toBeUndefined();
  });

  it("extracts escrowSignature in usageProof and includes escrowExpiresAt in buildPaidMetadata", () => {
    const proof = usageProof({
      request_fingerprint: "a".repeat(64),
      input_hash: `sha256:${"a".repeat(64)}`,
      usage_meta: {
        itemCount: 3,
        outputHash: OUTPUT_HASH,
        runnerSignature: RUNNER_SIG,
        escrowSignature: ESCROW_SIG,
      },
    });
    expect(proof.runnerSignature).toBe(RUNNER_SIG);
    expect(proof.escrowSignature).toBe(ESCROW_SIG);

    const paid = buildPaidMetadata(
      {
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 10,
        amount: "5000",
        payTo: FEE_SPLIT,
        creatorPayTo: CREATOR_PAY_TO,
        isPrimary: true,
      },
      BUYER_PAYER,
      SETTLE_TX,
      {
        id: randomUUID(),
        request_fingerprint: "a".repeat(64),
        status: "SUCCEEDED",
        result: [],
        error_code: null,
        payment_state: "SETTLED",
        payment_payload: null,
        payment_tx_hash: SETTLE_TX,
        dataset: [],
        usage_meta: {
          itemCount: 3,
          outputHash: OUTPUT_HASH,
          runnerSignature: RUNNER_SIG,
          escrowSignature: ESCROW_SIG,
        },
        receipt_tx_hash: RECEIPT_TX,
        deposit_tx_hash: DEPOSIT_TX,
        escrow_expires_at: "2027-01-15T08:15:00.000Z",
      },
    );
    expect(paid.escrowExpiresAt).toBe("2027-01-15T08:15:00.000Z");
  });

  it("persists escrow_expires_at on DEPOSIT, sends escrowSignature to SETTLE_RESULT, and exposes GET /v1/runs/:runId/escrow", async () => {
    const ctx = makeContext();
    const runs: Array<
      RunSnapshotRow & {
        caller_id: string;
        facet_version_id: string;
        idempotency_key: string;
        payment_payload_hash: string | null;
      }
    > = [];
    const pool: GatewayPool = {
      async query<R = Record<string, unknown>>(
        sql: string,
        values: unknown[] = [],
      ): Promise<{ rows: R[] }> {
        const q = sql.replace(/\s+/g, " ").trim();
        if (q.startsWith("SELECT u.username AS"))
          return { rows: [ctx] as unknown as R[] };
        if (q.includes("FROM facet_demo_runs WHERE payment_payload_hash=$1"))
          return { rows: [] };
        if (q.includes("FROM facet_demo_runs WHERE caller_id=$1"))
          return { rows: [] };
        if (q.includes("FROM facet_demo_runs WHERE id=$1")) {
          const found = runs.find((r) => r.id === values[0]);
          return { rows: (found ? [found] : []) as unknown as R[] };
        }
        if (q.startsWith("INSERT INTO facet_demo_runs")) {
          const row = {
            id: values[0] as string,
            caller_id: values[1] as string,
            facet_version_id: values[2] as string,
            idempotency_key: values[3] as string,
            request_fingerprint: values[4] as string,
            input_hash: values[5] as string,
            status: "EXECUTING",
            result: null,
            error_code: null,
            payment_state: values[7] as string,
            payment_payload: values[8] ? JSON.parse(values[8] as string) : null,
            payment_payload_hash: values[9] as string,
            payment_tx_hash: null,
            dataset: null,
            usage_meta: null,
            receipt_tx_hash: null,
            pricing_model: values[10] as "PAY_PER_RESULT",
            unit_price_atomic: values[11] as string,
            max_items_cap: values[12] as number,
            max_amount_atomic: values[13] as string,
            deposit_tx_hash: null,
            refund_amount_atomic: null,
            escrow_expires_at: null,
          };
          runs.push(row);
          return { rows: [row] as unknown as R[] };
        }
        if (
          q.startsWith(
            "UPDATE facet_demo_runs SET payment_state='ESCROW_LOCKED'",
          )
        ) {
          const r = runs.find((x) => x.id === values[0]);
          if (!r) return { rows: [] };
          r.payment_state = "ESCROW_LOCKED";
          r.deposit_tx_hash = values[1] as string;
          if (values[2]) r.escrow_expires_at = values[2] as string;
          return { rows: [{ id: r.id }] as unknown as R[] };
        }
        if (q.startsWith("UPDATE facet_demo_runs SET status='SUCCEEDED'")) {
          const r = runs.find((x) => x.id === values[0]);
          if (!r) return { rows: [] };
          r.status = "SUCCEEDED";
          r.result = JSON.parse(values[1] as string);
          r.dataset = JSON.parse(values[2] as string);
          r.usage_meta = JSON.parse(values[3] as string);
          r.input_hash = values[4] as string;
          return { rows: [{ id: r.id }] as unknown as R[] };
        }
        if (
          q.startsWith("UPDATE facet_demo_runs SET payment_state='SETTLING'")
        ) {
          const r = runs.find((x) => x.id === values[0]);
          if (!r) return { rows: [] };
          r.payment_state = "SETTLING";
          return { rows: [{ id: r.id }] as unknown as R[] };
        }
        if (q.startsWith("UPDATE facet_demo_runs SET payment_tx_hash=$2")) {
          const r = runs.find((x) => x.id === values[0]);
          if (r) r.payment_tx_hash = values[1] as string;
          return { rows: [] };
        }
        if (q.startsWith("UPDATE facet_demo_runs SET receipt_tx_hash=$2")) {
          const r = runs.find((x) => x.id === values[0]);
          if (r) r.receipt_tx_hash = values[1] as string;
          return { rows: [] };
        }
        if (
          q.startsWith("UPDATE facet_demo_runs SET payment_state='SETTLED'")
        ) {
          const r = runs.find((x) => x.id === values[0]);
          if (r) {
            r.payment_state = "SETTLED";
            r.payment_tx_hash = values[1] as string;
            r.refund_amount_atomic = values[2] as string;
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const settleBodies: Record<string, unknown>[] = [];
    const expiresAtIso = "2027-01-15T08:15:00.000Z";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith("/verify")) {
        return new Response(
          JSON.stringify({ isValid: true, payer: BUYER_PAYER }),
        );
      }
      if (url.endsWith("/v1/contract/DEPOSIT")) {
        return new Response(
          JSON.stringify({
            status: "CONFIRMED",
            transaction: DEPOSIT_TX,
            escrowExpiresAt: expiresAtIso,
          }),
        );
      }
      if (url.endsWith("/v1/execute")) {
        return new Response(
          JSON.stringify({
            status: "SUCCEEDED",
            result: [{ title: "item1" }],
            dataset: [{ title: "item1" }],
            usage: {
              itemCount: 1,
              durationMs: 25,
              outputHash: OUTPUT_HASH,
              runnerSignature: RUNNER_SIG,
              escrowSignature: ESCROW_SIG,
            },
          }),
        );
      }
      if (url.endsWith("/v1/contract/SETTLE_RESULT")) {
        settleBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: SETTLE_TX }),
        );
      }
      if (url.endsWith("/v1/receipt")) {
        return new Response(
          JSON.stringify({ status: "CONFIRMED", transaction: RECEIPT_TX }),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const app = buildGatewayApp({
      pool,
      paymentConfig: PAYMENT_CONFIG,
      feeSplitAddress: FEE_SPLIT,
      receiptLogAddress: RECEIPT_LOG,
      maxPaymentAtomic: 100_000n,
      executorUrl: "http://127.0.0.1:4030",
      executorToken: "e".repeat(32),
      isNonLocal: false,
      enableEscrowReconciler: false,
    });

    const invokePath = `/v1/facets/${TARGET.provider}/${TARGET.facetName}/versions/${TARGET.version}/invoke`;
    const first = await app.inject({
      method: "POST",
      url: invokePath,
      headers: { "idempotency-key": "k-1" },
      payload: { input: { query: "ai" } },
    });
    expect(first.statusCode).toBe(402);
    const required = decodePaymentRequiredHeader(
      first.headers["payment-required"] as string,
    );
    expect(required.accepts[0]?.extra?.authorizationType).toBe(
      "ReceiveWithAuthorization",
    );

    const sigHeader = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted: required.accepts[0]!,
      payload: {
        authorization: {
          from: BUYER_PAYER,
          to: FEE_SPLIT,
          value: "5000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"a".repeat(64)}`,
        },
        signature: `0x${"b".repeat(130)}`,
      },
    });

    const paid = await app.inject({
      method: "POST",
      url: invokePath,
      headers: { "idempotency-key": "k-1", "payment-signature": sigHeader },
      payload: { input: { query: "ai" } },
    });
    expect(paid.statusCode).toBe(200);
    const body = paid.json();
    expect(body.payment.escrowExpiresAt).toBe(expiresAtIso);
    expect(settleBodies[0]?.escrowSignature).toBe(ESCROW_SIG);

    const statusRes = await app.inject({
      method: "GET",
      url: `/v1/runs/${body.runId}/escrow`,
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toMatchObject({
      runId: body.runId,
      paymentState: "SETTLED",
      escrowExpiresAt: expiresAtIso,
      contractAddress: FEE_SPLIT,
    });

    await app.close();
  });

  it("reconcileStaleEscrows refunds stale EXECUTING + ESCROW_LOCKED runs", async () => {
    const staleRunId = randomUUID();
    let updatedState = "";
    let updatedRefund = "";
    const pool: GatewayPool = {
      async query<R = Record<string, unknown>>(
        sql: string,
        values: unknown[] = [],
      ): Promise<{ rows: R[] }> {
        const q = sql.replace(/\s+/g, " ").trim();
        if (q.includes("WHERE pricing_model='PAY_PER_RESULT'")) {
          return {
            rows: [
              { id: staleRunId, max_amount_atomic: "5000" },
            ] as unknown as R[],
          };
        }
        if (
          q.startsWith(
            "UPDATE facet_demo_runs SET status='FAILED', payment_state='PENDING'",
          )
        ) {
          return { rows: [{ id: staleRunId }] as unknown as R[] };
        }
        if (q.startsWith("UPDATE facet_demo_runs SET payment_state=$2")) {
          updatedState = String(values[1]);
          updatedRefund = String(values[3]);
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "CONFIRMED",
          transaction: REFUND_TX,
          alreadyRefunded: true,
        }),
      ),
    );

    await reconcileStaleEscrows(pool, PAYMENT_CONFIG);
    expect(updatedState).toBe("REFUNDED");
    expect(updatedRefund).toBe("5000");
  });
});
