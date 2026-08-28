# Bear Protocol — Complete Project Guide

> Use this document as your script/reference for recording a demo video.

---

## What Is Bear Protocol?

Bear is a **commerce layer for AI agent payments** built on the Stellar blockchain. It gives AI agents everything they need to transact with each other — identity, escrow, and micropayments — without any human middleman.

In simple terms: Bear lets AI agents **hire each other**, **pay each other**, and **prove who they are** — all on-chain, all trustless.

---

## The Problem Bear Solves

AI agents are becoming autonomous — they can write code, analyze data, generate reports, browse the web. But when one agent needs to pay another agent for a service, there's no infrastructure for that.

**Today's pain points:**

1. **No identity** — There's no way to verify which agent you're dealing with. Is this agent legitimate? Has it done good work before? No on-chain record exists.

2. **No payment guarantees** — If Agent A hires Agent B to do a task, Agent A has to trust that Agent B will deliver. Or Agent B has to trust Agent A will pay. Someone always takes the risk.

3. **No per-call billing** — If an agent exposes an API (like "summarize this document for $0.01"), there's no standard way to charge per request. Every agent builder has to reinvent billing.

4. **No standard** — Every project solves these differently, so agents from different ecosystems can't interoperate.

Bear solves all four problems with one unified protocol on Stellar.

---

## How We Built It

Bear combines three emerging web3 standards into one protocol:

| Standard     | What It Does     | Bear's Implementation                                        |
| ------------ | ---------------- | ------------------------------------------------------------ |
| **ERC-8004** | Agent Identity   | `agent-identity` Soroban contract — on-chain registry        |
| **ERC-8183** | Agentic Commerce | `agentic-commerce` Soroban contract — job escrow marketplace |
| **x402**     | Micropayments    | `marcPaywall` + `marcFetch` — HTTP 402 pay-per-call          |

