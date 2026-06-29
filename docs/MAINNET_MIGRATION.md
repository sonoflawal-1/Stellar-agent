# Mainnet Migration Guide

## Smart Contract Security

### Audit Scope

The following contracts are in scope for a production security audit before mainnet deployment:

| Contract | Location | Purpose |
|----------|----------|---------|
| `agent-identity` | `contracts/agent-identity/src/lib.rs` | Agent registration, ownership, and metadata registry |
| `agentic-commerce` | `contracts/agentic-commerce/src/lib.rs` | Job escrow, funding, completion, and fee distribution |

### Known Risk Areas

#### 1. Re-entrancy in `complete()`

The `complete()` function in `agentic-commerce` performs token transfers **before** updating the job state to `JobStatus::Completed`:

- `contracts/agentic-commerce/src/lib.rs:219-225` — transfers to provider and treasury
- `contracts/agentic-commerce/src/lib.rs:227-228` — state update happens after transfers

If the token contract (or any callee via hook/reflect) re-enters the commerce contract, it could observe the job as still `Submitted` and trigger a second payout. Apply the **checks-effects-interactions** pattern: update `job.status` to `Completed` before issuing transfers.

#### 2. Integer Overflow in Fee Calculation

Fee math is performed with `i128`:

- `contracts/agentic-commerce/src/lib.rs:216` — `budget * (fee_bps as i128) / BPS_DENOM`
- `contracts/agentic-commerce/src/lib.rs:303` — `simulate_job_fee` mirrors the same expression

`budget` is user-supplied (`i128`). A malicious client could submit a `budget` close to `i128::MAX`, and the intermediate product `budget * fee_bps` could overflow before division. The `MAX_FEE_BPS` cap (5%) limits the multiplier but does not eliminate the risk for saturating inputs. Add explicit overflow checks or use `saturating_mul`.

#### 3. Access Control Gaps

- **`agent-identity`** — All mutation paths (`register`, `update_uri`, `deregister`) correctly call `require_auth()` and validate ownership.
- **`agentic-commerce`** — All privileged/admin paths (`init`, `set_treasury`, `set_fee_bps`) validate `caller == admin`. `create_job`, `submit`, `complete`, `cancel`, and `claim_refund` enforce role checks (`client`, `provider`, `evaluator`).

No missing `require_auth()` checks were found in the current codebase, but auditor review should confirm that future functions added to these contracts follow the same pattern.

### Recommended Auditors

- **CertiK** — Smart contract auditing with Stellar/Soroban experience.
- **OpenZeppelin** — Security audits and contract review; strong Rust/soroban-sdk familiarity.
- **Kudelski Security** — Blockchain smart contract audits; prior Soroban ecosystem work.

## Infrastructure

### RPC Endpoint Migration

| Environment | Endpoint |
|-------------|----------|
| Testnet | `https://soroban-testnet.stellar.org` |
| Mainnet | `https://soroban-rpc.mainnet.stellar.org` |

Update all Soroban RPC clients (dashboard, backend services, CI deploys) to point to mainnet. Sync the network passphrase to `Public Global Stellar Network ; September 2015`.

### Wallet Support

- **Freighter** — Enable mainnet mode in the extension; ensure the dashboard detects and displays the connected mainnet network.
- **Ledger** — Confirm Ledger hardware wallet signing works against mainnet RPC endpoints. Verify `soroban` app firmware version is current.

### Rate Limiting on the Express Dashboard API

The Express dashboard API should enforce per-IP/per-wallet rate limits to prevent scraping and abuse. Recommended defaults:

- 100 requests / 15 minutes per IP for public endpoints (e.g., job listings, agent search).
- 30 requests / 15 minutes per IP for authenticated actions (e.g., job creation, refunds).

Use middleware such as `express-rate-limit` with a shared store (Redis) for horizontal scaling.

### DDoS Protection for the Agent Registry

The agent registry (backed by `agent-identity` contract + dashboard API) is a high-value endpoint.

- Enable a CDN/WAF (Cloudflare, Fastly) in front of the dashboard API.
- Configure bot-management rules to block headless traffic and credential-stuffing attempts.
- Enable Stellar Horizon RPC caching where possible to reduce direct contract query load.
- Consider a gateway layer that enforces API-key authentication for programmatic consumers.
