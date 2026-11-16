export interface FacetExecutionConfig {
  facetId: string;
  versionId: string;
  facetType: "external_http_api" | "hosted_actor" | "autonomous_agent";
  actorCode: string | null;
  imageDigest: string | null;
  pricingModel: "PAY_PER_RUN" | "PAY_PER_RESULT";
  priceAtomic: string;
  payTo: string | null;
  erc8004TokenId: string | null;
  erc8004Registry: string | null;
  agentTaskKind: string | null;
  timeoutMs: number;
}

const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const CANONICAL_ERC8004 = "0x8004a818bfb912233c491871b3d84c89a494bd9e";

export function quoteVersion(
  version: FacetExecutionConfig,
  feeSplitAddress: string | undefined,
  maxAmount: bigint,
) {
  if (!/^[1-9][0-9]*$/u.test(version.priceAtomic))
    throw new Error("PAYMENT_PRICE_INVALID");
  if (!version.payTo || !ADDRESS.test(version.payTo))
    throw new Error("PAYMENT_RECIPIENT_INVALID");
  const price = BigInt(version.priceAtomic);
  const amount =
    version.pricingModel === "PAY_PER_RESULT" ? price * 20n : price;
  if (amount > maxAmount) throw new Error("PAYMENT_AMOUNT_EXCEEDS_CAP");
  if (version.facetType !== "external_http_api" && !feeSplitAddress)
    throw new Error("FEE_SPLIT_CONTRACT_REQUIRED");
  const payTo =
    version.facetType === "external_http_api"
      ? version.payTo
      : (feeSplitAddress ?? version.payTo);
  if (!ADDRESS.test(payTo)) throw new Error("PAYMENT_RECIPIENT_INVALID");
  return {
    pricingModel: version.pricingModel,
    amount: amount.toString(),
    payTo,
    creatorPayTo: version.payTo,
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
    facetVersionId: version.versionId,
    input,
    timeoutMs: Math.min(version.timeoutMs || 15_000, 30_000),
  };
  if (version.facetType === "hosted_actor") {
    if (
      !version.actorCode ||
      !/^sha256:[0-9a-f]{64}$/iu.test(version.imageDigest ?? "")
    )
      throw new Error("ACTOR_BUNDLE_INVALID");
    return {
      ...base,
      facetType: "HOSTED_ACTOR" as const,
      actorBundle: {
        code: version.actorCode,
        imageDigest: version.imageDigest,
      },
    };
  }
  if (version.facetType === "autonomous_agent") {
    if (
      !version.erc8004TokenId ||
      !/^[1-9][0-9]*$/u.test(version.erc8004TokenId) ||
      version.erc8004Registry?.toLowerCase() !== CANONICAL_ERC8004 ||
      !version.agentTaskKind
    )
      throw new Error("AGENT_CONFIG_INVALID");
    return {
      ...base,
      facetType: "AUTONOMOUS_AGENT" as const,
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
