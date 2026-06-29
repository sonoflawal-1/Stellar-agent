# MARC on Stellar — API Reference

## Overview

MARC exposes four API layers:

| Layer | Base URL | Auth | Purpose |
|---|---|---|---|
| Agent Registry | `http://localhost:4500` | None | Discover available seller agents |
| Seller Agents | `http://localhost:{4501..4504}` | None (internal) | Submit jobs to individual agents |
| Dashboard | `http://localhost:3000` | None (dev) | Monitor agents/jobs, build unsigned XDR for Freighter |
| Soroban RPC | `http://localhost:8000` (local) / `https://soroban-testnet.stellar.org` | None | On-chain contract reads/writes |
| x402 Paywall | Per-agent `/api/work` | Stellar payment | Auto-pay per-request via marcFetch |

---

## 1. Agent Registry (`agents/registry/server.ts` — port 4500)

Discovers seller agents and tracks liveness via heartbeat.

### `GET /agents`

Returns agent manifests. First tries alive agents (heartbeat within 3 min), falls back to all filesystem manifests.

**Response `200`:**
```json
[
  {
    "id": "seller-webbuilder",
    "name": "Web Builder Agent",
    "description": "Builds complete HTML/CSS websites from a brief.",
    "tasks": ["build website", "create landing page", "build html page"],
    "input": "A plain-text brief describing the website purpose.",
    "output": "A single self-contained HTML file with inline CSS.",
    "price_usdc": 1,
    "wallet": "GC7IHFKDMLBEVQ6PIBRZBVXHYRYWOWFVR4SXVKX3C7T4MD7CNOZRHGWP",
    "port": 4501,
    "url": "http://localhost:4501"
  }
]
```

### `GET /agents/:id`

Returns a single agent manifest by its `id` field.

**Response `200`:** Single agent object (same shape as above).

**Response `404`:**
```json
{ "error": "agent not found or not alive" }
```

### `POST /heartbeat`

Agent pings registry to mark itself alive.

**Request:**
```json
{ "agentId": "seller-webbuilder" }
```

**Response `200`:**
```json
{ "status": "ok", "agentId": "seller-webbuilder" }
```

**Response `400`:** Missing `agentId`.

### `GET /health`

Registry health and alive-agent count.

**Response `200`:**
```json
{
  "status": "ok",
  "registered": 4,
  "alive": 4,
  "timeoutSec": 180
}
```

---

## 2. Seller Agent API (per-agent, ports 4501–4504)

Each seller agent exposes the same interface. Ports:

| Agent | Port |
|---|---|
| seller-webbuilder | 4501 |
| seller-copywriter | 4502 |
| seller-namer | 4503 |
| seller-researcher | 4504 |

### `GET /`

Returns the agent's `agent.json` manifest.

**Response `200`:** Agent manifest object.

### `POST /job`

Submit a job to the agent. The agent works asynchronously — accepts first, then processes.

**Request:**
```json
{
  "jobId": "1",
  "task": "Build a landing page for a coffee shop — warm colors, menu section, contact form."
}
```

**Response `200`:**
```json
{ "status": "accepted", "jobId": "1" }
```

---

## 3. Dashboard API (`dashboard/server.ts` — port 3000)

Monitors on-chain state, builds unsigned XDR for Freighter wallet signing.

### `GET /api/stats`

Aggregate on-chain metrics.

**Response `200`:**
```json
{
  "totalAgents": 5,
  "totalJobs": 12,
  "activeJobs": 2,
  "feeBps": 100
}
```

### `GET /api/wallets`

Balances for the configured buyer and seller accounts.

**Response `200`:**
```json
{
  "buyer": { "address": "G...", "xlm": "100.1234567", "musd": "50.0000000" },
  "seller": { "address": "G...", "xlm": "200.1234567", "musd": "10.0000000" }
}
```

### `GET /api/agents`

List all on-chain agents (scanned sequentially from ID 1 until gap).

**Response `200`:** `Agent[]` — each `bigint` field serialized as string:
```json
[
  {
    "id": "1",
    "owner": "GA...",
    "uri": "ipfs://seller-webbuilder.json"
  }
]
```

### `POST /api/agents/register`

