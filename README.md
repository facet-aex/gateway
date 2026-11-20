# FACET Gateway (`@facet/gateway`)

[![FACET](https://img.shields.io/badge/FACET-facet.briandev.space-050505?style=flat-square&labelColor=DFFF4F)](https://facet.briandev.space)
[![Layer](https://img.shields.io/badge/RUNTIME-EXECUTION%20GATEWAY-0D0D0D?style=flat-square&labelColor=343434)](https://github.com/facet-aex)

> Unified execution entrypoint and HTTP x402 payment enforcement gateway for published FACET capabilities.

## Overview

`gateway` is the public runtime invocation router for **FACET**. Every paid or free call to a published `API`, `ACTOR`, or `AGENT` Facet from the Web Playground, CLI, or MCP clients flows through its versioned invocation endpoint (`/v1/facets/:provider/:facetName/versions/:version/invoke`).

## Role in FACET

- **Single Execution Contract:** Validates caller inputs against the pinned `FacetVersion` JSON Schema and enforces `(callerId, facetVersionId, idempotencyKey)` replay protection.
- **x402 Billing Orchestration:** Issues HTTP `402 Payment Required` challenges across configured pricing options (`PAY_PER_RUN` and `PAY_PER_RESULT`) and delegates verification and settlement to `x402-facilitator`.
- **Multi-Modal Dispatch & Hardening:** Executes full-HTTP `API` upstream calls with DNS/IP pinning, SSRF checks, and write-only secret injection, while routing `ACTOR` and `AGENT` workloads to `executor`.
- **Run & Dataset Persistence:** Records run states, normalized dataset outputs, and on-chain payment/receipt references in PostgreSQL.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime & HTTP | Node.js 24 (ESM), TypeScript, Fastify 5 |
| Database | PostgreSQL (`pg`) |
| Protocol & Security | `@x402/core`, Ajv (JSON Schema), `ipaddr.js` |
| Testing & Container | Vitest, Prettier, Docker (`node:24-alpine`) |

---

Part of **[FACET](https://facet.briandev.space)** (`facet-aex`) — Federated Agent Capability Exchange & Trust on Avalanche.
