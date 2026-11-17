import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const userId = randomUUID(),
  providerId = randomUUID(),
  sourceId = randomUUID(),
  sourceVersionId = randomUUID();
const facetId = randomUUID(),
  versionId = randomUUID(),
  endpointId = randomUUID();
const unique = randomUUID().slice(0, 8);
const baseUrl = `http://127.0.0.1:${process.env.FACET_GATEWAY_PORT ?? "4020"}`;
let child: ReturnType<typeof spawn> | undefined;
const liveFuji = process.env.FACET_LIVE_FUJI_API_SMOKE === "1";
if (liveFuji) loadEnvFile("../mcp-server/.env");
const facilitatorRequire = createRequire(
  new URL("../../x402-facilitator/package.json", import.meta.url),
);
const paidMode = process.env.FACET_PAID_SMOKE === "1" || liveFuji;
const contractMode = process.env.FACET_CONTRACT_SMOKE === "1";
const pendingReceiptMode = process.env.FACET_PENDING_RECEIPT_SMOKE === "1";
const payTo = "0x0000000000000000000000000000000000000001";
const facilitatorToken = "t".repeat(32);
const executorToken = "e".repeat(32);
let verifyCount = 0,
  settleCount = 0,
  signCount = 0,
  receiptCount = 0,
  depositCount = 0,
  settleResultCount = 0,
  refundCount = 0;
const fakeFacilitator = createServer((request, response) => {
  if (request.headers["x-facet-facilitator-token"] !== facilitatorToken) {
    response.writeHead(401).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  if (request.url === "/verify") {
    verifyCount++;
    response.end(
      JSON.stringify({
        isValid: true,
        payer: "0x0000000000000000000000000000000000000002",
      }),
    );
    return;
  }
  if (request.url === "/settle") {
    settleCount++;
    response.end(
      JSON.stringify({
        success: true,
        transaction: `0x${"1".repeat(64)}`,
        network: "eip155:43113",
        payer: "0x0000000000000000000000000000000000000002",
      }),
    );
    return;
  }
  if (request.url === "/v1/receipt") {
    receiptCount++;
    response.end(
      JSON.stringify({
        status:
          pendingReceiptMode && receiptCount === 1 ? "PENDING" : "CONFIRMED",
        transaction: `0x${"3".repeat(64)}`,
      }),
    );
    return;
  }
  if (request.url === "/v1/contract/DEPOSIT") {
    depositCount++;
    response.end(
      JSON.stringify({
        status: "CONFIRMED",
        transaction: `0x${"4".repeat(64)}`,
      }),
    );
    return;
  }
  if (request.url === "/v1/contract/SETTLE_RESULT") {
    settleResultCount++;
    response.end(
      JSON.stringify({
        status: "CONFIRMED",
        transaction: `0x${"5".repeat(64)}`,
      }),
    );
    return;
  }
  if (request.url === "/v1/contract/REFUND") {
    refundCount++;
    response.end(
      JSON.stringify({
        status: "CONFIRMED",
        transaction: `0x${"6".repeat(64)}`,
      }),
    );
    return;
  }
  response.writeHead(404).end();
});
const fakeExecutor = createServer((request, response) => {
  if (
    request.url !== "/v1/sign-external-result" ||
    request.headers["x-facet-executor-token"] !== executorToken
  ) {
    response.writeHead(401).end();
    return;
  }
  signCount++;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      inputHash: `sha256:${"a".repeat(64)}`,
      outputHash: `sha256:${"b".repeat(64)}`,
      itemCount: 1,
      runnerSignature: `0x${"c".repeat(130)}`,
    }),
  );
});

