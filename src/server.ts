import { createHash, randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import Fastify from "fastify";
import { Pool } from "pg";
import type { PaymentPayload } from "@x402/core/types";
import { encodePaymentResponseHeader } from "@x402/core/http";
import {
  decodeAndCheckPayment,
  paymentChallenge,
  readPaymentConfig,
  settlePayment,
  verifyPayment,
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
  quoteVersion,
  signExternalApiResult,
  type FacetExecutionConfig,
} from "./multimodal.js";
import { canonicalJson } from "./canonical.js";

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
const app = Fastify({ logger: false, bodyLimit: 32_768 });
const paymentConfig = readPaymentConfig();
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ContextRow extends OperationConfig, FacetExecutionConfig {}
interface RunRow {
  id: string;
  request_fingerprint: string;
  status: string;
  result: unknown;
  error_code: string | null;
  payment_state: string;
  payment_payload: PaymentPayload | null;
  payment_tx_hash: string | null;
  dataset: Record<string, unknown>[] | null;
  usage_meta: Record<string, unknown> | null;
  receipt_tx_hash: string | null;
}

async function settleRun(
  run: RunRow,
  versionId: string,
  quote: { amount: string; payTo: string },
  reply: import("fastify").FastifyReply,
) {
  if (!paymentConfig || !run.payment_payload)
    return reply.code(500).send({ error: { code: "PAYMENT_STATE_INVALID" } });
  const claim = await pool.query(
    "UPDATE facet_demo_runs SET payment_state='SETTLING', updated_at=now() WHERE id=$1 AND (payment_state IN ('VERIFIED','PENDING') OR (payment_state='SETTLING' AND updated_at < now() - interval '45 seconds')) RETURNING id",
    [run.id],
  );
  if (!claim.rows[0])
    return reply
      .code(409)
      .send({ error: { code: "SETTLEMENT_IN_PROGRESS" }, runId: run.id });
  try {
    const settled = await settlePayment(
      paymentConfig,
      run.payment_payload,
      quote,
    );
    if (!settled.success) {
      await pool.query(
        "UPDATE facet_demo_runs SET payment_state='FAILED', error_code=$2, updated_at=now() WHERE id=$1",
        [run.id, settled.errorReason ?? "SETTLEMENT_FAILED"],
      );
      return reply
        .code(502)
        .send({ error: { code: "SETTLEMENT_FAILED" }, runId: run.id });
    }
    await pool.query(
      "UPDATE facet_demo_runs SET payment_state='SETTLED', payment_tx_hash=$2, updated_at=now() WHERE id=$1",
      [run.id, settled.transaction],
    );
    reply.header("PAYMENT-RESPONSE", encodePaymentResponseHeader(settled));
    return {
      runId: run.id,
      facetVersionId: versionId,
      result: run.result,
      dataset: run.dataset ?? [],
      usage: run.usage_meta ?? undefined,
      replayed: false,
      payment: { transaction: settled.transaction, network: settled.network },
    };
  } catch {
    await pool.query(
      "UPDATE facet_demo_runs SET payment_state='PENDING', updated_at=now() WHERE id=$1",
      [run.id],
    );
    return reply
      .code(202)
      .send({ runId: run.id, payment: { status: "settlement_pending" } });
  }
}

app.get("/health/live", async () => ({ service: "gateway", status: "ok" }));
app.post<{ Params: { versionId: string }; Body: { input?: unknown } }>(
  "/v1/facet-versions/:versionId/invoke",
  async (request, reply) => {
    const { versionId } = request.params;
    const key = request.headers["idempotency-key"];
    if (
      !idPattern.test(versionId) ||
      typeof key !== "string" ||
      key.length < 1 ||
      key.length > 128
    )
      return reply.code(400).send({ error: { code: "INPUT_INVALID" } });
    const input = request.body?.input;
    if (!input || typeof input !== "object" || Array.isArray(input))
      return reply.code(400).send({ error: { code: "INPUT_INVALID" } });
    const context = await pool.query<ContextRow>(
      `
    SELECT f.id AS "facetId", v.id AS "versionId", f.type AS "facetType", v.actor_code AS "actorCode", v.image_digest AS "imageDigest", v.pricing_model AS "pricingModel", v.price_atomic AS "priceAtomic", v.pay_to AS "payTo", v.erc8004_token_id AS "erc8004TokenId", v.erc8004_registry AS "erc8004Registry", v.agent_task_kind AS "agentTaskKind", e.protected_base_url AS "baseUrl", e.path_template AS "pathTemplate", e.method, e.auth_kind AS "authKind", e.auth_template AS "authTemplate", s.vault_provider AS "vaultProvider", s.vault_reference AS "vaultReference", s.status AS "secretStatus", COALESCE(e.timeout_ms,15000) AS "timeoutMs", e.max_response_bytes AS "maxResponseBytes", v.input_schema AS "inputSchema"
    FROM facet_versions v JOIN facets f ON f.id=v.facet_id JOIN providers p ON p.id=f.provider_id LEFT JOIN endpoint_configs e ON e.id=v.endpoint_config_id LEFT JOIN secret_refs s ON s.id=e.secret_ref_id AND s.provider_id=f.provider_id
    WHERE v.id=$1 AND f.current_published_version_id=v.id AND f.status='published' AND f.visibility='public' AND v.status='published' AND p.status='active'`,
      [versionId],
    );
    const config = context.rows[0];
    if (!config)
      return reply.code(404).send({ error: { code: "FACET_NOT_FOUND" } });
    try {
      validateInput(config.inputSchema, input);
      if (config.facetType === "external_http_api")
        buildUpstreamUrl(config, input as Record<string, unknown>);
    } catch (error) {
      return reply
        .code(400)
        .send({ error: { code: (error as Error).message } });
    }
    const fingerprint = createHash("sha256")
      .update(canonicalJson(input))
      .digest("hex");
    let quote: { amount: string; payTo: string } | undefined;
    if (paymentConfig) {
      try {
        const perVersion = quoteVersion(
          { ...config, payTo: config.payTo ?? paymentConfig.payTo },
          process.env.FACET_FEE_SPLIT_ADDRESS,
          BigInt(process.env.FACET_MAX_PAYMENT_ATOMIC ?? "100000"),
        );
        quote = { amount: perVersion.amount, payTo: perVersion.payTo };
      } catch (error) {
        return reply
          .code(500)
          .send({ error: { code: (error as Error).message } });
      }
    }
    const callerId = "local-demo-agent";
    const existing = await pool.query<RunRow>(
      `SELECT id, request_fingerprint, status, result, dataset, usage_meta, receipt_tx_hash, error_code, payment_state, payment_payload, payment_tx_hash FROM facet_demo_runs WHERE caller_id=$1 AND facet_version_id=$2 AND idempotency_key=$3`,
      [callerId, versionId, key],
    );
    if (existing.rows[0]) {
      const run = existing.rows[0];
      if (run.request_fingerprint !== fingerprint)
        return reply
          .code(409)
          .send({ error: { code: "IDEMPOTENCY_CONFLICT" } });
      if (
        run.status === "SUCCEEDED" &&
        (!paymentConfig || run.payment_state === "SETTLED")
      )
        return {
          runId: run.id,
          facetVersionId: versionId,
          result: run.result,
          dataset: run.dataset ?? [],
          usage: run.usage_meta ?? undefined,
          replayed: true,
          ...(run.payment_tx_hash
            ? {
                payment: {
                  transaction: run.payment_tx_hash,
                  network: "eip155:43113",
                },
              }
            : {}),
        };
      if (
        run.status === "SUCCEEDED" &&
        paymentConfig &&
        ["VERIFIED", "PENDING", "SETTLING"].includes(run.payment_state)
      )
        return settleRun(run, versionId, quote!, reply);
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
    const signature = request.headers["payment-signature"];
    if (paymentConfig && typeof signature !== "string") {
      const challenge = paymentChallenge(
        paymentConfig,
        versionId,
        fingerprint,
        quote,
      );
      reply.header("PAYMENT-REQUIRED", challenge.header);
      return reply.code(402).send(challenge.body);
    }
    let paymentPayload: PaymentPayload | undefined;
    if (paymentConfig) {
      try {
        paymentPayload = decodeAndCheckPayment(
          signature as string,
          paymentConfig,
          versionId,
          fingerprint,
          quote,
        );
      } catch {
        return reply
          .code(400)
          .send({ error: { code: "PAYMENT_SIGNATURE_INVALID" } });
      }
    }
    let inserted;
    try {
      inserted = await pool.query<RunRow>(
        `INSERT INTO facet_demo_runs (id, caller_id, facet_version_id, idempotency_key, request_fingerprint, status, facet_type, payment_state, payment_payload, payment_payload_hash) VALUES ($1,$2,$3,$4,$5,'EXECUTING',$6,$7,$8::jsonb,$9) ON CONFLICT (caller_id, facet_version_id, idempotency_key) DO NOTHING RETURNING id, request_fingerprint, status, result, dataset, usage_meta, receipt_tx_hash, error_code, payment_state, payment_payload, payment_tx_hash`,
        [
          randomUUID(),
          callerId,
          versionId,
          key,
          fingerprint,
          config.facetType,
          paymentConfig ? "QUOTED" : "NOT_REQUIRED",
          paymentPayload ? JSON.stringify(paymentPayload) : null,
          paymentPayload
            ? createHash("sha256")
                .update(canonicalJson(paymentPayload))
                .digest("hex")
            : null,
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
      const previous = await pool.query<RunRow>(
        `SELECT id, request_fingerprint, status, result, dataset, usage_meta, receipt_tx_hash, error_code, payment_state, payment_payload, payment_tx_hash FROM facet_demo_runs WHERE caller_id=$1 AND facet_version_id=$2 AND idempotency_key=$3`,
        [callerId, versionId, key],
      );
      const run = previous.rows[0]!;
      if (run.request_fingerprint !== fingerprint)
        return reply
          .code(409)
          .send({ error: { code: "IDEMPOTENCY_CONFLICT" } });
      if (run.status === "SUCCEEDED") {
        if (
          paymentConfig &&
          ["VERIFIED", "PENDING", "SETTLING"].includes(run.payment_state)
        )
          return settleRun(run, versionId, quote!, reply);
        if (paymentConfig && run.payment_state !== "SETTLED")
          return reply
            .code(409)
            .send({ error: { code: "PAYMENT_STATE_INVALID" }, runId: run.id });
        return {
          runId: run.id,
          facetVersionId: versionId,
          result: run.result,
          dataset: run.dataset ?? [],
          usage: run.usage_meta ?? undefined,
          replayed: true,
          ...(run.payment_tx_hash
            ? {
                payment: {
                  transaction: run.payment_tx_hash,
                  network: "eip155:43113",
                },
              }
            : {}),
        };
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
    const runId = inserted.rows[0].id;
    if (paymentConfig && paymentPayload) {
      try {
        const verified = await verifyPayment(
          paymentConfig,
          paymentPayload,
          quote,
        );
        if (!verified.isValid) {
          await pool.query(
            "UPDATE facet_demo_runs SET status='FAILED', payment_state='FAILED', error_code='PAYMENT_INVALID' WHERE id=$1",
            [runId],
          );
          return reply.code(402).send({
            error: {
              code: "PAYMENT_INVALID",
              reason: verified.invalidReason,
            },
          });
        }
        await pool.query(
          "UPDATE facet_demo_runs SET payment_state='VERIFIED', updated_at=now() WHERE id=$1",
          [runId],
        );
      } catch {
        await pool.query(
          "UPDATE facet_demo_runs SET status='FAILED', payment_state='FAILED', error_code='PAYMENT_VERIFY_FAILED' WHERE id=$1",
          [runId],
        );
        return reply
          .code(502)
          .send({ error: { code: "PAYMENT_VERIFY_FAILED" } });
      }
    }
    try {
      let execution;
      if (config.facetType === "external_http_api") {
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
        execution = { result, dataset: [] as Record<string, unknown>[], usage };
      } else {
        execution = await executeViaExecutor(
          buildExecutorRequest(config, runId, input as Record<string, unknown>),
          process.env.FACET_EXECUTOR_URL ?? "http://127.0.0.1:4030",
          process.env.FACET_EXECUTOR_TOKEN ?? "",
        );
      }
      const { result, dataset, usage } = execution;
      await pool.query(
        `UPDATE facet_demo_runs SET status='SUCCEEDED', result=$2::jsonb, dataset=$3::jsonb, usage_meta=$4::jsonb, input_hash=$5, updated_at=now() WHERE id=$1`,
        [
          runId,
          JSON.stringify(result),
          JSON.stringify(dataset),
          usage ? JSON.stringify(usage) : null,
          createHash("sha256").update(canonicalJson(input)).digest("hex"),
        ],
      );
      if (paymentConfig && paymentPayload)
        return settleRun(
          {
            ...inserted.rows[0],
            result,
            dataset,
            usage_meta: usage as Record<string, unknown> | null,
            payment_payload: paymentPayload,
            payment_state: "VERIFIED",
          },
          versionId,
          quote!,
          reply,
        );
      return {
        runId,
        facetVersionId: versionId,
        facetType: config.facetType.toUpperCase(),
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
      await pool.query(
        `UPDATE facet_demo_runs SET status='FAILED', error_code=$2, updated_at=now() WHERE id=$1`,
        [runId, code],
      );
      return reply.code(502).send({ error: { code }, runId });
    }
  },
);

const port = Number(process.env.FACET_GATEWAY_PORT ?? "4020");
await app.listen({ host: process.env.FACET_GATEWAY_HOST ?? "127.0.0.1", port });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
