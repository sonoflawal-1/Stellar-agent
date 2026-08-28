# MARC on Stellar — Design Spec

**Date:** 2026-04-11
**Hackathon:** Stellar Hacks: Agents — x402 × Stripe MPP
**Deadline:** 48 hours from start
**Status:** Locked — no scope changes without explicit agreement

## Pitch

**MARC on Stellar — the commerce layer for agent payments.**

x402 and MPP handle _how_ agents pay. MARC handles _what they are paying for_. On top of Stellar's payment rails, MARC adds:

1. **Job escrow with delivery guarantees** (1% platform fee, ERC-8183-inspired)
2. **Agent identity registry** (ERC-8004-inspired)

Think of x402/MPP as the rail and MARC as the marketplace contract riding on top. Agents discover each other via the identity registry, agree on a job, escrow funds in MARC, deliver work through `x402-stellar`, and the escrow releases payment on approval.

## Why this is a credible hackathon entry

- **Real composability story.** We are not re-implementing x402 or MPP. We sit on top of them and use them as-is. Judges see a respectful integration, not a rebuild.
- **Clear revenue model.** 1% platform fee on job escrow is mathematically unbypassable at the contract level — same mechanism as MARC on Ethereum.
- **Story for the agent economy.** "Agents need a trust layer for multi-step work. Payments alone are not enough." This is a narrative judges understand.
- **Ports a known protocol.** MARC already exists on Ethereum (`marc-protocol/marc`). We are bringing it to Stellar — a legitimate multi-chain expansion narrative.

## Scope (locked)

### Building

| #   | Artifact                                                              | Tech                | Purpose                                                                                                                   |
| --- | --------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | `agentic_commerce` Soroban contract                                   | Rust                | Job escrow + 1% platform fee                                                                                              |
| 2   | `agent_identity` Soroban contract                                     | Rust                | Agent registration (address, metadata URI, optional domain)                                                               |
| 3   | `marc-stellar-sdk` TypeScript package                                 | Node                | Wrapper over `x402-stellar` + typed helpers for both contracts                                                            |
| 4   | CLI demo (`buyer-agent.ts`, `seller-agent.ts`, `lifecycle.ts`)        | Node                | Video-recordable end-to-end: register identity → create job → pay via x402 → deliver → release escrow                     |
| 5   | Static landing page (`index.html`)                                    | HTML/CSS/vanilla JS | Pitch, contract addresses, demo GIF, GitHub link. Visual identity 1:1 with `marcprotocol.com` per `docs/design-system.md` |
| 6   | README + 1-page LIGHTPAPER + 2-min pitch video + DoraHacks submission | Markdown / MP4      | Submission deliverables                                                                                                   |

### Frontend scope (LOCKED: landing page only)

We are building **one** static landing page (`landing/index.html` + `style.css` + `app.js`), not a dashboard app. The dashboard tabs shown on `marcprotocol.com` (Agents / Dashboard / Jobs / Wallet) are **cut** — a real dashboard would cost 6-10h and contribute nothing to the "commerce layer on x402/MPP" narrative judges care about. The CLI demo video is our functional proof; the landing page is our pitch surface.

Landing page structure (top to bottom):

1. **Nav bar** — logo + Home/Protocol/About + GitHub/X icons + "Launch Docs" orange pill (no app to launch — pill links to README)
2. **Hero** — wireframe geodesic sphere SVG, two-line headline ("The Commerce Layer for / Agent Payments."), subtitle, two pill CTAs (Read Docs, View on GitHub)
3. **Protocol stack section** — 3 cards: Agentic Commerce (Soroban escrow), Agent Identity (Soroban registry), x402 + MPP Integration (Stellar rails)
4. **How it works section** — numbered 4-step flow (register → create job → deliver via x402 → approve & release)
5. **Deployed contracts section** — contract addresses on Stellar testnet + Stellar Expert links
6. **Footer** — small print, links

