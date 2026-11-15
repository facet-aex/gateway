# gateway

Local Demo Track execution entrypoint for one published, read-only GitHub repository lookup.

**Status:** free invocation and paid x402 invocation are verified with a provider-published Facet, MCP, real GitHub response and one confirmed fUSD transfer on Fuji. The browser and agents call this service, never provider endpoints directly. See the root `docs/implementation/demo-runbook.md` for transaction evidence.

Run `npm ci`, copy `.env.example` to ignored `.env`, set `DATABASE_URL`, run `npm run db:migrate`, then `npm run dev`. The server listens on loopback port 4020 by default. It accepts `POST /v1/facet-versions/{versionId}/invoke` with `{ "input": { "path": { "owner": "octocat", "repo": "Hello-World" } } }` and an `Idempotency-Key` header. The Facet must be published, PUBLIC and a read-only GET. The endpoint may use a public HTTPS host; Gateway validates its DNS result, denies redirects and bounds response size/time. For API key or Bearer endpoints, set `FACET_SECRET_ROOT` to the same **absolute** local secret directory configured for Control API. Same-key replay returns the stored result. Enable `FACET_DEMO_X402_ENABLED=1` only after the facilitator is live and the payer is funded. A crash during upstream execution leaves the Run in progress for manual inspection; automatic recovery is deferred. This local process is not a production egress sandbox.

For the supervised demo, the Gateway stores the public GitHub result and signed payment payload in local PostgreSQL to support replay and settlement. These records have no encryption or TTL. Do not use sensitive input/output, public deployment or production-value payment on this path.

Dependencies: Fastify 5.12.8 (MIT) serves local HTTP; pg 8.23.1 (MIT) accesses local PostgreSQL; Ajv 8.20.0 (MIT) validates input; ipaddr.js 2.2.0 (MIT) rejects non-public DNS results; official `@x402/core` 2.30.0 (Apache-2.0) handles x402 headers. TypeScript, tsx, Vitest and Prettier are development dependencies.
