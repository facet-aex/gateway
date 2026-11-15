import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUpstreamUrl,
  executeGet,
  readUpstreamSecret,
  redactSecret,
  validateInput,
  type OperationConfig,
} from "../src/executor.js";

const config: OperationConfig = {
  baseUrl: "https://api.github.com/",
  pathTemplate: "/repos/{owner}/{repo}",
  method: "GET",
  authKind: "none",
  timeoutMs: 15_000,
  maxResponseBytes: 1_048_576,
  inputSchema: {
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
  },
};

describe("demo upstream boundary", () => {
  it("builds a GitHub repository URL from validated path input", () => {
    const input = { path: { owner: "octocat", repo: "Hello-World" } };
    validateInput(config.inputSchema, input);
    expect(buildUpstreamUrl(config, input).href).toBe(
      "https://api.github.com/repos/octocat/Hello-World",
    );
  });

  it("rejects missing input and private targets", () => {
    expect(() => validateInput(config.inputSchema, {})).toThrow(
      "INPUT_INVALID",
    );
    expect(() =>
      buildUpstreamUrl(
        { ...config, baseUrl: "http://127.0.0.1/" },
        { path: { owner: "octocat", repo: "Hello-World" } },
      ),
    ).toThrow("UPSTREAM_NOT_ALLOWED");
    expect(() =>
      buildUpstreamUrl(config, { path: { owner: "..", repo: "secrets" } }),
    ).toThrow("PATH_INPUT_INVALID");
  });

  it("supports a CoinGecko GET under an API base path", () => {
    const url = buildUpstreamUrl(
      {
        ...config,
        baseUrl: "https://api.coingecko.com/api/v3",
        pathTemplate: "/coins/{id}/market_chart",
        authKind: "api_key_header",
        authTemplate: { parameterName: "x-cg-demo-api-key" },
      },
      { path: { id: "bitcoin" }, query: { vs_currency: "usd", days: 30 } },
    );
    expect(url.href).toBe(
      "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=30",
    );
  });

  it("rejects writes and unsafe query authentication", () => {
    expect(() => buildUpstreamUrl({ ...config, method: "POST" }, {})).toThrow(
      "OPERATION_NOT_DEMO_ELIGIBLE",
    );
    expect(() =>
      buildUpstreamUrl(
        {
          ...config,
          authKind: "api_key_query",
          authTemplate: { parameterName: "token" },
        },
        {
          path: { owner: "octocat", repo: "Hello-World" },
          query: { token: "attacker" },
        },
      ),
    ).toThrow("UPSTREAM_AUTH_INVALID");
  });

  it("blocks a private IP before making an HTTPS request", async () => {
    await expect(
      executeGet(
        { ...config, baseUrl: "https://127.0.0.1" },
        { path: { owner: "octocat", repo: "Hello-World" } },
      ),
    ).rejects.toThrow("UPSTREAM_DNS_BLOCKED");
  });

  it("blocks IPv6 loopback and path traversal", async () => {
    await expect(
      executeGet(
        { ...config, baseUrl: "https://[::1]" },
        { path: { owner: "octocat", repo: "Hello-World" } },
      ),
    ).rejects.toThrow("UPSTREAM_DNS_BLOCKED");
    expect(() =>
      buildUpstreamUrl({ ...config, pathTemplate: "/../internal" }, {}),
    ).toThrow("UPSTREAM_NOT_ALLOWED");
  });

  it("resolves only an active scoped local provider key", async () => {
    const root = await mkdtemp(join(tmpdir(), "facet-upstream-secret-"));
    const before = process.env.FACET_SECRET_ROOT;
    const reference = "secret/00000000-0000-4000-8000-000000000001";
    try {
      await writeFile(
        join(root, "00000000-0000-4000-8000-000000000001"),
        "demo-key",
        { mode: 0o600 },
      );
      process.env.FACET_SECRET_ROOT = root;
      const withKey = {
        ...config,
        authKind: "api_key_header",
        vaultProvider: "local-fs",
        vaultReference: reference,
        secretStatus: "active",
      };
      expect(await readUpstreamSecret(withKey)).toBe("demo-key");
      await expect(
        readUpstreamSecret({ ...withKey, secretStatus: "revoked" }),
      ).rejects.toThrow("UPSTREAM_AUTH_UNAVAILABLE");
    } finally {
      if (before === undefined) delete process.env.FACET_SECRET_ROOT;
      else process.env.FACET_SECRET_ROOT = before;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a reflected API key from a provider response", () => {
    expect(redactSecret({ nested: ["token=demo-key"] }, "demo-key")).toEqual({
      nested: ["token=[REDACTED]"],
    });
  });
});
