import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
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
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const liveFuji = process.env.FACET_LIVE_FUJI_SMOKE === "1";
const deployedGatewayUrl = process.env.FACET_DEPLOYED_GATEWAY_URL;
if (deployedGatewayUrl && !liveFuji)
  throw new Error("FACET_DEPLOYED_GATEWAY_URL requires live Fuji mode");
const gatewayUrl = deployedGatewayUrl ?? "http://127.0.0.1:4120";
if (liveFuji) loadEnvFile("../mcp-server/.env");
const facilitatorRequire = createRequire(
  new URL("../../x402-facilitator/package.json", import.meta.url),
);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  user: randomUUID(),
  source: randomUUID(),
  sourceVersion: randomUUID(),
  actor: randomUUID(),
  actorVersion: randomUUID(),
  agent: randomUUID(),
  agentVersion: randomUUID(),
};
const actorCode =
  "export default async function run(input) { return [{ value: input.value }]; }";
const digest = `sha256:${createHash("sha256").update(`facet/node-actor-runner:1.0\n${actorCode.trim()}`).digest("hex")}`;
const runnerKey = `0x${"1".repeat(64)}`;
const executorToken = "local-smoke-executor-token-32-characters";
const children: ChildProcess[] = [];

async function waitFor(url: string) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* process starting */
    }
    await delay(100);
  }
  throw new Error(`Service not ready: ${url}`);
}

async function cleanup() {
  for (const child of children) child.kill("SIGTERM");
  await pool.query(
    "DELETE FROM facet_demo_runs WHERE facet_version_id IN ($1,$2)",
    [ids.actorVersion, ids.agentVersion],
  );
  await pool.query(
    "UPDATE facets SET current_published_version_id=NULL WHERE id IN ($1,$2)",
    [ids.actor, ids.agent],
  );
  await pool.query("DELETE FROM facet_versions WHERE id IN ($1,$2)", [
    ids.actorVersion,
    ids.agentVersion,
  ]);
  await pool.query("DELETE FROM facets WHERE id IN ($1,$2)", [
    ids.actor,
    ids.agent,
  ]);
  await pool.query("DELETE FROM api_source_versions WHERE id=$1", [
    ids.sourceVersion,
  ]);
  await pool.query("DELETE FROM api_sources WHERE id=$1", [ids.source]);
  await pool.query("DELETE FROM users WHERE id=$1", [ids.user]);
}