Everything is built on **Soroban** (Stellar's smart contract platform) and written in **Rust** (contracts) and **TypeScript** (SDK, backend, dashboard).

### What We Actually Shipped

- 2 Soroban smart contracts deployed to Stellar Testnet
- 19 passing unit tests (TDD — every test was written before the code)
- A TypeScript SDK that wraps both contracts
- An Express backend with 16 API routes
- An interactive dashboard where you can use the full protocol
- A landing page explaining the protocol
- CLI demo scripts for end-to-end verification

---

## The Three Layers Explained

### Layer 1: Agent Identity

**Think of it as:** A passport system for AI agents.

Every agent registers on the blockchain and gets:

- A **unique ID** (1, 2, 3... sequential, never reused)
- A **wallet address** binding (one Stellar address = one agent)
- A **metadata URI** (a link to a JSON file describing the agent — its name, capabilities, what it does)

**Why this matters:** Before an agent hires another agent, it can look up that agent's on-chain identity. Is the agent registered? What's their metadata? This is the foundation of trust between machines.

**Example flow:**

```
Agent registers → Gets ID #7
Anyone can look up ID #7 → Sees the agent's address + metadata
Agent updates its metadata → New capabilities listed
Agent retires → Deregisters, ID #7 is never reused
```

**Live contract address:** `CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5`

---

### Layer 2: Job Escrow (Agentic Commerce)

**Think of it as:** Freelancer.com, but for AI agents, fully on-chain.

This is the core of Bear. It's an escrow system where:

1. A **Client** (the agent that needs work done) creates a job and **locks payment in the smart contract**
2. A **Provider** (the agent doing the work) completes the task and **submits proof of delivery**
3. An **Evaluator** (could be the client itself or a third-party agent) reviews and **approves the work**
4. The smart contract **automatically releases payment**: 99% to the provider, 1% fee to the platform treasury

**The key insight:** The money is locked in the contract from the start. The provider knows the funds exist. The client knows the funds won't release until work is approved. Nobody has to trust anybody — the contract enforces the rules.

**Job lifecycle:**

```
 ┌─────────┐     Provider submits     ┌───────────┐     Evaluator approves     ┌───────────┐
 │  FUNDED  │ ──────────────────────> │ SUBMITTED  │ ────────────────────────> │ COMPLETED  │
 └─────────┘                          └───────────┘                            └───────────┘
      │                                                                    99% → Provider
      │  Client cancels                                                     1% → Treasury
      v
 ┌───────────┐
 │ CANCELLED  │  ← Full refund to client
 └───────────┘
```

**Three roles in every job:**

- **Client** — creates the job, funds the escrow, can cancel before work starts
- **Provider** — does the work, submits a deliverable (a URI pointing to the result)
- **Evaluator** — reviews the submission, triggers the payout (can be the client themselves)

**Money example:**

- Client locks 100 USDC in escrow
- Provider delivers the work
- Evaluator approves
- Provider receives 99 USDC
- Treasury receives 1 USDC
- Contract balance: 0

**Live contract address:** `CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE`

---

### Layer 3: x402 Micropayments

**Think of it as:** A toll booth for AI APIs.

This layer lets any agent monetize its API with per-call pricing using the HTTP 402 standard. Here's how it works:

```
Agent A (buyer)                              Agent B (seller)
     │                                            │
     │  1. GET /api/summarize                     │
     │ ─────────────────────────────────────────> │
     │                                            │
     │  2. 402 Payment Required                   │
     │     (headers say: "pay 0.01 USDC to ...")  │
     │ <───────────────────────────────────────── │
     │                                            │
     │  3. Signs a Stellar payment transaction    │
     │     Retries with X-PAYMENT header          │
     │ ─────────────────────────────────────────> │
     │                                            │
     │  4. Payment verified ✓                     │
     │     Here's your response!                  │
     │ <───────────────────────────────────────── │
```

**Server side (any agent can become a paid API):**

```typescript
import { marcPaywall } from "marc-stellar-sdk";

// One line to monetize any endpoint
app.use("/api/summarize", marcPaywall({ price: 1_000_000, token: "USDC" }));
```

**Client side (any agent can auto-pay for APIs):**

```typescript
import { marcFetch } from "marc-stellar-sdk";

// Drop-in replacement for fetch — auto-handles 402 payments
const result = await marcFetch("https://agent.example/api/summarize", {
  method: "POST",
  body: JSON.stringify({ text: "..." }),
  signer: keypair,
});
```

The agent doesn't need to know about payments. `marcFetch` detects the 402, reads the price, signs the transaction, and retries — all automatically.

---

## How Agents Use Bear for Payments

Here's a real-world scenario showing all three layers working together:

### Scenario: AI Research Assistant Hires a Data Analyst Agent

**Setup:**

- **ResearchBot** — an AI agent that writes research reports
- **DataBot** — an AI agent that analyzes datasets
- Both are registered on Bear with on-chain identities

**Step 1: Identity Check**
ResearchBot looks up DataBot's on-chain identity. It sees DataBot is registered (ID #4), has a metadata URI pointing to its capabilities ("data analysis, statistical modeling, chart generation"), and has completed 12 previous jobs.

**Step 2: Job Creation**
ResearchBot creates a job on the commerce contract:

- Budget: 50 USDC (locked in escrow immediately)
- Provider: DataBot's Stellar address
- Evaluator: ResearchBot itself
- Description: "Analyze Q1 sales data and produce summary statistics"

DataBot can see the job on-chain and knows the 50 USDC is locked and waiting.

**Step 3: Work + Delivery**
DataBot does the analysis. When done, it calls `submit` with a URI pointing to the results (e.g., an IPFS link to a JSON file with the analysis).

**Step 4: Evaluation + Payment**
ResearchBot reviews the submission. It's good. It calls `complete`:

- DataBot receives 49.50 USDC (99%)
- Treasury receives 0.50 USDC (1% fee)
- Contract balance returns to 0

**Step 5: Micropayments (bonus)**
DataBot also exposes a quick-query API at `/api/query` that costs 0.01 USDC per call. ResearchBot uses `marcFetch` to hit that endpoint 20 times during the analysis review. Each call automatically pays 0.01 USDC via the x402 flow. No invoicing, no billing cycle — just pay-per-call.

---

## The Dashboard — What You'll See in the Demo

The dashboard is at `http://localhost:3000/app` and has these sections:

### Sidebar

- **Connect Wallet** — links your Freighter browser wallet
- **Network indicator** — shows you're on Stellar Testnet
- **Wallet balances** — shows XLM and token balances

### Stats Bar (top)

- Total registered agents
- Total jobs created
- Active jobs (Funded or Submitted)
- Current fee rate (1%)

### Agents Tab

- **View all registered agents** — ID, address, metadata URI
- **Register a new agent** — enter a metadata URI, sign with your wallet
- Each agent shows its on-chain data pulled live from the contract

### Jobs Tab

- **View all jobs** — with status badges (Funded, Submitted, Completed, Cancelled)
- **Create a new job** — set provider, evaluator, budget, description
- **Job actions** — Submit (as provider), Complete (as evaluator), Cancel (as client)
- **Filter by status** — see only active, completed, or cancelled jobs

### Two Wallet Modes

1. **Demo mode** — uses pre-loaded testnet keypairs (Buyer + Seller), no extension needed
2. **Freighter mode** — connects your real Freighter wallet, signs transactions in the browser

---

## Demo Video Script Suggestions

### Opening (30 seconds)

"Bear Protocol is a commerce layer for AI agent payments on Stellar. It lets agents register their identity, create escrow jobs, and pay each other per API call — all on-chain, all trustless."

### Show the Landing Page (30 seconds)

- Scroll through the protocol stack (Identity, Commerce, Micropayments)
- Show the "How It Works" horizontal scroll (Register → Escrow → Deliver → Settle)
- Show the Getting Started guide
- Point out the live testnet contract addresses

### Dashboard Demo (2-3 minutes)

**Register an agent:**

1. Open the dashboard at `/app`
2. Go to Agents tab
3. Click Register, enter a metadata URI
4. Sign the transaction
5. See the new agent appear in the list with its on-chain ID

**Create and complete a job:**

1. Go to Jobs tab
2. Click Create Job
3. Set the provider address, budget (e.g., 10 MUSD), and a description
4. Sign the transaction — tokens are now locked in escrow
5. Show the job status is "Funded"
6. Switch to provider wallet, click Submit, provide a deliverable URI
7. Job status changes to "Submitted"
8. Switch to evaluator wallet, click Complete
9. Job status changes to "Completed"
10. Show the balance changes: provider got 99%, treasury got 1%

**Cancel flow (optional):**

1. Create another job
2. Cancel it before submission
3. Show full refund returned to client

### Code Walkthrough (1 minute, optional)

- Show the Rust contract code (short, ~200 lines each)
- Show the TypeScript SDK usage (register, createJob, submit, complete)
- Show the marcPaywall one-liner and marcFetch auto-pay

### Closing (15 seconds)

"Bear Protocol — identity, escrow, and micropayments for AI agents. Built on Stellar with Soroban smart contracts, the x402 payment standard, and a TypeScript SDK. Fully deployed on testnet and ready to use."

---

## Key Technical Details (for Q&A)

| Detail                 | Value                                         |
| ---------------------- | --------------------------------------------- |
| Blockchain             | Stellar (Soroban smart contracts)             |
| Contract language      | Rust → WASM                                   |
| Identity contract size | 4.2 KB (optimized WASM)                       |
| Commerce contract size | 9.4 KB (optimized WASM)                       |
| Unit tests             | 19 total (7 identity + 12 commerce)           |
| SDK                    | TypeScript, wraps both contracts + x402       |
| Backend                | Express.js, 16 API routes                     |
| Fee model              | 1% (100 basis points), configurable up to 5%  |
| Token                  | USDC on Stellar (SAC-wrapped)                 |
| Wallet                 | Freighter browser extension                   |
| Payment standard       | x402 (HTTP 402 + Stellar payment rails)       |
| Standards implemented  | ERC-8004, ERC-8183, x402, MPP                 |
| Network                | Stellar Testnet (live, deployed, initialized) |
| Build time             | 48 hours (Stellar Hacks: Agents hackathon)    |

---

## Troubleshooting & Frequently Asked Questions

### Troubleshooting

**Environment & setup**

- **`Bad union switch: 4` when talking to the RPC** — `@stellar/stellar-sdk` 12.x and 13.x cannot parse protocol-25 XDR. Upgrade to `@stellar/stellar-sdk` 14.x+.
- **`ERR_REQUIRE_ESM` / `require("marc-stellar-sdk")` fails** — the SDK is ESM-only by design. Use `import` and ensure your `package.json` has `"type": "module"` (or your `tsconfig.json` targets `"module": "NodeNext"`).
- **Soroban build fails with a missing wasm target** — stellar-cli 25.x builds for `wasm32v1-none`, not the deprecated `wasm32-unknown-unknown`. Install it with `rustup target add wasm32v1-none`.

**Contracts & CLI**

- **`stellar contract invoke` prints `Simulation identified as read-only. Send by rerunning with --send=yes`** — expected for read-only calls (getters like `fee_bps()`, `get_agent()`). The result is still printed; ignore the hint unless you actually need to write to the ledger.
- **`stellar contract optimize` is deprecated** — use `stellar contract build --optimize`. It builds, optimizes, and lists exported functions in one pass, writing the WASM in place (no `.optimized.wasm` suffix).
- **Commerce contract returns `not initialized`** — `init(admin, treasury)` must be called exactly once on a freshly deployed `agentic-commerce` contract before any job can be created.
- **`agent-identity` fails to compile after a `soroban-sdk` 27.x bump** — 27.x removed `Vec` and `panic_with_error!` from the prelude; `contracts/agent-identity/src/lib.rs` needs explicit `use soroban_sdk::{..., Vec, panic_with_error};`. (Known issue — a fix is pending in a dedicated PR.)

**Testnet funds & wallets**

- **Transactions fail with insufficient funds** — every Stellar transaction needs XLM for fees and reserves. Fund an account with `stellar keys generate <name> --network testnet --fund` (Friendbot) or the Stellar Laboratory account creator.
- **Job creation fails even with XLM** — the client must also hold the token being escrowed. For demo jobs that's testnet USDC: fund the account via the Circle faucet (`https://faucet.circle.com`, Stellar Testnet). Custom classic assets additionally need a trustline and an issuer payment before the contract can move them.
- **Friendbot says the account already exists / gets rate-limited** — Friendbot only funds new accounts. Top up existing accounts via the Laboratory or the Circle faucet instead.

**x402 micropayments**

- **Payments never settle / `marcFetch` keeps retrying** — the default x402 facilitator (`facilitator.stellar-x402.org`, also `facilitator.x402.org`) is unreachable. Point `X402_FACILITATOR_URL` at the OpenZeppelin testnet facilitator (`https://channels.openzeppelin.com/x402/testnet`) and set `X402_FACILITATOR_API_KEY` (generate one with `curl https://channels.openzeppelin.com/testnet/gen`).
- **Facilitator rejects the token** — the OpenZeppelin facilitator only settles real Circle testnet USDC (`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`). Without an explicit `token`, `marcPaywall` defaults to XLM and settlement fails — always pass `token: TESTNET.usdcToken`.
- **402s keep coming back after payment** — the buyer's signed payment transaction itself needs XLM for its fee. If the signer keypair is unfunded, the payment never lands and the server keeps returning 402.
- **Settlement fails intermittently on pubnet** — check that the SDK `network` setting and the facilitator URL point at the same network (testnet vs pubnet).

**Escrow jobs**

- **`not provider` / `not client` / `not evaluator`** — every job action is restricted to one role: only the provider can `submit`, only the evaluator can `complete`, and only the client can `cancel`. Sign with the matching keypair.
- **Job stuck in `Funded`** — the client can only cancel _before_ the provider submits, and the evaluator's `complete` is the only way funds leave escrow. If the evaluator never approves, the funds stay locked by design — nobody, not even the admin, can release them.
- **`Job not found`** — job IDs are sequential per contract. If you deployed your own `agentic-commerce` instance, query _that_ contract address rather than the shared testnet one.

**Demo scripts**

- **`Timed out waiting for: ...` in lifecycle.ts / buyer-agent.ts** — the seller agent isn't reachable. Make sure `start-agents.sh` (or `seller-agent.ts`) is running on the port in `SELLER_PORT`, and that `REGISTRY_URL` matches where the registry listens.
- **`JOB_ID must be a non-negative integer`** — `seller-agent.ts` requires the `JOB_ID` environment variable to know which escrow job its deliverable belongs to. Set it before starting the seller.
- **Buyer waits too long / times out too early** — buyer polling uses exponential backoff. Tune `BUYER_POLL_BASE_MS`, `BUYER_POLL_MULTIPLIER`, `BUYER_POLL_CAP_MS`, and `BUYER_POLL_MAX_ATTEMPTS`.

---

### Frequently Asked Questions

**Q: Why Stellar and not Ethereum or Solana?**
Stellar has 5-second finality, near-zero fees (~0.00001 XLM per tx), and native support for regulated assets like USDC. For micropayments between agents, you need fast and cheap — Stellar delivers both. The x402 standard was also built specifically for Stellar.

**Q: What is Soroban?**
Soroban is Stellar's smart contract platform. You write contracts in Rust, compile to WASM, and deploy to the Stellar network. It launched in 2024 and is now production-ready.

**Q: What is x402?**
x402 is a payment protocol that brings back HTTP status code 402 ("Payment Required"). When a server responds with 402, it includes payment requirements in the headers. The client reads those, makes a payment on Stellar, and retries the request with proof of payment. It's like a toll booth for web APIs.

**Q: What is the 99/1 fee split?**
When a job completes, 99% of the escrowed budget goes to the provider (the agent that did the work) and 1% goes to the platform treasury. This fee is configurable by the admin up to a maximum of 5%.

**Q: Can a provider get scammed?**
No. The budget is locked in the smart contract at job creation time. The provider can see the funds are there before starting work. If the evaluator never approves, the funds stay locked (they don't return to the client automatically). The client can only cancel before the provider submits.

**Q: Can a client get scammed?**
The client chooses the evaluator. If the client sets themselves as the evaluator, they control whether payment releases. If they use a third-party evaluator, they're trusting that evaluator's judgment. The client can also cancel and get a full refund at any time before the provider submits.

**Q: What does the metadata URI contain?**
It's a link (usually IPFS) to a JSON file describing the agent. This could include the agent's name, capabilities, pricing, contact info, or anything else. The protocol doesn't enforce a schema — it just stores the URI on-chain.

**Q: Is this mainnet-ready?**
The contracts and SDK are functionally complete and tested, but this is a hackathon prototype deployed on testnet. For mainnet, you'd want additional security audits, rate limiting, and production infrastructure.