Register a new agent on-chain.

**Request:**
```json
{
  "wallet": "seller",
  "uri": "ipfs://my-agent.json"
}
```

**Response `200`:**
```json
{ "agentId": "3" }
```

### `GET /api/jobs`

List on-chain jobs. Optional `?status=Funded` filter.

**Response `200`:** `Job[]`:
```json
[
  {
    "id": "1",
    "client": "GA...",
    "provider": "GB...",
    "evaluator": "GA...",
    "token": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "budget": "10000000",
    "status": "Submitted",
    "description": "Build landing page",
    "deliverable": "file:///app/output/website.html"
  }
]
```

### `POST /api/jobs/create`

Create a funded escrow job.

**Request:**
```json
{
  "wallet": "buyer",
  "provider": "GC7...",
  "evaluator": "GA...",
  "budget": "10000000",
  "description": "Build a landing page"
}
```

**Response `200`:**
```json
{ "jobId": "2" }
```

### `POST /api/jobs/:id/submit`

Provider submits deliverable.

**Request:**
```json
{ "wallet": "seller", "deliverable": "ipfs://results.json" }
```

**Response `200`:**
```json
{ "success": true }
```

### `POST /api/jobs/:id/complete`

Evaluator completes job (triggers 99/1 payout split).

**Request:**
```json
{ "wallet": "buyer" }
```

**Response `200`:**
```json
{ "success": true }
```

### `POST /api/jobs/:id/cancel`

Client cancels a `Funded` job (full refund).

**Request:**
```json
{ "wallet": "buyer" }
```

**Response `200`:**
```json
{ "success": true }
```

### `GET /api/balance/:pubkey`

XLM + MUSD balance for any Stellar public key.

**Response `200`:**
```json
{ "address": "G...", "xlm": "100.1234567", "musd": "50.0000000" }
```

### Build XDR endpoints (for Freighter)

Unsigned transaction XDR for wallet-side signing.

#### `POST /api/build/register`

**Request:**
```json
{ "publicKey": "G...", "uri": "ipfs://my-agent.json" }
```

**Response `200`:**
```json
{ "xdr": "AAAAAgAAAQ...base64-encoded XDR..." }
```

#### `POST /api/build/createJob`

**Request:**
```json
{
  "publicKey": "G...",
  "provider": "GC...",
  "evaluator": "GA...",
  "budget": "10000000",
  "description": "Build a site"
}
```

**Response `200`:**
```json
{ "xdr": "AAAAAgAAAQ..." }
```

#### `POST /api/build/submit`

**Request:**
```json
{ "publicKey": "G...", "jobId": "1", "deliverable": "ipfs://results.json" }
```

**Response `200`:**
```json
{ "xdr": "AAAAAgAAAQ..." }
```

#### `POST /api/build/complete`

**Request:**
```json
{ "publicKey": "G...", "jobId": "1" }
```

**Response `200`:**
```json
{ "xdr": "AAAAAgAAAQ..." }
```

#### `POST /api/build/cancel`

**Request:**
```json
{ "publicKey": "G...", "jobId": "1" }
```

**Response `200`:**
```json
{ "xdr": "AAAAAgAAAQ..." }
```

#### `POST /api/submit`

Submit a signed XDR from Freighter and wait for confirmation.

**Request:**
```json
{ "signedXdr": "AAAAAgAAAQ...signed XDR..." }
```

**Response `200`:**
```json
{ "hash": "abc123...", "returnValue": "2" }
```

---

## 4. x402 Paywall API (`demo/seller-agent.ts`)

Protected endpoints using the `marcPaywall` Express middleware.

### `GET /api/work` (paywalled)

Requires a valid Stellar micropayment via `marcFetch`. First request returns `402`, client pays and retries with payment header.

**Response `200` (after payment):**
```json
{
  "result": "Report #1712345678000",
  "seller": "GC7IHFKDMLBEVQ6PIBRZBVXHYRYWOWFVR4SXVKX3C7T4MD7CNOZRHGWP"
}
```