try {
  const unique = randomUUID().replace(/-/g, "").slice(0, 6);
  const username = `mm-smk-${unique}`;
  await pool.query(
    "INSERT INTO users (id,clerk_id,username) VALUES ($1,$2,$3)",
    [ids.user, `user_mm_${unique}`, username],
  );
  await pool.query(
    "INSERT INTO api_sources (id,provider_id,name,source_kind) VALUES ($1,$2,'Actor fixture','paste')",
    [ids.source, ids.user],
  );
  await pool.query(
    "INSERT INTO api_source_versions (id,api_source_id,object_key,sha256,created_by) VALUES ($1,$2,$3,$4,$5)",
    [
      ids.sourceVersion,
      ids.source,
      `smoke/${unique}`,
      "0".repeat(64),
      ids.user,
    ],
  );
  const facets = [
    {
      id: ids.actor,
      version: ids.actorVersion,
      facetName: `smoke-actor-${unique}`,
      type: "ACTOR",
      code: actorCode,
      digest,
      tokenId: null,
      registry: null,
      taskKind: null,
      schema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "integer" } },
      },
    },
    {
      id: ids.agent,
      version: ids.agentVersion,
      facetName: `smoke-agent-${unique}`,
      type: "AGENT",
      code: null,
      digest: null,
      tokenId: "1",
      registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      taskKind: "vn-market-analysis",
      schema: {
        type: "object",
        required: ["question", "goldQuotes", "articles"],
        properties: {
          question: { type: "string" },
          goldQuotes: { type: "array" },
          fxQuotes: { type: "array" },
          articles: { type: "array" },
        },
      },
    },
  ];
  for (const facet of facets) {
    await pool.query(
      "INSERT INTO facets (id,provider_id,facet_name,facet_display_name,category,type,status,visibility) VALUES ($1,$2,$3,$4,'vietnamese-data',$5,'published','public')",
      [facet.id, ids.user, facet.facetName, facet.type, facet.type],
    );
    await pool.query(
      `INSERT INTO facet_versions (id,facet_id,version,status,source_version_id,source_operation_pointer,manifest,content_hash,endpoint_config_id,operation,input_schema,output_schema,created_by,published_at,actor_code,image_digest,pricing_model,price_atomic,pay_to,erc8004_token_id,erc8004_registry,agent_task_kind) VALUES ($1,$2,'1.0.0','published',$3,$4,$5::jsonb,$6,NULL,$7::jsonb,$8::jsonb,$9::jsonb,$10,now(),$11,$12,$17,'1000',$13,$14,$15,$16)`,
      [
        facet.version,
        facet.id,
        ids.sourceVersion,
        `#/${facet.type}`,
        JSON.stringify({}),
        `sha256:${"0".repeat(64)}`,
        JSON.stringify({ method: "POST" }),
        JSON.stringify(facet.schema),
        JSON.stringify({}),
        ids.user,
        facet.code,
        facet.digest,
        liveFuji
          ? process.env.FACET_DEMO_PAY_TO
          : "0x0000000000000000000000000000000000000001",
        facet.tokenId,
        facet.registry,
        facet.taskKind,
        liveFuji && facet.type === "ACTOR" ? "PAY_PER_RESULT" : "PAY_PER_RUN",
      ],
    );
    await pool.query(
      "UPDATE facets SET current_published_version_id=$2 WHERE id=$1",
      [facet.id, facet.version],
    );
  }

  if (!liveFuji)
    children.push(
      spawn(process.execPath, ["../executor/dist/server.js"], {
        env: {
          ...process.env,
          FACET_ENV: "local",
          FACET_RUNNER_MODE: "subprocess",
          FACET_RUNNER_PRIVATE_KEY: runnerKey,
          FACET_EXECUTOR_TOKEN: executorToken,
          FACET_EXECUTOR_PORT: "4130",
        },
        stdio: "ignore",
      }),
    );
  if (!deployedGatewayUrl) {
    await waitFor(
      liveFuji
        ? "http://127.0.0.1:4030/health/live"
        : "http://127.0.0.1:4130/health/live",
    );
    children.push(
      spawn(process.execPath, ["dist/server.js"], {
        env: {
          ...process.env,
          FACET_DEMO_X402_ENABLED: liveFuji ? "1" : "0",
          FACET_GATEWAY_PORT: "4120",
          FACET_EXECUTOR_URL: liveFuji
            ? "http://127.0.0.1:4030"
            : "http://127.0.0.1:4130",
          FACET_EXECUTOR_TOKEN: liveFuji
            ? process.env.FACET_EXECUTOR_TOKEN
            : executorToken,
        },
        stdio: "ignore",
      }),
    );
  }
  await waitFor(`${gatewayUrl}/health/live`);

  const inputs = [
    {
      facetName: facets[0]!.facetName,
      version: "1.0.0",
      input: { value: 7 },
      expected: 1,
    },
    {
      facetName: facets[1]!.facetName,
      version: "1.0.0",
      input: {
        question: "Tổng hợp dữ liệu",
        goldQuotes: [
          {
            brand: "SJC",
            buyVnd: 88000000,
            sellVnd: 90000000,
            asOf: "2026-01-01T00:00:00Z",
            sourceUrl: "https://sjc.com.vn/",
          },
        ],
        fxQuotes: [],
        articles: [
          {
            title: "AI tăng trưởng",
            text: "AI tăng trưởng tốt tại Việt Nam",
            sourceUrl: "https://example.org/story",
            asOf: "2026-01-01T00:00:00Z",
          },
        ],
      },
      expected: 2,
    },
  ];
  for (const { facetName, version, input, expected } of inputs) {
    const key = randomUUID();
    const invoke = (signature?: string) =>
      fetch(
        `${gatewayUrl}/v1/facets/${username}/${facetName}/versions/${version}/invoke`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
            ...(signature ? { "PAYMENT-SIGNATURE": signature } : {}),
          },
          body: JSON.stringify({ input }),
        },
      );
    let first = await invoke();
    if (liveFuji) {
      if (first.status !== 402)
        throw new Error(`Expected x402 challenge, got ${first.status}`);
      const challenge = decodePaymentRequiredHeader(
        first.headers.get("PAYMENT-REQUIRED")!,
      );
      const { ExactEvmScheme } = facilitatorRequire("@x402/evm/exact/client");
      const { privateKeyToAccount } = facilitatorRequire("viem/accounts");
      const payer = privateKeyToAccount(
        process.env.FACET_DEMO_PAYER_PRIVATE_KEY,
      );
      const signed = await new ExactEvmScheme({
        address: payer.address,
        signTypedData: (args: unknown) => payer.signTypedData(args),
      }).createPaymentPayload(2, challenge.accepts[0]);
      const signature = encodePaymentSignatureHeader({
        x402Version: 2,
        resource: challenge.resource,
        accepted: challenge.accepts[0],
        payload: signed.payload,
      });
      first = await invoke(signature);
      for (let attempt = 0; first.status === 202 && attempt < 8; attempt++) {
        await delay(1500);
        first = await invoke(signature);
      }
    }
    if (first.status !== 200)
      throw new Error(
        `First ${version} invoke failed: ${first.status} ${await first.text()}`,
      );
    const body = (await first.json()) as {
      runId: string;
      dataset: unknown[];
      usage: { itemCount: number };
      replayed: boolean;
      payment?: { transaction: string };
      receipt?: { paymentTxHash: string; receiptTxHash: string };
    };
    if (
      body.dataset.length !== expected ||
      body.usage.itemCount !== expected ||
      body.replayed
    )
      throw new Error(`Wrong ${version} dataset/usage`);
    if (
      liveFuji &&
      (!body.payment?.transaction ||
        body.receipt?.paymentTxHash !== body.payment.transaction ||
        !body.receipt.receiptTxHash)
    )
      throw new Error(`Missing ${version} payment/receipt proof`);
    const replay = await invoke();
    const replayBody = (await replay.json()) as {
      runId: string;
      replayed: boolean;
    };
    if (
      replay.status !== 200 ||
      !replayBody.replayed ||
      replayBody.runId !== body.runId
    )
      throw new Error(`Wrong ${version} replay`);
    const stored = await pool.query<{
      dataset: unknown[];
      usage_meta: { itemCount: number };
    }>("SELECT dataset, usage_meta FROM facet_demo_runs WHERE id=$1", [
      body.runId,
    ]);
    if (
      stored.rows[0]?.dataset.length !== expected ||
      stored.rows[0]?.usage_meta.itemCount !== expected
    )
      throw new Error(`Wrong ${version} persistence`);
    if (liveFuji)
      process.stdout.write(
        JSON.stringify({
          provider: username,
          facetName,
          version,
          runId: body.runId,
          paymentTxHash: body.payment?.transaction,
          receiptTxHash: body.receipt?.receiptTxHash,
        }) + "\n",
      );
  }
  process.stdout.write(
    "Gateway Actor/Agent PostgreSQL invocation, dataset, signed usage and replay passed.\n",
  );
} finally {
  await cleanup();
  await pool.end();
}