async function cleanup() {
  await pool.query("DELETE FROM facet_demo_runs WHERE facet_version_id=$1", [
    versionId,
  ]);
  await pool.query(
    "UPDATE facets SET current_published_version_id=NULL WHERE id=$1",
    [facetId],
  );
  await pool.query("DELETE FROM facet_versions WHERE id=$1", [versionId]);
  await pool.query("DELETE FROM endpoint_configs WHERE id=$1", [endpointId]);
  await pool.query("DELETE FROM facets WHERE id=$1", [facetId]);
  await pool.query("DELETE FROM api_source_versions WHERE id=$1", [
    sourceVersionId,
  ]);
  await pool.query("DELETE FROM api_sources WHERE id=$1", [sourceId]);
  await pool.query("DELETE FROM providers WHERE id=$1", [providerId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
}

try {
  await pool.query("INSERT INTO users (id,external_subject) VALUES ($1,$2)", [
    userId,
    `gateway-smoke-${unique}`,
  ]);
  await pool.query("INSERT INTO providers (id,slug,name) VALUES ($1,$2,$3)", [
    providerId,
    `gateway-smoke-${unique}`,
    "Gateway smoke provider",
  ]);
  await pool.query(
    "INSERT INTO api_sources (id,provider_id,name,source_kind) VALUES ($1,$2,$3,'paste')",
    [sourceId, providerId, "GitHub demo fixture"],
  );
  await pool.query(
    "INSERT INTO api_source_versions (id,api_source_id,object_key,sha256,created_by) VALUES ($1,$2,$3,$4,$5)",
    [sourceVersionId, sourceId, `smoke/${unique}`, "0".repeat(64), userId],
  );
  await pool.query(
    "INSERT INTO facets (id,provider_id,slug,name,category,status,visibility) VALUES ($1,$2,$3,$4,$5,'published','public')",
    [
      facetId,
      providerId,
      `github-repo-${unique}`,
      "Get public GitHub repository",
      "Developer tools",
    ],
  );
  await pool.query(
    "INSERT INTO endpoint_configs (id,provider_id,protected_base_url,method,path_template,auth_kind,timeout_ms,max_response_bytes,redirect_policy,egress_policy_id) VALUES ($1,$2,'https://api.github.com/','GET','/repos/{owner}/{repo}','none',15000,1048576,'deny','gateway-demo')",
    [endpointId, providerId],
  );
  const inputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "object",
        additionalProperties: false,
        required: ["owner", "repo"],
        properties: { owner: { type: "string" }, repo: { type: "string" } },
      },
    },
  };
  await pool.query(
    "INSERT INTO facet_versions (id,facet_id,version,status,source_version_id,source_operation_pointer,manifest,content_hash,endpoint_config_id,operation,input_schema,output_schema,created_by,published_at) VALUES ($1,$2,'0.1.0','published',$3,'#/paths/~1repos~1{owner}~1{repo}/get',$4,$5,$6,$7,$8,$9,$10,now())",
    [
      versionId,
      facetId,
      sourceVersionId,
      JSON.stringify({}),
      `sha256:${"0".repeat(64)}`,
      endpointId,
      JSON.stringify({ method: "GET" }),
      JSON.stringify(inputSchema),
      JSON.stringify({}),
      userId,
    ],
  );
  await pool.query(
    "UPDATE facets SET current_published_version_id=$2 WHERE id=$1",
    [facetId, versionId],
  );
  if (contractMode)
    await pool.query(
      "UPDATE facet_versions SET pricing_model='PAY_PER_RESULT', price_atomic='1000', pay_to=$2 WHERE id=$1",
      [versionId, payTo],
    );

  if (paidMode && !liveFuji) {
    await new Promise<void>((resolve) =>
      fakeFacilitator.listen(4023, "127.0.0.1", resolve),
    );
    await new Promise<void>((resolve) =>
      fakeExecutor.listen(4033, "127.0.0.1", resolve),
    );
  }
  child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FACET_DEMO_X402_ENABLED: paidMode ? "1" : "0",
      FACET_FACILITATOR_URL: liveFuji
        ? "http://127.0.0.1:4022"
        : "http://127.0.0.1:4023",
      FACET_FACILITATOR_TOKEN: liveFuji
        ? process.env.FACET_FACILITATOR_TOKEN
        : facilitatorToken,
      FACET_EXECUTOR_TOKEN: liveFuji
        ? process.env.FACET_EXECUTOR_TOKEN
        : executorToken,
      FACET_EXECUTOR_URL: liveFuji
        ? "http://127.0.0.1:4030"
        : "http://127.0.0.1:4033",
      FACET_DEMO_PAY_TO: liveFuji ? process.env.FACET_DEMO_PAY_TO : payTo,
      FACET_DEMO_AMOUNT_ATOMIC: "1000",
      FACET_FEE_SPLIT_ADDRESS: liveFuji
        ? process.env.FACET_FEE_SPLIT_ADDRESS
        : contractMode
          ? "0x0000000000000000000000000000000000000004"
          : "",
      FACET_RECEIPT_LOG_ADDRESS: liveFuji
        ? process.env.FACET_RECEIPT_LOG_ADDRESS
        : "0x0000000000000000000000000000000000000005",
    },
    stdio: "ignore",
  });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const health = await fetch(`${baseUrl}/health/live`);
      if (health.ok) {
        ready = true;
        break;
      }
    } catch {
      /* wait */
    }
    await delay(200);
  }
  if (!ready) throw new Error("Gateway did not start");
  const key = randomUUID();
  const invoke = (input: unknown, signature?: string, overrideKey = key) =>
    fetch(`${baseUrl}/v1/facet-versions/${versionId}/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": overrideKey,
        ...(signature ? { "PAYMENT-SIGNATURE": signature } : {}),
      },
      body: JSON.stringify({ input }),
    });
  let first = await invoke({
    path: { owner: "octocat", repo: "Hello-World" },
  });
  let signature: string | undefined;
  if (paidMode) {
    if (first.status !== 402 || !first.headers.get("PAYMENT-REQUIRED"))
      throw new Error("Paid route did not issue x402 challenge");
    const challenge = decodePaymentRequiredHeader(
      first.headers.get("PAYMENT-REQUIRED")!,
    );
    if (liveFuji) {
      const { ExactEvmScheme } = facilitatorRequire("@x402/evm/exact/client");
      const { privateKeyToAccount } = facilitatorRequire("viem/accounts");
      const payer = privateKeyToAccount(
        process.env.FACET_DEMO_PAYER_PRIVATE_KEY,
      );
      const signed = await new ExactEvmScheme({
        address: payer.address,
        signTypedData: (args: unknown) => payer.signTypedData(args),
      }).createPaymentPayload(2, challenge.accepts[0]);
      signature = encodePaymentSignatureHeader({
        x402Version: 2,
        resource: challenge.resource,
        accepted: challenge.accepts[0]!,
        payload: signed.payload,
      });
    } else
      signature = encodePaymentSignatureHeader({
        x402Version: 2,
        resource: challenge.resource,
        accepted: challenge.accepts[0]!,
        payload: { authorization: { nonce: `0x${"2".repeat(64)}` } },
      });
    first = await invoke(
      { path: { owner: "octocat", repo: "Hello-World" } },
      signature,
    );
    if (liveFuji)
      for (let attempt = 0; first.status === 202 && attempt < 8; attempt++) {
        await delay(1500);
        first = await invoke({
          path: { owner: "octocat", repo: "Hello-World" },
        });
      }
  }
  if (pendingReceiptMode) {
    if (first.status !== 202)
      throw new Error("Pending receipt was reported as settled");
    first = await invoke({ path: { owner: "octocat", repo: "Hello-World" } });
  }
  if (first.status !== 200)
    throw new Error(
      `First invocation failed: ${first.status} ${await first.text()}`,
    );
  const firstBody = (await first.json()) as {
    runId: string;
    result: { full_name: string };
    replayed: boolean;
    receipt?: {
      inputHash: string;
      outputHash: string;
      itemCount: number;
      paymentTxHash: string;
      receiptTxHash: string;
      runnerSignature: string;
    };
  };
  if (
    firstBody.result.full_name !== "octocat/Hello-World" ||
    firstBody.replayed
  )
    throw new Error("Unexpected upstream result");
  if (
    paidMode &&
    (!firstBody.receipt?.inputHash ||
      !firstBody.receipt?.outputHash ||
      firstBody.receipt.itemCount !== 1 ||
      !firstBody.receipt.paymentTxHash ||
      !firstBody.receipt.receiptTxHash ||
      !firstBody.receipt.runnerSignature)
  )
    throw new Error("Paid response omitted receipt proof");
  const replay = await invoke({
    path: { repo: "Hello-World", owner: "octocat" },
  });
  const replayBody = (await replay.json()) as { replayed: boolean };
  if (replay.status !== 200 || !replayBody.replayed)
    throw new Error("Same-key replay did not return cached result");
  const conflict = await invoke({
    path: { owner: "octocat", repo: "Spoon-Knife" },
  });
  if (conflict.status !== 409)
    throw new Error("Changed-input idempotency conflict was not rejected");
  if (paidMode) {
    if (liveFuji) {
      process.stdout.write(
        JSON.stringify({
          runId: firstBody.runId,
          paymentTxHash: firstBody.receipt?.paymentTxHash,
          receiptTxHash: firstBody.receipt?.receiptTxHash,
        }) + "\n",
      );
    } else {
      if (
        verifyCount !== 1 ||
        settleCount !== (contractMode ? 0 : 1) ||
        depositCount !== (contractMode ? 1 : 0) ||
        settleResultCount !== (contractMode ? 1 : 0) ||
        signCount !== 1 ||
        receiptCount !== (pendingReceiptMode ? 2 : 1)
      )
        throw new Error("Paid replay repeated verification or settlement");
      const reusedPayment = await invoke(
        { path: { owner: "octocat", repo: "Hello-World" } },
        signature,
        randomUUID(),
      );
      if (reusedPayment.status !== 409)
        throw new Error("Payment signature was reused for another Run");
    }
  }
  if (contractMode) {
    const missingInput = {
      path: { owner: "octocat", repo: `facet-missing-${unique}` },
    };
    const failedKey = randomUUID();
    const challengeResponse = await invoke(missingInput, undefined, failedKey);
    if (challengeResponse.status !== 402)
      throw new Error("Failure path did not issue payment challenge");
    const challenge = decodePaymentRequiredHeader(
      challengeResponse.headers.get("PAYMENT-REQUIRED")!,
    );
    const failureSignature = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: challenge.resource,
      accepted: challenge.accepts[0]!,
      payload: { authorization: { nonce: `0x${"7".repeat(64)}` } },
    });
    const failedResponse = await invoke(
      missingInput,
      failureSignature,
      failedKey,
    );
    if (
      failedResponse.status !== 502 ||
      refundCount !== 1 ||
      depositCount !== 2
    )
      throw new Error(
        `Escrow failure did not refund: ${failedResponse.status}`,
      );
    const failedRun = await pool.query(
      "SELECT payment_state, status FROM facet_demo_runs WHERE facet_version_id=$1 AND idempotency_key=$2",
      [versionId, failedKey],
    );
    if (
      failedRun.rows[0]?.payment_state !== "REFUNDED" ||
      failedRun.rows[0]?.status !== "FAILED"
    )
      throw new Error("Refund state was not persisted");
  }
  process.stdout.write(
    `Gateway PostgreSQL + real GitHub ${liveFuji ? "Fuji paid " : paidMode ? "mock-facilitator paid " : ""}invocation, replay and conflict passed.\n`,
  );
} finally {
  child?.kill("SIGTERM");
  if (paidMode && !liveFuji) {
    await new Promise<void>((resolve) =>
      fakeFacilitator.close(() => resolve()),
    );
    await new Promise<void>((resolve) => fakeExecutor.close(() => resolve()));
  }
  await cleanup();
  await pool.end();
}