Tech: plain HTML + CSS + vanilla JS (no React, no build step). Inter via Google Fonts CDN. Lucide icons via CDN. Visual tokens per `docs/design-system.md`. Hosted on Vercel (drag-and-drop deploy, no CI).

Time budget: **3-4 hours on Day 2**, after the CLI demo is working. If running behind, cut sections 4 and 5 first; keep nav + hero + protocol stack + footer at minimum.

### Not building (stretch only if Day 2 ends early)

- `agent_reputation` contract (feedback + scores)
- React dashboard app (Agents / Jobs / Wallet tabs from the reference site)
- Dark mode toggle on the landing page
- Animated geodesic sphere rotation
- Orange dot particle background
- Framework plugins (Virtuals GAME, OpenClaw, ElizaOS)
- Test suite beyond ~25 smoke tests
- Reputation-weighted escrow release
- Multi-token support (USDC only)
- Mainnet deployment (testnet only)

## Architecture

```
┌────────────────────┐         ┌────────────────────┐
│   Buyer Agent       │         │   Seller Agent     │
│  (CLI demo script)  │         │  (CLI demo script) │
└──────────┬──────────┘         └─────────┬──────────┘
           │                              │
           │  1. Discover seller via identity registry
           │  2. Create job + escrow funds
           │  3. Pay per-request via x402-stellar
           │  4. On delivery, approve and release escrow
           ▼                              ▲
┌─────────────────────────────────────────┴──────────┐
│              marc-stellar-sdk (TypeScript)          │
│  - commerce.ts   (job lifecycle helpers)            │
│  - identity.ts   (agent registration helpers)       │
│  - marcPaywall.ts (Express middleware)              │
│  - marcFetch.ts  (client auto-402)                  │
└────────────────────┬───────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
┌───────────┐  ┌──────────┐  ┌──────────────────┐
│  x402-    │  │ @stellar/│  │  Our Soroban      │
│  stellar  │  │ stellar- │  │  contracts        │
│  (npm)    │  │ sdk      │  │ - agentic_commerce│
│           │  │          │  │ - agent_identity  │
└───────────┘  └──────────┘  └──────────────────┘
        │            │             │
        └────────────┴─────────────┘
                     │
                     ▼
          ┌────────────────────┐
          │  Stellar Testnet    │
          │  (Soroban + Horizon)│
          └────────────────────┘
```

## Data flow: full agent lifecycle

```
0. Setup (one-time per agent)
   Buyer:  agent_identity.register(addr, "buyer.example.com", metadata_uri)
   Seller: agent_identity.register(addr, "seller.example.com", metadata_uri)
           Seller runs Express server with marcPaywall middleware

1. Job creation
   Buyer: commerce.create_job(
     seller = seller_addr,
     budget = 10_USDC,
     description_uri = "ipfs://..."
   ) -> job_id
   Contract: transfers 10 USDC from buyer -> contract escrow

2. Work delivery (per-request paid calls via x402)
   For each API call the seller provides:
     Buyer -> GET /api/work
     Seller -> 402 Payment Required (x402 envelope)
     Buyer signs Soroban auth entry, retries with payment
     x402 facilitator settles the micropayment
     Seller returns work result
   (These micropayments are separate from the job escrow. The escrow
    is the completion bonus / delivery guarantee.)

3. Delivery signaled
   Seller: commerce.mark_delivered(job_id, deliverable_uri = "ipfs://...")

4. Approval and release
   Buyer: commerce.approve(job_id)
   Contract:
     - 99% of budget -> seller
     - 1% of budget -> platform treasury
     - Emits JobCompleted event

5. Dispute path (not built for hackathon, documented only)
   Buyer can dispute within window. For hackathon: buyer-only approval.
```

## Contract designs (concise)

### `agentic_commerce` (Soroban, Rust)

**Storage:**

