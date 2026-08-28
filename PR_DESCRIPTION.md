# Fix: Dashboard Freighter support, seller agent refactor, and stability improvements

## Summary

Resolves multiple issues across the dashboard and seller agents: adds Freighter wallet registration, extracts shared seller agent boilerplate, validates `jobId` inputs, and fixes relative output paths.

## Changes

### Dashboard — Freighter wallet registration

- `dashboard/server.ts` — `/api/agents/register` now accepts `wallet: "freighter"` and returns an unsigned XDR via the existing `buildTxXdr` flow, instead of crashing.
- `dashboard/public/app.js` — Unified the Freighter-connected register path to call `/agents/register` directly instead of the separate `/build/register` endpoint.
- `dashboard/server.ts` — Fixed Zod v4 compatibility (`err.errors` -> `err.issues`).

### Dashboard — Type safety

- `dashboard/server.ts` — Added missing Zod schema parsing in `/api/jobs/create` and `/api/build/createJob`, eliminating undefined `parsed` references.

### Seller agents — Shared helper

- `agents/shared.ts` — Extracted `createSellerAgent({ id, port, agentDir })` which encapsulates config loading, identity registration, heartbeat, Express app creation, and logging middleware.
- `agents/seller-webbuilder/index.ts`, `agents/seller-copywriter/index.ts`, `agents/seller-namer/index.ts`, `agents/seller-researcher/index.ts` — All 4 agents now use the shared helper, reducing duplicated boilerplate from 4 copies to 1.

### Seller agents — Validation & stability

- All 4 seller agents — Added `if (!jobId || isNaN(Number(jobId)))` validation before `BigInt(jobId)` to prevent crashes on malformed requests.
- All 4 seller agents — Replaced relative `"output"` paths with `path.join(AGENT_DIR, "output")` using `path.dirname(fileURLToPath(import.meta.url))` so outputs are written relative to the agent directory, not CWD.

## Test plan

- CI runs `cargo test` (Rust workspace); our changes are isolated to JS/TS and do not affect it.
- Dashboard TypeScript compiles without new errors from this diff.
- No merge conflict markers remain.

## Related issues

- Dashboard unusable for Freighter users
- Seller agent boilerplate duplication
- Seller agent crash on invalid `jobId`
