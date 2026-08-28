# Mainnet Migration Guide

This document tracks every step required to move Bear Protocol from Stellar Testnet
to a production mainnet deployment. It covers smart-contract security, infrastructure
hardening, tokenomics validation, and legal/compliance considerations.

---

## Smart Contract Security

### Audit Scope

The following contracts are in scope for a production security audit before mainnet deployment:

| Contract           | Location                                | Purpose                                               |
| ------------------ | --------------------------------------- | ----------------------------------------------------- |
| `agent-identity`   | `contracts/agent-identity/src/lib.rs`   | Agent registration, ownership, and metadata registry  |
| `agentic-commerce` | `contracts/agentic-commerce/src/lib.rs` | Job escrow, funding, completion, and fee distribution |

### Known Risk Areas

#### 1. Re-entrancy in `complete()`

The `complete()` function in `agentic-commerce` performs token transfers **before** updating
the job state to `JobStatus::Completed`:

- `contracts/agentic-commerce/src/lib.rs` — `complete()` function: state update (`job.status = JobStatus::Completed`) now occurs **before** the token transfers (fixed in current codebase via checks-effects-interactions order)
- Verify during audit that no future refactor re-introduces transfer-before-state-update ordering

If the token contract (or any callee via hook/reflect) re-enters the commerce contract, it could
observe the job as still `Submitted` and trigger a second payout. The **checks-effects-interactions**
pattern must be maintained: update `job.status` to `Completed` before issuing any transfers.

#### 2. Integer Overflow in Fee Calculation

Fee math is performed with `i128`:

- `contracts/agentic-commerce/src/lib.rs` — `compute_fee()` helper: uses divide-first order (`budget / BPS_DENOM * fee_bps`) to avoid overflow
- `contracts/agentic-commerce/src/lib.rs` — `simulate_job_fee()`: mirrors the same divide-first expression with `checked_mul` fallback

`budget` is user-supplied (`i128`). A malicious client could submit a `budget` close to `i128::MAX`,
and the intermediate product `budget * fee_bps` could overflow before division. The current
implementation divides first (`budget / BPS_DENOM`) then multiplies by `fee_bps`, keeping the
intermediate value within safe range. `MAX_FEE_BPS` is capped at 500 (5%). Auditors should
confirm no path bypasses `compute_fee()`.

#### 3. Access Control Gaps

- **`agent-identity`** — All mutation paths (`register`, `update_uri`, `deregister`) correctly
  call `require_auth()` and validate ownership.
- **`agentic-commerce`** — All privileged/admin paths (`init`, `re_init`, `set_treasury`,
  `set_fee_bps`, `emergency_pause`, `emergency_unpause`) validate `caller == admin`.
  `create_job`, `submit`, `complete`, `cancel`, `dispute`, `claim_refund`, and `claim_expired`
  enforce role checks (`client`, `provider`, `evaluator`).

No missing `require_auth()` checks were found in the current codebase, but auditors should confirm
that any new entry points added post-audit follow the same pattern. Pay particular attention to
`dispute()` (`contracts/agentic-commerce/src/lib.rs`) which was added after initial review.

### Recommended Auditors

- **CertiK** — Smart contract auditing with Stellar/Soroban experience.
- **OpenZeppelin** — Security audits and contract review; strong Rust/soroban-sdk familiarity.
- **Kudelski Security** — Blockchain smart contract audits; prior Soroban ecosystem work.

---

## Infrastructure

### RPC Endpoint Migration

| Environment | Endpoint                                  |
| ----------- | ----------------------------------------- |
| Testnet     | `https://soroban-testnet.stellar.org`     |
| Mainnet     | `https://soroban-rpc.mainnet.stellar.org` |

Update all Soroban RPC clients (dashboard, backend services, CI deploys) to point to mainnet.
Sync the network passphrase to `Public Global Stellar Network ; September 2015`.