- `jobs: Map<u64, Job>` — keyed by auto-incrementing job_id
- `next_job_id: u64`
- `treasury: Address` — platform fee recipient
- `admin: Address` — can update treasury
- `platform_fee_bps: u32` — 100 (= 1%)

**Job struct:**

```rust
pub struct Job {
    pub buyer: Address,
    pub seller: Address,
    pub budget: i128,          // in stroops of USDC
    pub token: Address,         // Stellar Asset Contract for USDC
    pub description_uri: String,
    pub deliverable_uri: Option<String>,
    pub state: JobState,        // Created, Delivered, Approved, Cancelled
    pub created_at: u64,
}
```

**Entry points:**

- `create_job(buyer, seller, token, budget, description_uri) -> u64`
- `mark_delivered(seller, job_id, deliverable_uri)`
- `approve(buyer, job_id)` — splits payment 99/1
- `cancel(buyer, job_id)` — only if state == Created, returns funds to buyer
- `get_job(job_id) -> Job`
- `set_treasury(admin, new_treasury)`
- `set_platform_fee(admin, new_bps)` — capped at 500 (5%)

**Auth:** every state-changing call requires `caller.require_auth()`. Buyer-only for create/approve/cancel. Seller-only for mark_delivered.

**Events:** `JobCreated`, `JobDelivered`, `JobApproved`, `JobCancelled`, `TreasuryUpdated`.

### `agent_identity` (Soroban, Rust)

**Storage:**

- `agents: Map<Address, Agent>`
- `domains: Map<String, Address>` — reverse lookup
- `admin: Address`

**Agent struct:**

```rust
pub struct Agent {
    pub owner: Address,
    pub domain: String,            // e.g. "seller.example.com"
    pub metadata_uri: String,      // off-chain JSON (ERC-8004 style)
    pub registered_at: u64,
}
```

**Entry points:**

- `register(owner, domain, metadata_uri)` — owner.require_auth()
- `update_metadata(owner, metadata_uri)`
- `get_agent(owner) -> Option<Agent>`
- `resolve_domain(domain) -> Option<Address>`
- `deregister(owner)`

**Events:** `AgentRegistered`, `AgentUpdated`, `AgentDeregistered`.

## SDK design (concise)

```
marc-stellar-sdk/
├── src/
│   ├── index.ts         # re-exports
│   ├── types.ts         # Job, Agent, JobState types (mirror contract)
│   ├── commerce.ts      # createJob, markDelivered, approve, getJob
│   ├── identity.ts      # register, getAgent, resolveDomain
│   ├── marcPaywall.ts   # Express middleware wrapping x402-stellar
│   ├── marcFetch.ts     # client auto-402 wrapping x402-stellar
│   └── errors.ts        # MarcError hierarchy
├── package.json
└── tsconfig.json
```

Depends on:

- `@stellar/stellar-sdk`
- `x402-stellar`
- `express` (peer, for paywall)

## Testing strategy

Per contract: ~8–10 Soroban unit tests covering:

- Happy path (create → deliver → approve)
- Auth failures (wrong caller)
- Invalid state transitions
- Fee math
- Cancel path

SDK: ~5 smoke tests against a local Stellar quickstart network.

**No on-chain integration tests on testnet** — we deploy once, run the CLI demo once, record the video. Testnet tests eat time we do not have.

## File tree after implementation

```
marc-stellar/
├── .claude/skills/stellar-hackathon/SKILL.md     # already exists
├── contracts/
│   ├── agentic-commerce/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   └── agent-identity/
│       ├── Cargo.toml
│       └── src/lib.rs
├── Cargo.toml                                     # workspace root
├── sdk/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── types.ts
│       ├── commerce.ts
│       ├── identity.ts
│       ├── marcPaywall.ts
│       ├── marcFetch.ts
│       └── errors.ts
├── demo/
│   ├── package.json
│   ├── tsconfig.json
│   ├── buyer-agent.ts
│   ├── seller-agent.ts
│   └── lifecycle.ts
├── landing/
│   ├── index.html
│   └── style.css
├── docs/
│   ├── LIGHTPAPER.md
│   ├── PROTOCOL.md
│   └── superpowers/specs/
│       └── 2026-04-11-marc-stellar-design.md    # this file
├── scripts/
│   ├── build.sh                                  # cargo build + sdk build
│   └── deploy-testnet.sh                          # stellar contract deploy
└── README.md
```