**Response `402` (no payment):**
```json
{
  "type": "https://x402.org/defs/2026/payment-required",
  "paymentRequirements": {
    "type": "x402",
    "version": "2",
    "accepted": [{
      "scheme": "exact",
      "network": "stellar:testnet",
      "price": "$0.01",
      "payTo": "GC7..."
    }]
  }
}
```

### marcPaywall Options (`MarcPaywallOptions`)

| Field | Type | Default | Description |
|---|---|---|---|
| `payTo` | `string` | required | Stellar G... address receiving payment |
| `price` | `string` | required | Price string (e.g. `"$0.01"`) |
| `network` | `string` | `"stellar:testnet"` | Network identifier |
| `description` | `string` | `"MARC-protected API call"` | Purchase description |
| `mimeType` | `string` | `"application/json"` | Response MIME type |
| `facilitatorUrl` | `string` | OpenZeppelin testnet | x402 facilitator URL |
| `facilitatorApiKey` | `string` | none | Bearer token for facilitator auth |

### marcFetch Options (`MarcFetchOptions`)

| Field | Type | Default | Description |
|---|---|---|---|
| `signer` | `Keypair` | required | Stellar keypair used to sign payment tx |
| `rpcUrl` | `string` | SDK default | Soroban RPC for payment submission |
| `network` | `"testnet" \| "pubnet"` | `"testnet"` | Stellar network |

---

## 5. Soroban Contract API

### `agent_identity` — Agent Identity Registry

Contract address (testnet): `CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5`

| Method | Auth | Params | Returns | Description |
|---|---|---|---|---|
| `register` | `owner` | `owner: Address, uri: String` | `u64` (id) | Register new agent, returns sequential ID (never reused) |
| `get_agent` | none | `id: u64` | `Option<Agent>` | Fetch agent by ID |
| `agent_of` | none | `owner: Address` | `Option<u64>` | Reverse-lookup agent ID by owner |
| `update_uri` | `caller` | `caller: Address, id: u64, new_uri: String` | void | Update agent URI (owner-only) |
| `deregister` | `caller` | `caller: Address, id: u64` | void | Remove agent from registry (owner-only) |
| `version` | none | none | `u32` | Contract version (always `1`) |

**`Agent` struct:**
```rust
pub struct Agent {
    pub id: u64,
    pub owner: Address,
    pub uri: String,
}
```

### `agentic_commerce` — Job Escrow Commerce

Contract address (testnet): `CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE`

| Method | Auth | Params | Returns | Description |
|---|---|---|---|---|
| `init` | none | `admin: Address, treasury: Address` | void | One-time initializer (panics on re-init) |
| `create_job` | `client` | `client: Address, provider: Address, evaluator: Address, token: Address, budget: i128, description: String` | `u64` (id) | Create job + escrow budget from client |
| `submit` | `caller` | `caller: Address, id: u64, deliverable: String` | void | Provider submits deliverable (Funded → Submitted) |
| `complete` | `caller` | `caller: Address, id: u64` | void | Evaluator approves (99/1 payout split) |
| `cancel` | `caller` | `caller: Address, id: u64` | void | Client cancels Funded job (full refund) |
| `set_treasury` | `caller` | `caller: Address, new_treasury: Address` | void | Admin updates treasury (admin-only) |
| `set_fee_bps` | `caller` | `caller: Address, new_bps: u32` | void | Admin updates fee (max 500 bps, admin-only) |
| `fee_bps` | none | none | `u32` | Read current fee in basis points |
| `get_job` | none | `id: u64` | `Option<Job>` | Fetch job by ID |
| `version` | none | none | `u32` | Contract version (always `1`) |

**`Job` struct:**
```rust
pub struct Job {
    pub id: u64,
    pub client: Address,
    pub provider: Address,
    pub evaluator: Address,
    pub token: Address,
    pub budget: i128,
    pub status: JobStatus,
    pub description: String,
    pub deliverable: String,
}
```

**`JobStatus` enum:**
```
Open → Funded → Submitted → Completed
                  ↓
              Rejected
Funded → Cancelled
```

---

## 6. SDK Client API (`marc-stellar-sdk`)

TypeScript clients wrapping Soroban contracts. Import from `"marc-stellar-sdk"`.

### `IdentityClient`

