# `gateway` instructions

**Owner in Wave 2:** Codex  
**Port:** `4020` (`FACET_GATEWAY_PORT`)  
**Active architectural authority:** `../docs/architecture/decisions/ADR-0015-actorbazaar-docker-and-a2a-mvp.md`

## Role

`gateway` is the unified execution, idempotency, x402 payment, and on-chain receipt entrypoint (`POST /v1/facet-versions/:versionId/invoke`).

## Multi-Modal Execution Flow (`v0.13.0`)

1. Resolve the published `PUBLIC` `FacetVersion` from PostgreSQL using **`LEFT JOIN endpoint_configs`** (so `hosted_actor` and `autonomous_agent`, which have `endpoint_config_id IS NULL`, are resolved cleanly alongside `external_http_api`), reading `facet_type`, `actor_code`, `image_digest`, `pricing_model`, `price_atomic`, `pay_to`, `erc8004_token_id`, `erc8004_registry`, and `agent_task_kind`.
2. Validate `request.body.input` against `input_schema` and check idempotency `(caller_id, facet_version_id, idempotency_key)` against `request_fingerprint`.
3. Enforce x402 payment challenge (`HTTP 402`) using **per-version pricing** (replacing the static global `FACET_DEMO_AMOUNT_ATOMIC` / `FACET_DEMO_PAY_TO` limit):
   - For `PAY_PER_RUN`: quote `amount = price_atomic`; `payTo = FACET_FEE_SPLIT_ADDRESS` (when `FeeSplit` is configured) or version `pay_to` (direct transfer fallback).
   - For `PAY_PER_RESULT`: quote `amount = String(BigInt(price_atomic) * 20n)` (`maxItemsCap = 20`, bounded by `FACET_MAX_PAYMENT_ATOMIC`); `payTo = FACET_FEE_SPLIT_ADDRESS` (escrow contract).
4. Verify `PAYMENT-SIGNATURE` via `x402-facilitator` (`/verify`). For `PAY_PER_RESULT`, lock the escrow deposit on `FacetFeeSplitAndEscrow` (`depositEscrowWithAuthorization`) before executing the workload.
5. Dispatch execution based on `facet_type`:
   - `external_http_api`: call `executeGet(...)` with DNS/IP unicast pinning and secret redaction.
   - `hosted_actor` or `autonomous_agent`: call `POST ${FACET_EXECUTOR_URL:-http://127.0.0.1:4030}/v1/execute` with `ExecutorRunRequest` and receive `{ result, dataset, logs, usage }`.
6. Persist `result`, `dataset`, and `usage_meta` in `facet_demo_runs` before settling payment.
7. Settle payment via `x402-facilitator` (`/settle`, passing `runId`, `facetId`, `creatorPayTo`, `pricingModel`, `inputHash`, `outputHash`, `itemCount`, and `runnerSignature` so `FeeSplit` pays out immediately or `TaskEscrow` settles actual items + refunds remainder) and record the run receipt on `FacetReceiptLog.sol` (storing `receipt_tx_hash`). If `PAY_PER_RESULT` execution fails, call `refundEscrow(runId)`.
8. Return `InvokeFacetResponse` (`v0.13.0`) with `runId`, `facetVersionId`, `facetType`, `result`, `dataset`, `usage`, `replayed`, `payment`, and `receipt`.
