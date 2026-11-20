import { describe, expect, it } from "vitest";
import {
  buildExecutorRequest,
  quoteVersion,
  quoteVersionOptions,
} from "../src/multimodal.js";

const facet = {
  facetId: "019a1234-5678-7abc-8def-123456789abc",
  versionId: "019a1234-5678-7abc-8def-123456789abd",
  facetType: "ACTOR" as const,
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

  it("requires the fee contract for paid Actor per-run execution", () => {
    expect(() =>
      quoteVersion(
        { ...facet, pricingModel: "PAY_PER_RUN" },
        undefined,
        100000n,
      ),
    ).toThrow("FEE_SPLIT_CONTRACT_REQUIRED");
  });

  it("routes per-result API payments through escrow", () => {
    expect(
      quoteVersion(
        { ...facet, facetType: "API" },
        "0x0000000000000000000000000000000000000002",
        100000n,
      ).payTo,
    ).toBe("0x0000000000000000000000000000000000000002");
    expect(() =>
      quoteVersion({ ...facet, facetType: "API" }, undefined, 100000n),
    ).toThrow("FEE_SPLIT_CONTRACT_REQUIRED");
  });

  it("routes per-run API payments through the fee contract when configured", () => {
    const api = {
      ...facet,
      facetType: "API" as const,
      pricingModel: "PAY_PER_RUN" as const,
    };
    const feeContract = "0x0000000000000000000000000000000000000002";
    expect(quoteVersion(api, feeContract, 100000n).payTo).toBe(feeContract);
    expect(quoteVersion(api, undefined, 100000n).payTo).toBe(facet.payTo);
    expect(quoteVersion(api, "", 100000n).payTo).toBe(facet.payTo);
  });

  it("builds an Actor executor request without facetVersionId", () => {
    const req = buildExecutorRequest(
      facet,
      "019a1234-5678-7abc-8def-123456789abe",
      {
        value: 1,
      },
    );
    expect(req).toEqual({
      runId: "019a1234-5678-7abc-8def-123456789abe",
      facetId: facet.facetId,
      facetType: "ACTOR",
      input: { value: 1 },
      timeoutMs: 15000,
      actorBundle: {
        code: facet.actorCode,
        entrypoint: "run",
        imageDigest: facet.imageDigest,
      },
    });
    expect(req).not.toHaveProperty("facetVersionId");
  });

  it("builds the canonical ERC-8004 Agent task request without facetVersionId", () => {
    const agent = {
      ...facet,
      facetType: "AGENT" as const,
      actorCode: null,
      imageDigest: null,
      erc8004TokenId: "12",
      erc8004Registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      agentTaskKind: "vn-market-analysis",
    };
    const req = buildExecutorRequest(
      agent,
      "019a1234-5678-7abc-8def-123456789abe",
      { question: "ok" },
    );
    expect(req).toEqual({
      runId: "019a1234-5678-7abc-8def-123456789abe",
      facetId: facet.facetId,
      facetType: "AGENT",
      input: { question: "ok" },
      timeoutMs: 15000,
      agentConfig: {
        erc8004ChainId: 43113,
        erc8004Registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
        erc8004TokenId: "12",
        taskKind: "vn-market-analysis",
      },
    });
    expect(req).not.toHaveProperty("facetVersionId");
  });

  it("quoteVersionOptions returns 2 quotes for dual-pricing Facet and rejects missing payTo in non-local mode", () => {
    const feeContract = "0x0000000000000000000000000000000000000002";
    const quotes = quoteVersionOptions(
      {
        ...facet,
        pricingModel: "PAY_PER_RUN",
        priceAtomic: "1000",
        maxItemsCap: 10,
        pricingOptions: [
          { model: "PAY_PER_RUN", priceAtomic: "1000", isPrimary: true },
          {
            model: "PAY_PER_RESULT",
            priceAtomic: "500",
            maxItemsCap: 10,
            isPrimary: false,
          },
        ],
      },
      feeContract,
      100000n,
      { isNonLocal: true },
    );
    expect(quotes).toEqual([
      {
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "1000",
        amount: "1000",
        payTo: feeContract,
        creatorPayTo: facet.payTo,
        isPrimary: true,
      },
      {
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 10,
        amount: "5000",
        payTo: feeContract,
        creatorPayTo: facet.payTo,
        isPrimary: false,
      },
    ]);

    expect(() =>
      quoteVersionOptions(
        { ...facet, facetType: "API", payTo: null },
        feeContract,
        100000n,
        {
          isNonLocal: true,
          fallbackPayTo: "0x0000000000000000000000000000000000000009",
        },
      ),
    ).toThrow("PAYMENT_RECIPIENT_INVALID");
  });

  it("quoteVersionOptions hydrates 0016 backfill, full options, and null/empty pricingOptions", () => {
    const feeContract = "0x0000000000000000000000000000000000000002";
    const emptyFallback = quoteVersionOptions(
      { ...facet, pricingOptions: [] },
      feeContract,
      100000n,
    );
    expect(emptyFallback).toEqual([
      {
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 20,
        amount: "10000",
        payTo: feeContract,
        creatorPayTo: facet.payTo,
        isPrimary: true,
      },
    ]);

    const fullOption = quoteVersionOptions(
      {
        ...facet,
        pricingOptions: [
          {
            model: "PAY_PER_RESULT",
            priceAtomic: "400",
            maxItemsCap: 5,
            maxAmountAtomic: "2000",
            payTo: "0x0000000000000000000000000000000000000008",
            isPrimary: true,
          },
        ],
      },
      feeContract,
      100000n,
    );
    expect(fullOption).toEqual([
      {
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "400",
        maxItemsCap: 5,
        amount: "2000",
        payTo: feeContract,
        creatorPayTo: "0x0000000000000000000000000000000000000008",
        isPrimary: true,
      },
    ]);
  });
});
