import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import ipaddr from "ipaddr.js";
import { Ajv2020 } from "ajv/dist/2020.js";

export interface OperationConfig {
  baseUrl: string;
  pathTemplate: string;
  method: string;
  authKind: string;
  authTemplate?: { parameterName?: string };
  vaultProvider?: string | null;
  vaultReference?: string | null;
  secretStatus?: string | null;
  timeoutMs: number;
  maxResponseBytes: number;
  inputSchema: unknown;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });

export function validateInput(schema: unknown, input: unknown): void {
  if (typeof schema !== "object" || schema === null)
    throw new Error("INPUT_SCHEMA_INVALID");
  const validate = ajv.compile(schema);
  if (!validate(input)) throw new Error("INPUT_INVALID");
}

export function buildUpstreamUrl(
  config: OperationConfig,
  input: Record<string, unknown>,
): URL {
  if (config.method.toUpperCase() !== "GET")
    throw new Error("OPERATION_NOT_DEMO_ELIGIBLE");
  const base = new URL(config.baseUrl);
  if (
    base.protocol !== "https:" ||
    (base.port && base.port !== "443") ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("UPSTREAM_NOT_ALLOWED");
  if (
    !config.pathTemplate.startsWith("/") ||
    /[?#\\]/u.test(config.pathTemplate)
  )
    throw new Error("UPSTREAM_NOT_ALLOWED");
  const path = config.pathTemplate.replace(
    /\{([^{}]+)\}/gu,
    (_match, name: string) => {
      const value = (input.path as Record<string, unknown> | undefined)?.[name];
      if (!["string", "number", "boolean"].includes(typeof value))
        throw new Error("PATH_INPUT_INVALID");
      const raw = String(value);
      if (raw.length > 200 || raw === "." || raw === "..")
        throw new Error("PATH_INPUT_INVALID");
      return encodeURIComponent(raw);
    },
  );
  if (path.includes("{") || path.includes("}"))
    throw new Error("PATH_INPUT_INVALID");
  if (
    path.split("/").some((segment) => {
      try {
        return [".", ".."].includes(decodeURIComponent(segment));
      } catch {
        return true;
      }
    })
  )
    throw new Error("UPSTREAM_NOT_ALLOWED");
  const basePath = base.pathname.replace(/\/$/u, "");
  const url = new URL(`${base.origin}${basePath}${path}`);
  if (url.origin !== base.origin || url.pathname.split("/").includes(".."))
    throw new Error("UPSTREAM_NOT_ALLOWED");
  const query = input.query;
  if (query !== undefined) {
    if (typeof query !== "object" || query === null || Array.isArray(query))
      throw new Error("INPUT_INVALID");
    for (const [key, value] of Object.entries(query)) {
      if (
        !/^[A-Za-z0-9_]{1,60}$/u.test(key) ||
        !["string", "number", "boolean"].includes(typeof value)
      )
        throw new Error("INPUT_INVALID");
      url.searchParams.set(key, String(value));
    }
  }
  if (config.authKind === "api_key_query") {
    const name = config.authTemplate?.parameterName;
    if (
      !name ||
      !/^[A-Za-z0-9_-]{1,80}$/u.test(name) ||
      url.searchParams.has(name)
    )
      throw new Error("UPSTREAM_AUTH_INVALID");
  } else if (!["none", "api_key_header", "bearer"].includes(config.authKind)) {
    throw new Error("OPERATION_NOT_DEMO_ELIGIBLE");
  }
  return url;
}

export async function readUpstreamSecret(
  config: OperationConfig,
): Promise<string | undefined> {
  if (config.authKind === "none") return undefined;
  const match = /^secret\/([a-f0-9-]{36})$/u.exec(config.vaultReference ?? "");
  const root = process.env.FACET_SECRET_ROOT;
  if (
    config.vaultProvider !== "local-fs" ||
    config.secretStatus !== "active" ||
    !match?.[1] ||
    !root
  )
    throw new Error("UPSTREAM_AUTH_UNAVAILABLE");
  const value = (
    await readFile(join(resolve(root), match[1]), "utf8").catch(() => {
      throw new Error("UPSTREAM_AUTH_UNAVAILABLE");
    })
  ).trim();
  if (!value || /[\r\n]/u.test(value)) throw new Error("UPSTREAM_AUTH_INVALID");
  return value;
}

export function redactSecret(
  value: unknown,
  secret: string | undefined,
): unknown {
  if (!secret) return value;
  if (typeof value === "string") return value.replaceAll(secret, "[REDACTED]");
  if (Array.isArray(value))
    return value.map((child) => redactSecret(child, secret));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key.replaceAll(secret, "[REDACTED]"),
        redactSecret(child, secret),
      ]),
    );
  return value;
}

export async function executeGet(
  config: OperationConfig,
  input: Record<string, unknown>,
): Promise<unknown> {
  validateInput(config.inputSchema, input);
  const url = buildUpstreamUrl(config, input);
  const secret = await readUpstreamSecret(config);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "FACET-local-demo",
  };
  if (secret) {
    if (config.authKind === "bearer")
      headers.authorization = `Bearer ${secret}`;
    else if (config.authKind === "api_key_header") {
      const name = config.authTemplate?.parameterName;
      if (
        !name ||
        !/^[A-Za-z0-9-]{1,80}$/u.test(name) ||
        ["host", "authorization", "cookie"].includes(name.toLowerCase())
      )
        throw new Error("UPSTREAM_AUTH_INVALID");
      headers[name] = secret;
    } else if (config.authKind === "api_key_query") {
      url.searchParams.set(config.authTemplate!.parameterName!, secret);
    }
  }
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/gu, ""), {
    all: true,
  });
  const selected = addresses.find(({ address }) => {
    if (!isIP(address)) return false;
    const parsed = ipaddr.parse(address);
    return parsed.range() === "unicast";
  });
  if (!selected) throw new Error("UPSTREAM_DNS_BLOCKED");
  const limit = Math.min(config.maxResponseBytes, 1_048_576);
  const timeout = Math.min(config.timeoutMs, 15_000);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers,
        timeout,
        lookup: (_host, options, callback) => {
          const family = isIP(selected.address) as 4 | 6;
          return options.all
            ? callback(null, [{ address: selected.address, family }])
            : callback(null, selected.address, family);
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`UPSTREAM_HTTP_${response.statusCode ?? 0}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            req.destroy(new Error("UPSTREAM_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve(
              redactSecret(
                JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
                secret,
              ),
            );
          } catch {
            reject(new Error("UPSTREAM_JSON_INVALID"));
          }
        });
        response.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("UPSTREAM_TIMEOUT")));
    req.on("error", reject);
    req.end();
  });
}