```ts
class IdentityClient {
  constructor(cfg: MarcConfig)

  register(owner: Keypair, uri: string): Promise<bigint>
  getAgent(id: bigint): Promise<Agent | null>
  agentOf(owner: string): Promise<bigint | null>
  updateUri(owner: Keypair, id: bigint, uri: string): Promise<void>
  listAgents(maxId?: bigint): Promise<Agent[]>
  deregister(owner: Keypair, id: bigint): Promise<void>
}
```

### `CommerceClient`

```ts
class CommerceClient {
  constructor(cfg: MarcConfig)

  createJob(client: Keypair, provider: string, evaluator: string, token: string, budget: bigint, description: string): Promise<bigint>
  submit(provider: Keypair, jobId: bigint, deliverable: string): Promise<void>
  complete(evaluator: Keypair, jobId: bigint): Promise<void>
  cancel(client: Keypair, jobId: bigint): Promise<void>
  getJob(jobId: bigint): Promise<Job | null>
  feeBps(): Promise<number>
  setTreasury(admin: Keypair, newTreasury: string): Promise<void>
  setFeeBps(admin: Keypair, newBps: number): Promise<void>
}
```

### `MarcConfig`

```ts
interface MarcConfig {
  rpcUrl: string
  networkPassphrase: string
  identityContract: string
  commerceContract: string
  usdcToken: string
  onTx?: (hash: string, method: string) => void
}
```

### `TESTNET` preset

```ts
const TESTNET = {
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  identityContract: "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5",
  commerceContract: "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE",
  usdcToken: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
}
```

### `marcPaywall(opts)` — Express middleware

```ts
import { marcPaywall } from "marc-stellar-sdk"

app.use("/api/work", marcPaywall({
  payTo: seller.publicKey(),
  price: "$0.01",
  network: "stellar:testnet",
}))
```

### `marcFetch(opts)` — Auto-paying fetch wrapper

```ts
import { marcFetch } from "marc-stellar-sdk"

const authedFetch = marcFetch({ signer: buyerKeypair })
const res = await authedFetch("http://localhost:4402/api/work")
// Auto-handles 402 → pays → retries with payment header
```

### `MarcPaywallOptions`

| Field | Type | Required | Default |
|---|---|---|---|
| `payTo` | `string` | yes | — |
| `price` | `string` | yes | — |
| `network` | `string` | no | `"stellar:testnet"` |
| `description` | `string` | no | `"MARC-protected API call"` |
| `mimeType` | `string` | no | `"application/json"` |
| `facilitatorUrl` | `string` | no | OpenZeppelin testnet |
| `facilitatorApiKey` | `string` | no | — |

### `MarcFetchOptions`

| Field | Type | Required | Default |
|---|---|---|---|
| `signer` | `Keypair` | yes | — |
| `rpcUrl` | `string` | no | SDK default |
| `network` | `string` | no | `"testnet"` |

---

## Types

### `Agent`

```ts
interface Agent {
  id: bigint
  owner: string
  uri: string
}
```

### `Job`

```ts
interface Job {
  id: bigint
  client: string
  provider: string
  evaluator: string
  token: string
  budget: bigint
  status: JobStatus
  description: string
  deliverable: string
}
```

### `JobStatus` enum

```ts
enum JobStatus {
  Open = "Open",
  Funded = "Funded",
  Submitted = "Submitted",
  Completed = "Completed",
  Rejected = "Rejected",
  Cancelled = "Cancelled",
}
```

### Error responses

All Dashboard and Registry endpoints return errors on `5xx` / `4xx`:

```json
{ "error": "human-readable message" }
```

---

## Job Lifecycle

```
[Client]                    [Provider]              [Evaluator]
   │                            │                       │
   ├─ create_job(token,budget) ─┤                       │
   │  → escrow deducted         │                       │
   │  → status: Funded          │                       │
   │                            │                       │
   ├─ POST /job ────────────────┤                       │
   │                            ├─ submit(deliverable)  │
   │                            │  → status: Submitted  │
   │                            │                       │
   │                            │                       ├─ complete()
   │                            │                       │  → 99% → provider
   │                            │                       │  →  1% → treasury
   │                            │                       │  → status: Completed
```
