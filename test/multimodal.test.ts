import { describe, expect, it } from "vitest";
import { buildExecutorRequest, quoteVersion } from "../src/multimodal.js";

const facet = {
  facetId: "019a1234-5678-7abc-8def-123456789abc",
  versionId: "019a1234-5678-7abc-8def-123456789abd",
  facetType: "hosted_actor" as const,
  actorCode: "export default async () => ({ok:true})",
  imageDigest: `sha256:${"a".repeat(64)}`,
  pricingModel: "PAY_PER_RESULT" as const,
  priceAtomic: "500",
  payTo: "0x0000000000000000000000000000000000000001",
  erc8004TokenId: null,
  erc8004Registry: null,
  agentTaskKind: null,
  timeoutMs: 15000,
};

describe("multi-modal gateway planning", () => {
  it("quotes an Actor's capped per-result escrow from version pricing", () => {
    expect(
      quoteVersion(
        facet,
        "0x0000000000000000000000000000000000000002",
        100000n,
      ),
    ).toEqual({
      pricingModel: "PAY_PER_RESULT",
      amount: "10000",
      payTo: "0x0000000000000000000000000000000000000002",
      creatorPayTo: facet.payTo,
    });
    expect(() =>
      quoteVersion({ ...facet, priceAtomic: "10000" }, facet.payTo, 100000n),
    ).toThrow("PAYMENT_AMOUNT_EXCEEDS_CAP");
  });

  it("builds a version-pinned Actor request without endpoint configuration", () => {
    expect(
      buildExecutorRequest(facet, "019a1234-5678-7abc-8def-123456789abe", {
        value: 1,
      }),
    ).toEqual({
      runId: "019a1234-5678-7abc-8def-123456789abe",
      facetId: facet.facetId,
      facetVersionId: facet.versionId,
      facetType: "HOSTED_ACTOR",
      input: { value: 1 },
      timeoutMs: 15000,
      actorBundle: { code: facet.actorCode, imageDigest: facet.imageDigest },
    });
  });

  it("builds the canonical ERC-8004 Agent task request", () => {
    const agent = {
      ...facet,
      facetType: "autonomous_agent" as const,
      actorCode: null,
      imageDigest: null,
      erc8004TokenId: "12",
      erc8004Registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      agentTaskKind: "vn-market-analysis",
    };
    expect(
      buildExecutorRequest(agent, "019a1234-5678-7abc-8def-123456789abe", {
        question: "hello",
      }),
    ).toMatchObject({
      facetType: "AUTONOMOUS_AGENT",
      agentConfig: {
        erc8004ChainId: 43113,
        erc8004TokenId: "12",
        taskKind: "vn-market-analysis",
      },
    });
  });
});
