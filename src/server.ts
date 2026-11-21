import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { Pool } from "pg";
import type { PaymentPayload } from "@x402/core/types";
import {
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import {
  decodeAndCheckPayment,
  contractPaymentCall,
  FacilitatorRequestError,
  paymentChallenge,
  readPaymentConfig,
  recordReceiptCall,
  settlePayment,
  verifiedPaymentPayer,
  verifyPayment,
  type DemoPaymentConfig,
} from "./payment.js";
import {
  buildUpstreamUrl,
  executeGet,
  validateInput,
  type OperationConfig,
} from "./executor.js";
import {
  buildExecutorRequest,
  executeViaExecutor,
  isNonLocalEnv,
  quoteVersionOptions,
  signExternalApiResult,
  type FacetExecutionConfig,
  type PaidQuote,
  type PricingModel,
} from "./multimodal.js";
import { canonicalJson } from "./canonical.js";
import {
  isValidFacetName,
  isValidSemver,
  isValidUsername,
} from "./identifiers.js";
import {
  buildPaidMetadata,
  buildRefundedErrorResponse,
  computeEscrowSettlement,
  hasIdempotencyPricingConflict,
  reconstructRunQuote,
  usageProof,
  type RunSnapshotRow,
} from "./payment-flow.js";

export type ContextRow = OperationConfig &
  FacetExecutionConfig & {
    provider: string;
    facetName: string;
    facetDisplayName: string;
    version: string;
  };

export interface GatewayPool {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface BuildGatewayAppOptions {
  pool: GatewayPool;
  paymentConfig?: DemoPaymentConfig;
  feeSplitAddress?: string;
  receiptLogAddress?: string;
  maxPaymentAtomic?: bigint;
  executorUrl?: string;
  executorToken?: string;
  isNonLocal?: boolean;
  enableEscrowReconciler?: boolean;
}

const RUN_SELECT_COLUMNS =
  "id, request_fingerprint, input_hash, status, result, dataset, usage_meta, receipt_tx_hash, error_code, payment_state, payment_payload, payment_tx_hash, pricing_model, unit_price_atomic, max_items_cap, max_amount_atomic, deposit_tx_hash, refund_amount_atomic, escrow_expires_at";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function reconcileStaleEscrows(
  pool: GatewayPool,
  paymentConfig: DemoPaymentConfig,
): Promise<void> {
  const staleRows = await pool.query<{
    id: string;
    max_amount_atomic: string | null;
  }>(
    `SELECT id, max_amount_atomic
     FROM facet_demo_runs
     WHERE pricing_model='PAY_PER_RESULT'
       AND ((status='EXECUTING' AND payment_state='ESCROW_LOCKED' AND updated_at < now() - interval '60 seconds')
         OR (status='FAILED' AND payment_state IN ('ESCROW_LOCKED','PENDING')))
     ORDER BY updated_at ASC
     LIMIT 10`,
  );
  for (const row of staleRows.rows) {
    try {
      await pool.query(
        "UPDATE facet_demo_runs SET status='FAILED', payment_state='PENDING', error_code=COALESCE(error_code,'RUN_EXECUTION_UNCERTAIN'), updated_at=now() WHERE id=$1 AND status IN ('EXECUTING','FAILED')",
        [row.id],
      );
      const refund = await contractPaymentCall(paymentConfig, "REFUND", {
        runId: row.id,
      });
      await pool.query(
        "UPDATE facet_demo_runs SET payment_state=$2, payment_tx_hash=$3, refund_amount_atomic=$4, updated_at=now() WHERE id=$1",
        [
          row.id,
          refund.status === "CONFIRMED" ? "REFUNDED" : "PENDING",
          refund.transaction,
          refund.status === "CONFIRMED"
            ? (row.max_amount_atomic ?? null)
            : null,
        ],
      );
    } catch {
      /* Retry on next sweep or caller retry. */
    }
  }
}

export function buildGatewayApp(options: BuildGatewayAppOptions) {
  const {
    pool,
    paymentConfig,
    feeSplitAddress = process.env.FACET_FEE_SPLIT_ADDRESS?.trim() || undefined,
    receiptLogAddress = process.env.FACET_RECEIPT_LOG_ADDRESS?.trim() ||
      undefined,
    maxPaymentAtomic = BigInt(process.env.FACET_MAX_PAYMENT_ATOMIC ?? "100000"),
    executorUrl = process.env.FACET_EXECUTOR_URL ?? "http://127.0.0.1:4030",
    executorToken = process.env.FACET_EXECUTOR_TOKEN ?? "",
    isNonLocal = isNonLocalEnv(),
    enableEscrowReconciler = true,
  } = options;

  const app = Fastify({ logger: false, bodyLimit: 32_768 });

  if (paymentConfig && enableEscrowReconciler) {
    const timer = setInterval(() => {
      void reconcileStaleEscrows(pool, paymentConfig).catch(() => {});
    }, 30_000);
    timer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
    });
  }

  async function settleRun(
    run: RunSnapshotRow,
    config: ContextRow,
    quote: PaidQuote,
    payer: string,
    reply: import("fastify").FastifyReply,
  ) {
    if (!paymentConfig || !run.payment_payload)
      return reply.code(500).send({ error: { code: "PAYMENT_STATE_INVALID" } });
    const claim = await pool.query<{ id: string }>(
      "UPDATE facet_demo_runs SET payment_state='SETTLING', updated_at=now() WHERE id=$1 AND (payment_state IN ('VERIFIED','ESCROW_LOCKED','PENDING') OR (payment_state='SETTLING' AND updated_at < now() - interval '45 seconds')) RETURNING id",
      [run.id],
    );
    if (!claim.rows[0])
      return reply
        .code(409)
        .send({ error: { code: "SETTLEMENT_IN_PROGRESS" }, runId: run.id });
    try {
      const contractRoute =
        Boolean(feeSplitAddress) &&
        quote.payTo.toLowerCase() === feeSplitAddress!.toLowerCase();
      const proof = usageProof(run);
      let paymentTxHash = run.payment_tx_hash;
      let settled: Awaited<ReturnType<typeof settlePayment>> | undefined;
      if (contractRoute) {
        if (
          quote.pricingModel === "PAY_PER_RESULT" &&
          run.escrow_expires_at &&
          Date.now() >= Date.parse(run.escrow_expires_at)
        ) {
          const refundAmountAtomic = run.max_amount_atomic ?? quote.amount;
          const refund = await contractPaymentCall(paymentConfig, "REFUND", {
            runId: run.id,
          });
          await pool.query(
            "UPDATE facet_demo_runs SET status='FAILED', error_code='ESCROW_EXPIRED', payment_state=$2, payment_tx_hash=$3, refund_amount_atomic=$4, updated_at=now() WHERE id=$1",
            [
              run.id,
              refund.status === "CONFIRMED" ? "REFUNDED" : "PENDING",
              refund.transaction,
              refund.status === "CONFIRMED" ? refundAmountAtomic : null,
            ],
          );
          if (refund.status === "CONFIRMED") {
            return reply
              .code(502)
              .send(
                buildRefundedErrorResponse(
                  "ESCROW_EXPIRED",
                  run.id,
                  refund.transaction,
                  refundAmountAtomic,
                ),
              );
          }
          return reply.code(202).send({
            runId: run.id,
            payment: {
              status: "refund_pending",
              transaction: refund.transaction,
              escrowExpiresAt: run.escrow_expires_at,
            },
          });
        }
        const phase =
          quote.pricingModel === "PAY_PER_RESULT"
            ? "SETTLE_RESULT"
            : "SETTLE_RUN";
        const body =
          phase === "SETTLE_RUN"
            ? {
                x402Version: 2,
                runId: run.id,
                facetId: config.facetId,
                creatorPayTo: quote.creatorPayTo,
                unitPriceAtomic: quote.unitPriceAtomic,
                paymentPayload: run.payment_payload,
                paymentRequirements: paymentChallenge(
                  paymentConfig,
                  {
                    provider: config.provider,
                    facetName: config.facetName,
                    version: config.version,
                  },
                  run.request_fingerprint,
                  quote,
                ).body.accepts[0],
              }
            : {
                runId: run.id,
                inputHash: proof.inputHash,
                outputHash: proof.outputHash,
                itemCount: proof.itemCount,
                runnerSignature: proof.runnerSignature,
                ...(proof.escrowSignature
                  ? { escrowSignature: proof.escrowSignature }
                  : {}),
              };
        const phaseResult = await contractPaymentCall(
          paymentConfig,
          phase,
          body,
        );
        paymentTxHash = phaseResult.transaction;
        await pool.query(
          "UPDATE facet_demo_runs SET payment_tx_hash=$2, updated_at=now() WHERE id=$1",
          [run.id, paymentTxHash],
        );
        if (phaseResult.status !== "CONFIRMED") {
          await pool.query(
            "UPDATE facet_demo_runs SET payment_state='PENDING', updated_at=now() WHERE id=$1",
            [run.id],
          );
          return reply.code(202).send({
            runId: run.id,
            payment: {
              status: "settlement_pending",
              transaction: paymentTxHash,
              ...(run.escrow_expires_at
                ? { escrowExpiresAt: run.escrow_expires_at }
                : {}),
            },
          });
        }
      } else if (!paymentTxHash) {
        settled = await settlePayment(
          paymentConfig,
          run.payment_payload,
          quote,
        );
        if (settled.success) paymentTxHash = settled.transaction;
      }
      if (settled && !settled.success) {
        await pool.query(
          "UPDATE facet_demo_runs SET payment_state='FAILED', error_code=$2, updated_at=now() WHERE id=$1",
          [run.id, settled.errorReason ?? "SETTLEMENT_FAILED"],
        );
        return reply
          .code(502)
          .send({ error: { code: "SETTLEMENT_FAILED" }, runId: run.id });
      }
      if (!paymentTxHash) throw new Error("PAYMENT_TX_MISSING");
      await pool.query(
        "UPDATE facet_demo_runs SET payment_tx_hash=$2, updated_at=now() WHERE id=$1",
        [run.id, paymentTxHash],
      );
      if (!receiptLogAddress) throw new Error("RECEIPT_CONTRACT_MISSING");
      let receiptTxHash = run.receipt_tx_hash;
      {
        const receipt = await recordReceiptCall(paymentConfig, {
          runId: run.id,
          facetId: config.facetId,
          ...proof,
          paymentTxHash,
        });
        receiptTxHash = receipt.transaction;
        await pool.query(
          "UPDATE facet_demo_runs SET receipt_tx_hash=$2, updated_at=now() WHERE id=$1",
          [run.id, receiptTxHash],
        );
        if (receipt.status !== "CONFIRMED") {
          await pool.query(
            "UPDATE facet_demo_runs SET payment_state='PENDING', updated_at=now() WHERE id=$1",
            [run.id],
          );
          return reply.code(202).send({
            runId: run.id,
            payment: {
              status: "receipt_pending",
              transaction: paymentTxHash,
              ...(run.escrow_expires_at
                ? { escrowExpiresAt: run.escrow_expires_at }
                : {}),
            },
          });
        }
      }
      const refundAmountAtomic =
        quote.pricingModel === "PAY_PER_RESULT"
          ? computeEscrowSettlement(
              quote.unitPriceAtomic,
              run.max_amount_atomic ?? quote.amount,
              proof.itemCount,
            ).refundAmountAtomic
          : null;
      await pool.query(
        "UPDATE facet_demo_runs SET payment_state='SETTLED', payment_tx_hash=$2, refund_amount_atomic=$3, updated_at=now() WHERE id=$1",
        [run.id, paymentTxHash, refundAmountAtomic],
      );
      if (settled)
        reply.header("PAYMENT-RESPONSE", encodePaymentResponseHeader(settled));
      const settledRun: RunSnapshotRow = {
        ...run,
        payment_tx_hash: paymentTxHash,
        refund_amount_atomic: refundAmountAtomic,
      };
      return {
        runId: run.id,
        provider: config.provider,
        facetName: config.facetName,
        facetDisplayName: config.facetDisplayName,
        version: config.version,
        facetType: config.facetType,
        result: run.result,
        dataset: run.dataset ?? [],
        usage: run.usage_meta ?? undefined,
        replayed: false,
        payment: buildPaidMetadata(quote, payer, paymentTxHash, settledRun),
        receipt: { ...proof, paymentTxHash, receiptTxHash },
      };
    } catch {
      await pool.query(
        "UPDATE facet_demo_runs SET payment_state='PENDING', updated_at=now() WHERE id=$1",
        [run.id],
      );
      return reply.code(202).send({
        runId: run.id,
        payment: {
          status: "settlement_pending",
          ...(run.escrow_expires_at
            ? { escrowExpiresAt: run.escrow_expires_at }
            : {}),
        },
      });
    }
  }

  app.get("/health/live", async () => ({ service: "gateway", status: "ok" }));
  app.get<{ Params: { runId: string } }>(
    "/v1/runs/:runId/escrow",
    async (request, reply) => {
      const { runId } = request.params;
      if (!UUID_RE.test(runId))
        return reply.code(400).send({ error: { code: "INPUT_INVALID" } });
      const found = await pool.query<{
        id: string;
        status: string;
        payment_state: string;
        pricing_model: string | null;
        max_amount_atomic: string | null;
        deposit_tx_hash: string | null;
        escrow_expires_at: string | Date | null;
      }>(
        "SELECT id, status, payment_state, pricing_model, max_amount_atomic, deposit_tx_hash, escrow_expires_at FROM facet_demo_runs WHERE id=$1",
        [runId],
      );
      const row = found.rows[0];
      if (!row)
        return reply.code(404).send({ error: { code: "RUN_NOT_FOUND" } });
      const expiresAt =
        row.escrow_expires_at instanceof Date
          ? row.escrow_expires_at.toISOString()
          : (row.escrow_expires_at ?? null);
      return {
        runId: row.id,
        status: row.status,
        paymentState: row.payment_state,
        pricingModel: row.pricing_model,
        depositedAmountAtomic: row.max_amount_atomic,
        depositTxHash: row.deposit_tx_hash,
        escrowExpiresAt: expiresAt,
        contractAddress: feeSplitAddress ?? null,
      };
    },
  );
  app.post<{
    Params: { provider: string; facetName: string; version: string };
    Body: { input?: unknown; pricingModel?: unknown };
  }>(
    "/v1/facets/:provider/:facetName/versions/:version/invoke",
    async (request, reply) => {
      const { provider, facetName, version } = request.params;
      const key = request.headers["idempotency-key"];
      if (
        !isValidUsername(provider) ||
        !isValidFacetName(facetName) ||
        !isValidSemver(version) ||
        typeof key !== "string" ||
        key.length < 1 ||
        key.length > 128
      )
        return reply.code(400).send({ error: { code: "INPUT_INVALID" } });
      const input = request.body?.input;
      if (!input || typeof input !== "object" || Array.isArray(input))
        return reply.code(400).send({ error: { code: "INPUT_INVALID" } });
      const rawPricingModel = request.body?.pricingModel;
      let requestedPricingModel: PricingModel | undefined;
      if (rawPricingModel !== undefined) {
        if (
          rawPricingModel !== "PAY_PER_RUN" &&
          rawPricingModel !== "PAY_PER_RESULT"
        )
          return reply.code(400).send({ error: { code: "INPUT_INVALID" } });
        requestedPricingModel = rawPricingModel;
      }
      const context = await pool.query(
        `
    SELECT u.username AS "provider", f.facet_name AS "facetName", f.facet_display_name AS "facetDisplayName", v.version AS "version", f.id AS "facetId", v.id AS "versionId", f.type::text AS "facetType", v.actor_code AS "actorCode", v.image_digest AS "imageDigest", v.pricing_model AS "pricingModel", v.price_atomic AS "priceAtomic", v.pricing_options AS "pricingOptions", v.max_items_cap AS "maxItemsCap", v.pay_to AS "payTo", v.erc8004_token_id AS "erc8004TokenId", v.erc8004_registry AS "erc8004Registry", v.agent_task_kind AS "agentTaskKind", v.input_schema AS "inputSchema",
      e.protected_base_url AS "baseUrl", e.path_template AS "pathTemplate", e.method, e.auth_kind AS "authKind", e.auth_template AS "authTemplate", s.vault_provider AS "vaultProvider", s.vault_reference AS "vaultReference", s.status AS "secretStatus", COALESCE(e.timeout_ms,15000) AS "timeoutMs", e.max_response_bytes AS "maxResponseBytes"
    FROM facet_versions v JOIN facets f ON f.id=v.facet_id JOIN users u ON u.id=f.provider_id LEFT JOIN endpoint_configs e ON e.id=v.endpoint_config_id LEFT JOIN secret_refs s ON s.id=e.secret_ref_id AND s.provider_id=f.provider_id
    WHERE u.username=$1 AND f.facet_name=$2 AND v.version=$3 AND f.status='published' AND f.visibility IN ('public', 'unlisted') AND v.status='published' AND u.status='active'`,
        [provider, facetName, version],
      );
      const config = context.rows[0] as unknown as ContextRow | undefined;
      if (!config)
        return reply.code(404).send({ error: { code: "FACET_NOT_FOUND" } });
      const versionId = config.versionId;
      const targetRef = {
        provider: config.provider,
        facetName: config.facetName,
        version: config.version,
      };
      try {
        validateInput(config.inputSchema, input);
        if (config.facetType === "API")
          buildUpstreamUrl(config, input as Record<string, unknown>);
      } catch (error) {
        return reply
          .code(400)
          .send({ error: { code: (error as Error).message } });
      }
      const fingerprint = createHash("sha256")
        .update(canonicalJson(input))
        .digest("hex");
      const fallbackPayTo =
        !isNonLocal && config.facetType === "API"
          ? paymentConfig?.payTo
          : undefined;
      let eligibleQuotes: PaidQuote[] = [];
      if (paymentConfig) {
        try {
          const allQuotes = quoteVersionOptions(
            config,
            feeSplitAddress,
            maxPaymentAtomic,
            { isNonLocal, fallbackPayTo },
          );
          if (requestedPricingModel) {
            eligibleQuotes = allQuotes.filter(
              (q) => q.pricingModel === requestedPricingModel,
            );
            if (eligibleQuotes.length === 0)
              return reply
                .code(400)
                .send({ error: { code: "PRICING_MODEL_UNSUPPORTED" } });
          } else {
            eligibleQuotes = allQuotes;
          }
        } catch (error) {
          return reply
            .code(500)
            .send({ error: { code: (error as Error).message } });
        }
      }
      const signature = request.headers["payment-signature"];
      if (paymentConfig && typeof signature !== "string") {
        const challenge = paymentChallenge(
          paymentConfig,
          targetRef,
          fingerprint,
          eligibleQuotes,
        );
        reply.header("PAYMENT-REQUIRED", challenge.header);
        return reply.code(402).send(challenge.body);
      }
      let paymentPayload: PaymentPayload | undefined;
      let selectedQuote: PaidQuote | undefined;
      let paymentPayloadHash: string | null = null;
      let callerId = "local-demo-agent";
      if (paymentConfig) {
        try {
          paymentPayload = decodePaymentSignatureHeader(signature as string);
          paymentPayloadHash = createHash("sha256")
            .update(canonicalJson(paymentPayload))
            .digest("hex");
        } catch {
          return reply
            .code(400)
            .send({ error: { code: "PAYMENT_SIGNATURE_INVALID" } });
        }
        const known = await pool.query<{
          caller_id: string;
          facet_version_id: string;
          idempotency_key: string;
          request_fingerprint: string;
          payment_state: string;
          pricing_model: PricingModel | null;
        }>(
          `SELECT caller_id, facet_version_id, idempotency_key, request_fingerprint, payment_state, pricing_model
           FROM facet_demo_runs WHERE payment_payload_hash=$1`,
          [paymentPayloadHash],
        );
        const previous = known.rows[0];
        if (previous) {
          if (
            previous.facet_version_id !== versionId ||
            previous.idempotency_key !== key ||
            previous.payment_state === "FAILED"
          ) {
            return reply
              .code(409)
              .send({ error: { code: "PAYMENT_REPLAY_CONFLICT" } });
          }
          if (
            hasIdempotencyPricingConflict(
              previous,
              fingerprint,
              requestedPricingModel,
            )
          )
            return reply
              .code(409)
              .send({ error: { code: "IDEMPOTENCY_CONFLICT" } });
          callerId = previous.caller_id;
        }
        try {
          const checked = decodeAndCheckPayment(
            signature as string,
            paymentConfig,
            targetRef,
            fingerprint,
            eligibleQuotes,
          );
          paymentPayload = checked.payload;
          selectedQuote = checked.selectedQuote;
        } catch {
          return reply
            .code(400)
            .send({ error: { code: "PAYMENT_SIGNATURE_INVALID" } });
        }
        if (!previous) {
          try {
            const verified = await verifyPayment(
              paymentConfig,
              paymentPayload,
              selectedQuote,
            );
            callerId = verifiedPaymentPayer(paymentPayload, verified);
          } catch {
            return reply.code(402).send({ error: { code: "PAYMENT_INVALID" } });
          }
        }
      }
      let resumedRun: RunSnapshotRow | undefined;
      const existing = await pool.query(
        `SELECT ${RUN_SELECT_COLUMNS} FROM facet_demo_runs WHERE caller_id=$1 AND facet_version_id=$2 AND idempotency_key=$3`,
        [callerId, versionId, key],
      );
      if (existing.rows[0]) {
        const run = existing.rows[0] as unknown as RunSnapshotRow;
        if (
          hasIdempotencyPricingConflict(
            run,
            fingerprint,
            requestedPricingModel,
            selectedQuote?.pricingModel,
          )
        )
          return reply
            .code(409)
            .send({ error: { code: "IDEMPOTENCY_CONFLICT" } });
        const runQuote = paymentConfig
          ? reconstructRunQuote(run, config, feeSplitAddress, fallbackPayTo)
          : undefined;
        if (
          run.status === "SUCCEEDED" &&
          (!paymentConfig ||
            (run.payment_state === "SETTLED" && run.receipt_tx_hash))
        )
          return {
            runId: run.id,
            provider: config.provider,
            facetName: config.facetName,
            facetDisplayName: config.facetDisplayName,
            version: config.version,
            facetType: config.facetType,
            result: run.result,
            dataset: run.dataset ?? [],
            usage: run.usage_meta ?? undefined,
            replayed: true,
            ...(run.payment_tx_hash
              ? {
                  payment: runQuote
                    ? buildPaidMetadata(
                        runQuote,
                        callerId,
                        run.payment_tx_hash,
                        run,
                      )
                    : {
                        transaction: run.payment_tx_hash,
                        network: "eip155:43113",
                      },
                }
              : {}),
            ...(run.receipt_tx_hash && run.payment_tx_hash
              ? {
                  receipt: {
                    ...usageProof(run),
                    paymentTxHash: run.payment_tx_hash,
                    receiptTxHash: run.receipt_tx_hash,
                  },
                }
              : {}),
          };
        if (
          run.status === "SUCCEEDED" &&
          paymentConfig &&
          ["VERIFIED", "ESCROW_LOCKED", "PENDING", "SETTLING"].includes(
            run.payment_state,
          )
        )
          return settleRun(run, config, runQuote!, callerId, reply);
        if (
          run.status === "SUCCEEDED" &&
          run.payment_state === "SETTLED" &&
          !run.receipt_tx_hash
        )
          return reply
            .code(202)
            .send({ runId: run.id, payment: { status: "receipt_pending" } });
        if (
          run.status === "EXECUTING" &&
          run.payment_state === "ESCROW_LOCKED" &&
          runQuote?.pricingModel === "PAY_PER_RESULT" &&
          paymentConfig
        ) {
          const stale = await pool.query<{ id: string }>(
            "UPDATE facet_demo_runs SET status='FAILED', payment_state='PENDING', error_code='RUN_EXECUTION_UNCERTAIN', updated_at=now() WHERE id=$1 AND status='EXECUTING' AND payment_state='ESCROW_LOCKED' AND updated_at < now()-interval '45 seconds' RETURNING id",
            [run.id],
          );
          if (!stale.rows[0])
            return reply
              .code(409)
              .send({ error: { code: "RUN_IN_PROGRESS" }, runId: run.id });
          const refundAmountAtomic = runQuote.amount;
          try {
            const refund = await contractPaymentCall(paymentConfig, "REFUND", {
              runId: run.id,
            });
            await pool.query(
              "UPDATE facet_demo_runs SET payment_state=$2, payment_tx_hash=$3, refund_amount_atomic=$4, updated_at=now() WHERE id=$1",
              [
                run.id,
                refund.status === "CONFIRMED" ? "REFUNDED" : "PENDING",
                refund.transaction,
                refund.status === "CONFIRMED" ? refundAmountAtomic : null,
              ],
            );
            if (refund.status === "CONFIRMED")
              return reply
                .code(502)
                .send(
                  buildRefundedErrorResponse(
                    "RUN_EXECUTION_UNCERTAIN",
                    run.id,
                    refund.transaction,
                    refundAmountAtomic,
                  ),
                );
            return reply.code(202).send({
              runId: run.id,
              payment: {
                status: "refund_pending",
                transaction: refund.transaction,
              },
            });
          } catch {
            return reply
              .code(202)
              .send({ runId: run.id, payment: { status: "refund_pending" } });
          }
        }
        if (
          run.status === "FAILED" &&
          run.payment_state === "PENDING" &&
          runQuote?.pricingModel === "PAY_PER_RESULT" &&
          paymentConfig
        ) {
          const refundAmountAtomic = runQuote.amount;
          try {
            const refund = await contractPaymentCall(paymentConfig, "REFUND", {
              runId: run.id,
            });
            await pool.query(
              "UPDATE facet_demo_runs SET payment_state=$2, payment_tx_hash=$3, refund_amount_atomic=$4, updated_at=now() WHERE id=$1",
              [
                run.id,
                refund.status === "CONFIRMED" ? "REFUNDED" : "PENDING",
                refund.transaction,
                refund.status === "CONFIRMED" ? refundAmountAtomic : null,
              ],
            );
            if (refund.status === "CONFIRMED")
              return reply
                .code(502)
                .send(
                  buildRefundedErrorResponse(
                    run.error_code ?? "UPSTREAM_REQUEST_FAILED",
                    run.id,
                    refund.transaction,
                    refundAmountAtomic,
                  ),
                );
            return reply.code(202).send({
              runId: run.id,
              payment: {
                status: "refund_pending",
                transaction: refund.transaction,
              },
            });
          } catch {
            return reply
              .code(202)
              .send({ runId: run.id, payment: { status: "refund_pending" } });
          }
        }
        if (
          run.status === "FAILED" &&
          run.payment_state === "REFUNDED" &&
          runQuote?.pricingModel === "PAY_PER_RESULT" &&
          paymentConfig
        ) {
          if (run.payment_tx_hash) {
            return reply
              .code(502)
              .send(
                buildRefundedErrorResponse(
                  run.error_code ?? "UPSTREAM_REQUEST_FAILED",
                  run.id,
                  run.payment_tx_hash,
                  run.refund_amount_atomic ?? runQuote.amount,
                ),
              );
          }
          return reply.code(502).send({
            error: { code: run.error_code ?? "UPSTREAM_REQUEST_FAILED" },
            runId: run.id,
          });
        }
        if (
          run.status === "EXECUTING" &&
          run.payment_state === "PENDING" &&
          runQuote?.pricingModel === "PAY_PER_RESULT" &&
          run.payment_payload
        ) {
          resumedRun = run;
        } else
          return reply.code(409).send({
            error: {
              code:
                run.status === "EXECUTING"
                  ? "RUN_IN_PROGRESS"
                  : (run.error_code ?? "RUN_FAILED"),
            },
            runId: run.id,
          });
      }
      paymentPayload = resumedRun?.payment_payload ?? paymentPayload;
      const activeQuote = resumedRun
        ? reconstructRunQuote(
            resumedRun,
            config,
            feeSplitAddress,
            fallbackPayTo,
          )
        : selectedQuote;
      let depositTxHash = resumedRun?.deposit_tx_hash ?? null;
      let escrowExpiresAt = resumedRun?.escrow_expires_at ?? null;
      let inserted: { rows: Record<string, unknown>[] };
      try {
        inserted = resumedRun
          ? { rows: [resumedRun as unknown as Record<string, unknown>] }
          : await pool.query(
              `INSERT INTO facet_demo_runs (id, caller_id, facet_version_id, idempotency_key, request_fingerprint, input_hash, status, facet_type, payment_state, payment_payload, payment_payload_hash, pricing_model, unit_price_atomic, max_items_cap, max_amount_atomic) VALUES ($1,$2,$3,$4,$5,$6,'EXECUTING',$7,$8,$9::jsonb,$10,$11,$12,$13,$14) ON CONFLICT (caller_id, facet_version_id, idempotency_key) DO NOTHING RETURNING ${RUN_SELECT_COLUMNS}`,
              [
                randomUUID(),
                callerId,
                versionId,
                key,
                fingerprint,
                `sha256:${fingerprint}`,
                config.facetType,
                paymentConfig ? "VERIFIED" : "NOT_REQUIRED",
                paymentPayload ? JSON.stringify(paymentPayload) : null,
                paymentPayloadHash,
                selectedQuote?.pricingModel ?? null,
                selectedQuote?.unitPriceAtomic ?? null,
                selectedQuote?.maxItemsCap ?? null,
                selectedQuote?.amount ?? null,
              ],
            );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505"
        )
          return reply
            .code(409)
            .send({ error: { code: "PAYMENT_REPLAY_CONFLICT" } });
        throw error;
      }
      if (!inserted.rows[0]) {
        const previous = await pool.query(
          `SELECT ${RUN_SELECT_COLUMNS} FROM facet_demo_runs WHERE caller_id=$1 AND facet_version_id=$2 AND idempotency_key=$3`,
          [callerId, versionId, key],
        );
        const run = previous.rows[0]! as unknown as RunSnapshotRow;
        if (
          hasIdempotencyPricingConflict(
            run,
            fingerprint,
            requestedPricingModel,
            selectedQuote?.pricingModel,
          )
        )
          return reply
            .code(409)
            .send({ error: { code: "IDEMPOTENCY_CONFLICT" } });
        const runQuote = paymentConfig
          ? reconstructRunQuote(run, config, feeSplitAddress, fallbackPayTo)
          : undefined;
        if (run.status === "SUCCEEDED") {
          if (
            paymentConfig &&
            ["VERIFIED", "ESCROW_LOCKED", "PENDING", "SETTLING"].includes(
              run.payment_state,
            )
          )
            return settleRun(run, config, runQuote!, callerId, reply);
          if (
            paymentConfig &&
            (run.payment_state !== "SETTLED" || !run.receipt_tx_hash)
          )
            return reply.code(409).send({
              error: { code: "PAYMENT_STATE_INVALID" },
              runId: run.id,
            });
          return {
            runId: run.id,
            provider: config.provider,
            facetName: config.facetName,
            facetDisplayName: config.facetDisplayName,
            version: config.version,
            facetType: config.facetType,
            result: run.result,
            dataset: run.dataset ?? [],
            usage: run.usage_meta ?? undefined,
            replayed: true,
            ...(run.payment_tx_hash
              ? {
                  payment: runQuote
                    ? buildPaidMetadata(
                        runQuote,
                        callerId,
                        run.payment_tx_hash,
                        run,
                      )
                    : {
                        transaction: run.payment_tx_hash,
                        network: "eip155:43113",
                      },
                }
              : {}),
            ...(run.receipt_tx_hash && run.payment_tx_hash
              ? {
                  receipt: {
                    ...usageProof(run),
                    paymentTxHash: run.payment_tx_hash,
                    receiptTxHash: run.receipt_tx_hash,
                  },
                }
              : {}),
          };
        }
        if (
          run.status === "FAILED" &&
          run.payment_state === "REFUNDED" &&
          runQuote?.pricingModel === "PAY_PER_RESULT" &&
          paymentConfig
        ) {
          if (run.payment_tx_hash) {
            return reply
              .code(502)
              .send(
                buildRefundedErrorResponse(
                  run.error_code ?? "UPSTREAM_REQUEST_FAILED",
                  run.id,
                  run.payment_tx_hash,
                  run.refund_amount_atomic ?? runQuote.amount,
                ),
              );
          }
          return reply.code(502).send({
            error: { code: run.error_code ?? "UPSTREAM_REQUEST_FAILED" },
            runId: run.id,
          });
        }
        return reply.code(409).send({
          error: {
            code:
              run.status === "EXECUTING"
                ? "RUN_IN_PROGRESS"
                : (run.error_code ?? "RUN_FAILED"),
          },
          runId: run.id,
        });
      }
      const insertedRun = inserted.rows[0] as unknown as RunSnapshotRow;
      const runId = insertedRun.id;
      if (
        paymentConfig &&
        paymentPayload &&
        activeQuote?.pricingModel === "PAY_PER_RESULT"
      ) {
        try {
          const deposit = await contractPaymentCall(paymentConfig, "DEPOSIT", {
            x402Version: 2,
            runId,
            facetId: config.facetId,
            creatorPayTo: activeQuote.creatorPayTo,
            unitPriceAtomic: activeQuote.unitPriceAtomic,
            maxItemsCap: activeQuote.maxItemsCap,
            paymentPayload,
            paymentRequirements: paymentChallenge(
              paymentConfig,
              targetRef,
              fingerprint,
              activeQuote,
            ).body.accepts[0],
          });
          if (deposit.status !== "CONFIRMED") {
            await pool.query(
              "UPDATE facet_demo_runs SET payment_state='PENDING', payment_tx_hash=$2, deposit_tx_hash=$2, updated_at=now() WHERE id=$1",
              [runId, deposit.transaction],
            );
            return reply.code(202).send({
              runId,
              payment: {
                status: "escrow_pending",
                transaction: deposit.transaction,
              },
            });
          }
          depositTxHash = deposit.transaction;
          escrowExpiresAt = deposit.escrowExpiresAt ?? escrowExpiresAt;
          const claim = await pool.query<{ id: string }>(
            "UPDATE facet_demo_runs SET payment_state='ESCROW_LOCKED', payment_tx_hash=NULL, deposit_tx_hash=$2, escrow_expires_at=COALESCE($3::timestamptz, escrow_expires_at), updated_at=now() WHERE id=$1 AND payment_state IN ('VERIFIED','PENDING') RETURNING id",
            [runId, depositTxHash, escrowExpiresAt],
          );
          if (!claim.rows[0])
            return reply
              .code(409)
              .send({ error: { code: "RUN_IN_PROGRESS" }, runId });
        } catch (error) {
          if (
            error instanceof FacilitatorRequestError &&
            (error.status === 400 || error.status === 422)
          ) {
            await pool.query(
              "UPDATE facet_demo_runs SET status='FAILED', payment_state='FAILED', error_code='PAYMENT_INVALID', updated_at=now() WHERE id=$1",
              [runId],
            );
            return reply
              .code(402)
              .send({ error: { code: "PAYMENT_INVALID" }, runId });
          }
          await pool.query(
            "UPDATE facet_demo_runs SET payment_state='PENDING', updated_at=now() WHERE id=$1",
            [runId],
          );
          return reply
            .code(202)
            .send({ runId, payment: { status: "escrow_pending" } });
        }
      }
      try {
        let execution;
        if (config.facetType === "API") {
          const result = await executeGet(
            config,
            input as Record<string, unknown>,
          );
          const usage = paymentConfig
            ? await signExternalApiResult(
                runId,
                config.facetId,
                input as Record<string, unknown>,
                result,
                process.env.FACET_EXECUTOR_URL ?? "http://127.0.0.1:4030",
                process.env.FACET_EXECUTOR_TOKEN ?? "",
              )
            : null;
          execution = {
            result,
            dataset: [] as Record<string, unknown>[],
            usage,
          };
        } else {
          execution = await executeViaExecutor(
            buildExecutorRequest(
              config,
              runId,
              input as Record<string, unknown>,
            ),
            executorUrl,
            executorToken,
          );
        }
        const { result, dataset, usage } = execution;
        const inputHash = `sha256:${fingerprint}`;
        const persisted = await pool.query<{ id: string }>(
          `UPDATE facet_demo_runs SET status='SUCCEEDED', result=$2::jsonb, dataset=$3::jsonb, usage_meta=$4::jsonb, input_hash=$5, updated_at=now() WHERE id=$1 AND status='EXECUTING' RETURNING id`,
          [
            runId,
            JSON.stringify(result),
            JSON.stringify(dataset),
            usage ? JSON.stringify(usage) : null,
            inputHash,
          ],
        );
        if (!persisted.rows[0])
          return reply
            .code(202)
            .send({ runId, payment: { status: "refund_pending" } });
        if (paymentConfig && paymentPayload)
          return settleRun(
            {
              ...insertedRun,
              input_hash: inputHash,
              result,
              dataset,
              usage_meta: usage as Record<string, unknown> | null,
              payment_payload: paymentPayload,
              payment_state:
                activeQuote!.pricingModel === "PAY_PER_RESULT"
                  ? "ESCROW_LOCKED"
                  : "VERIFIED",
              pricing_model: activeQuote!.pricingModel,
              unit_price_atomic: activeQuote!.unitPriceAtomic,
              max_items_cap: activeQuote!.maxItemsCap ?? null,
              max_amount_atomic: activeQuote!.amount,
              deposit_tx_hash: depositTxHash,
              escrow_expires_at: escrowExpiresAt,
            },
            config,
            activeQuote!,
            callerId,
            reply,
          );
        return {
          runId,
          provider: config.provider,
          facetName: config.facetName,
          facetDisplayName: config.facetDisplayName,
          version: config.version,
          facetType: config.facetType,
          result,
          dataset,
          usage,
          replayed: false,
        };
      } catch (error) {
        const message = (error as Error).message;
        const code = /^(UPSTREAM_|INPUT_)[A-Z0-9_]+$/u.test(message)
          ? message
          : "UPSTREAM_REQUEST_FAILED";
        const failed = await pool.query<{ id: string }>(
          `UPDATE facet_demo_runs SET status='FAILED', error_code=$2, updated_at=now() WHERE id=$1 AND status='EXECUTING' RETURNING id`,
          [runId, code],
        );
        if (!failed.rows[0])
          return reply
            .code(202)
            .send({ runId, payment: { status: "refund_pending" } });
        if (paymentConfig && activeQuote?.pricingModel === "PAY_PER_RESULT") {
          const refundAmountAtomic = activeQuote.amount;
          try {
            const refund = await contractPaymentCall(paymentConfig, "REFUND", {
              runId,
            });
            await pool.query(
              "UPDATE facet_demo_runs SET payment_state=$2, payment_tx_hash=$3, refund_amount_atomic=$4, updated_at=now() WHERE id=$1",
              [
                runId,
                refund.status === "CONFIRMED" ? "REFUNDED" : "PENDING",
                refund.transaction,
                refund.status === "CONFIRMED" ? refundAmountAtomic : null,
              ],
            );
            if (refund.status !== "CONFIRMED")
              return reply.code(202).send({
                runId,
                payment: {
                  status: "refund_pending",
                  transaction: refund.transaction,
                },
              });
            return reply
              .code(502)
              .send(
                buildRefundedErrorResponse(
                  code,
                  runId,
                  refund.transaction,
                  refundAmountAtomic,
                ),
              );
          } catch {
            await pool.query(
              "UPDATE facet_demo_runs SET payment_state='PENDING', updated_at=now() WHERE id=$1",
              [runId],
            );
            return reply
              .code(202)
              .send({ runId, payment: { status: "refund_pending" } });
          }
        }
        return reply.code(502).send({ error: { code }, runId });
      }
    },
  );

  return app;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

async function startGatewayServer() {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: "facet-demo-gateway",
  });
  const app = buildGatewayApp({
    pool,
    paymentConfig: readPaymentConfig(),
  });
  const port = Number(process.env.FACET_GATEWAY_PORT ?? "4020");
  await app.listen({
    host: process.env.FACET_GATEWAY_HOST ?? "127.0.0.1",
    port,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().then(() => pool.end());
    });
}

if (isMainModule()) {
  await startGatewayServer();
}