## Deployment

- **Network:** Stellar testnet only
- **Tool:** `stellar contract deploy` via `scripts/deploy-testnet.sh`
- **Addresses:** written to `deployments/testnet.json` after deploy, consumed by SDK and demo

## Cut list (do NOT build)

- Reputation contract
- React frontend with tabs
- All framework plugins
- FHE anything — privacy is not in scope
- The Graph / Horizon subgraph indexer
- Mainnet deployment
- Security audit / formal verification
- GitHub Actions CI
- ConfidentialUSDC equivalent
- X402PaymentVerifier port (use Stellar's existing x402 facilitator)

## Risk register

| Risk                                        | Likelihood | Mitigation                                                                                                                            |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Soroban Rust syntax unfamiliar, eating time | High       | Use OpenZeppelin Stellar templates + `stellar-dev` skill as reference. Start with identity contract (simpler) to build muscle memory. |
| `x402-stellar` API surprises                | Medium     | Read its README + example in SKILL.md links before coding SDK. Prototype integration in an isolated script first.                     |
| Testnet USDC funding issues                 | Low        | Stellar Lab has testnet USDC faucet (covered in SKILL.md). Fund at start of Day 1.                                                    |
| Demo flakes during recording                | Medium     | Record end-to-end on Day 2 morning. If it flakes, we still have 4+ hours to fix before submission.                                    |
| Scope creep ("just one more contract")      | High       | This spec is locked. Any new contract requires explicit agreement and cutting something else.                                         |

## Success criteria (for submission)

1. ✅ Two Soroban contracts deployed to Stellar testnet with verified addresses
2. ✅ SDK published to a local workspace (not npm — too much friction in 48h)
3. ✅ CLI demo runs end-to-end without manual intervention
4. ✅ 2-minute pitch video recorded
5. ✅ Static landing page live on GitHub Pages or Vercel
6. ✅ DoraHacks submission form filled with repo link, video, landing page URL

## Timeline (48h countdown)

**Day 1**

- H 0–2: Project scaffolding, Cargo workspace, SDK skeleton, testnet account funding
- H 2–6: `agent_identity` contract + unit tests (warm-up contract)
- H 6–12: `agentic_commerce` contract + unit tests
- H 12–14: Deploy both to testnet, record addresses
- H 14–18: SDK implementation (commerce.ts, identity.ts, paywall, fetch)
- H 18–24: Buffer / catch-up / sleep

**Day 2**

- H 24–30: CLI demo scripts (buyer, seller, lifecycle)
- H 30–34: Landing page + README + LIGHTPAPER
- H 34–38: End-to-end dry run on testnet, fix bugs
- H 38–42: Record video, polish submission
- H 42–48: Submit, buffer for any last-minute issues

## Open questions for user

None. All decisions locked by AI with user authorization to decide.

## References

- Original MARC repo on disk: `/Users/ram/Desktop/marc`
- Hackathon resources: `.claude/skills/stellar-hackathon/SKILL.md`
- Design system (tokens + component specs): `docs/design-system.md`
- Live reference site (visual identity): `https://marcprotocol.com`
- MARC's ERC-8183 job escrow: `/Users/ram/Desktop/marc/contracts/AgenticCommerceProtocol.sol` (read before porting)
- MARC's ERC-8004 identity: `/Users/ram/Desktop/marc/contracts/AgentIdentityRegistry.sol` (read before porting)