Update the SDK's `TESTNET` config export in `sdk/src/types.ts` to add a parallel `MAINNET`
config object, and update `dashboard/lib/config.ts` to read the target network from an
environment variable (`STELLAR_NETWORK=mainnet`).

### Wallet Support

- **Freighter** — Enable mainnet mode in the extension; ensure the dashboard detects and
  displays the connected mainnet network correctly (the current implementation always shows
  "Testnet" — see issue #226).
- **Ledger** — Confirm Ledger hardware wallet signing works against mainnet RPC endpoints.
  Verify `soroban` app firmware version is current before go-live.

### Rate Limiting on the Express Dashboard API

The Express dashboard API should enforce per-IP/per-wallet rate limits to prevent scraping
and abuse. Recommended defaults:

- 100 requests / 15 minutes per IP for public endpoints (e.g., job listings, agent search).
- 30 requests / 15 minutes per IP for authenticated actions (e.g., job creation, refunds).

Use middleware such as `express-rate-limit` with a shared store (Redis) for horizontal scaling.

### DDoS Protection for the Agent Registry

The agent registry (backed by the `agent-identity` contract + dashboard API) is a high-value
endpoint for adversarial traffic.

- Enable a CDN/WAF (Cloudflare, Fastly) in front of the dashboard API.
- Configure bot-management rules to block headless traffic and credential-stuffing attempts.
- Enable Stellar Horizon RPC caching where possible to reduce direct contract query load.
- Consider a gateway layer that enforces API-key authentication for programmatic consumers.
- Implement circuit-breaker logic in the agent registry service (`agents/registry/server.ts`)
  so it degrades gracefully under load rather than crashing and taking the discovery layer
  with it (related: issue #234).

---

## Tokenomics

### Fee Model Validation

Bear Protocol currently charges a **1% platform fee** (`fee_bps = 100`) on every completed job,
transferred directly to the treasury address at completion time. The fee is capped at a
**5% hard ceiling** (`MAX_FEE_BPS = 500`) enforced on-chain in `set_fee_bps()`.

**Is 1% sustainable?**

| Metric             | Conservative | Target    |
| ------------------ | ------------ | --------- |
| Monthly job volume | $10,000      | $500,000  |
| Protocol revenue   | $100 / mo    | $5,000/mo |
| Treasury balance   | Low          | Adequate  |

At $10k/month job volume, 1% yields $100/month — not enough to self-fund audits or
infrastructure. At $500k/month (comparable to small freelance platforms), 1% yields $5k/month
which is viable for a lean operation. The 5% cap provides headroom if the fee needs to be
raised, but any increase above 1% should be governed transparently (see treasury governance
below).

**Fee snapshots per job** — the fee is snapshotted at job creation time
(`contracts/agentic-commerce/src/lib.rs`, `create_job()`, field `job.fee_bps`), so admin
changes to the global rate never retroactively affect funded jobs. This is the correct design
for user trust.

### Treasury Address Governance

The treasury address is stored in instance storage and can be changed only by the admin
via `set_treasury()` or `re_init()`. For mainnet, the treasury should be:

1. **Multisig wallet** (e.g., Gnosis Safe on Stellar, or a native multisig account) — no
   single key holder should be able to drain protocol revenue unilaterally.
2. **Time-locked** — add a 48–72 hour delay on treasury-change transactions to allow the
   community to react to unexpected governance actions.
3. **DAO-governed (longer term)** — treasury spending proposals voted on-chain by token
   holders or a governing council. Not required for launch but should be on the 6-month
   roadmap.

**Recommended path to mainnet treasury:**

- Phase 1: 2-of-3 multisig among founding team members.
- Phase 2: 3-of-5 multisig including one independent community representative.
- Phase 3: On-chain governance contract with proposal/vote/execute lifecycle.

---

## Legal / Compliance

> **Disclaimer:** The following is an informational overview, not legal advice. Consult a
> qualified attorney familiar with blockchain/fintech regulation before launching on mainnet.

### KYC / AML Considerations for Agent-to-Agent Payments

Bear Protocol facilitates USDC transfers between AI agents (and the humans/organizations that
control them). Depending on jurisdiction, this may trigger money-transmission regulations.

Key questions to answer with legal counsel:

- **Are the protocol's users money services businesses (MSBs)?** If agents are used for
  commercial payments between independent legal entities, the operators of those agents may
  need MSB registration in the US (FinCEN) or equivalent licenses abroad.
- **Does the platform itself need a license?** A protocol that provides escrow infrastructure
  and collects fees may be characterized as a money transmitter or payment facilitator in some
  jurisdictions.
- **USDC issuer requirements** — Circle (USDC issuer) has its own terms of service. Confirm
  that the use case is compliant with Circle's acceptable-use policy before mainnet launch.
- **OFAC sanctions screening** — transfers to/from sanctioned addresses must be blocked.
  Consider integrating a sanctions-screening oracle or Chainalysis API at the dashboard API
  layer before funds enter the contract.

### Jurisdiction Analysis for Escrow Services

Bear's `agentic-commerce` contract implements a trustless escrow: a client locks funds, a
provider delivers, an evaluator approves, and funds are released automatically on-chain.

| Jurisdiction  | Escrow regulation summary                                                              |
| ------------- | -------------------------------------------------------------------------------------- |
| **USA**       | Escrow services often require state-level escrow agent licenses. Smart-contract escrow |
|               | legality varies by state; no federal framework exists yet. Seek counsel.               |
| **EU (MiCA)** | Markets in Crypto-Assets regulation (live 2024) covers crypto-asset service providers. |
|               | Evaluate whether operating the protocol constitutes a CASP under MiCA.                 |
| **UK**        | FCA oversight of crypto-asset activities. Non-custodial smart-contract escrow has less |
|               | regulatory surface than custodial alternatives, but review is recommended.             |
| **Singapore** | MAS Payment Services Act covers digital payment token services. Favorable environment  |
|               | for blockchain fintech; consider Singapore incorporation for the operating entity.     |

**Recommended approach for launch:**

1. Launch in jurisdictions with the most regulatory clarity first (e.g., EU with MiCA
   compliance, or Singapore).
2. Implement geo-blocking for jurisdictions where legal status is unresolved (e.g.,
   restrict dashboard access from certain US states pending legal review).
3. Include clear Terms of Service and a disclaimer that Bear Protocol is a trustless
   protocol and does not hold user funds on behalf of users.

---

## Migration Checklist

Use this checklist before any mainnet deployment:

### Smart Contracts

- [ ] Security audit completed by at least one reputable firm
- [ ] All audit findings resolved or accepted with written rationale
- [ ] Contracts deployed to mainnet via a reproducible, audited deploy script
- [ ] `init()` called with a multisig admin and treasury address (never an EOA)
- [ ] `fee_bps` set to intended production value
- [ ] Emergency pause tested end-to-end on a mainnet fork

### Infrastructure

- [ ] All RPC URLs updated to mainnet endpoints
- [ ] Network passphrase updated to `Public Global Stellar Network ; September 2015`
- [ ] Rate limiting enabled on dashboard API
- [ ] CDN/WAF in front of public endpoints
- [ ] Monitoring and alerting set up (Datadog, Grafana, PagerDuty, or equivalent)
- [ ] Incident response runbook written and distributed to team

### Tokenomics

- [ ] Treasury multisig configured and tested
- [ ] Fee model reviewed with economic model (see above)
- [ ] Fee snapshot behaviour confirmed via mainnet fork test

### Legal / Compliance

- [ ] Legal opinion obtained from qualified counsel
- [ ] Terms of Service published
- [ ] Privacy Policy published (especially if collecting any off-chain user data)
- [ ] OFAC/sanctions screening mechanism in place
- [ ] USDC acceptable-use policy review complete
