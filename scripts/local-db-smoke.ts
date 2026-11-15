import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
const paidMode = process.env.FACET_PAID_SMOKE === "1";
const payTo = "0x0000000000000000000000000000000000000001";
const facilitatorToken = "t".repeat(32);
let verifyCount = 0,
  settleCount = 0;
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
  response.writeHead(404).end();
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

  if (paidMode)
    await new Promise<void>((resolve) =>
      fakeFacilitator.listen(4023, "127.0.0.1", resolve),
    );
  child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FACET_DEMO_X402_ENABLED: paidMode ? "1" : "0",
      FACET_FACILITATOR_URL: "http://127.0.0.1:4023",
      FACET_FACILITATOR_TOKEN: facilitatorToken,
      FACET_DEMO_PAY_TO: payTo,
      FACET_DEMO_AMOUNT_ATOMIC: "1000",
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
  }
  if (first.status !== 200)
    throw new Error(
      `First invocation failed: ${first.status} ${await first.text()}`,
    );
  const firstBody = (await first.json()) as {
    result: { full_name: string };
    replayed: boolean;
  };
  if (
    firstBody.result.full_name !== "octocat/Hello-World" ||
    firstBody.replayed
  )
    throw new Error("Unexpected upstream result");
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
    if (verifyCount !== 1 || settleCount !== 1)
      throw new Error("Paid replay repeated verification or settlement");
    const reusedPayment = await invoke(
      { path: { owner: "octocat", repo: "Hello-World" } },
      signature,
      randomUUID(),
    );
    if (reusedPayment.status !== 409)
      throw new Error("Payment signature was reused for another Run");
  }
  process.stdout.write(
    `Gateway PostgreSQL + real GitHub ${paidMode ? "mock-facilitator paid " : ""}invocation, replay and conflict passed.\n`,
  );
} finally {
  child?.kill("SIGTERM");
  if (paidMode)
    await new Promise<void>((resolve) =>
      fakeFacilitator.close(() => resolve()),
    );
  await cleanup();
  await pool.end();
}
