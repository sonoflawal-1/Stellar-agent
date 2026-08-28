# MARC SDK Documentation

## Installation

```bash
cd sdk && npm install && npm run build
```

Then in your project:
```bash
npm install file:../sdk
```

---

## Configuration

```typescript
import { TESTNET, type MarcConfig } from "marc-stellar-sdk";

const cfg: MarcConfig = {
  ...TESTNET,                          // use testnet defaults
  onTx: (hash) => console.log(hash),  // optional: called after every tx
};
```

### MarcConfig fields

| Field | Type | Description |
|---|---|---|
| `rpcUrl` | string | Soroban RPC endpoint |
| `networkPassphrase` | string | Stellar network passphrase |
| `identityContract` | string | Agent Identity contract address |
| `commerceContract` | string | Agentic Commerce contract address |
| `usdcToken` | string | USDC SAC token address |
| `onTx` | function | Optional callback fired with tx hash after each successful transaction |

---

## IdentityClient

### `register(keypair, uri)`
Register a new agent on-chain. Returns the agent's sequential ID.

```typescript
const identity = new IdentityClient(cfg);
const agentId = await identity.register(keypair, "ipfs://my-agent-metadata.json");
// agentId: 1n, 2n, 3n...
```

### `agentOf(address)`
Look up the agent ID owned by a Stellar address. Returns `null` if not registered.

```typescript
const agentId = await identity.agentOf(keypair.publicKey());
```

### `getAgent(id)`
Get full agent record by ID.

```typescript
const agent = await identity.getAgent(1n);
// { id: 1n, owner: "G...", uri: "ipfs://..." }
```

### `listAgents(maxId?)`
Scan all registered agents sequentially. Stops at first gap.

```typescript
const agents = await identity.listAgents(); // default max 200
```

### `updateUri(keypair, id, uri)`
Update an agent's metadata URI (owner only).

```typescript
await identity.updateUri(keypair, agentId, "ipfs://new-metadata.json");
```

### `deregister(keypair, id)`
Remove an agent from the registry (owner only).

```typescript
await identity.deregister(keypair, agentId);
```

---

## CommerceClient

### `createJob(client, provider, evaluator, token, budget, description)`
Lock USDC in escrow and create a job. Returns the job ID.

```typescript
const commerce = new CommerceClient(cfg);
const jobId = await commerce.createJob(
  clientKeypair,       // pays the budget
  providerAddress,     // receives 99% on completion
  evaluatorAddress,    // approves the work (can be same as client)
  TESTNET.usdcToken,
  10_000_000n,         // 1 USDC (7 decimals)
  "Build a landing page for Brew & Co"
);
```

### `submit(keypair, jobId, deliverable)`
Provider submits a deliverable URI for a funded job.

```typescript
await commerce.submit(providerKeypair, jobId, "ipfs://deliverable-hash");
```

### `complete(keypair, jobId)`
Evaluator approves the deliverable. Releases 99% to provider, 1% to treasury.

```typescript
await commerce.complete(evaluatorKeypair, jobId);
```

### `cancel(keypair, jobId)`
Client cancels a funded job. Full refund, only works from `Funded` state.

```typescript
await commerce.cancel(clientKeypair, jobId);
```

### `getJob(jobId)`
Read a job by ID.

```typescript
const job = await commerce.getJob(jobId);
// {
//   id: 1n,
//   client: "G...",
//   provider: "G...",
//   evaluator: "G...",
//   token: "C...",
//   budget: 10000000n,
//   status: "Funded" | "Submitted" | "Completed" | "Cancelled",
//   description: "...",
//   deliverable: "..."
// }
```

### `feeBps()`
Get the current fee in basis points (100 = 1%).

```typescript
const fee = await commerce.feeBps(); // 100
```

---

## marcPaywall (Express middleware)

Protect any Express route with an x402 paywall. Buyers must pay before accessing.

```typescript
import { marcPaywall } from "marc-stellar-sdk";

app.use("/api/work", marcPaywall({
  payTo: seller.publicKey(),       // receives micropayments
  price: "$0.01",                  // price per call
  network: "stellar:testnet",
  description: "One API call",
  facilitatorUrl: "https://channels.openzeppelin.com/x402/testnet",
  facilitatorApiKey: process.env.X402_FACILITATOR_API_KEY,
}));

app.get("/api/work", (req, res) => {
  res.json({ result: "paid content" });
});
```

Get a free facilitator API key:
```bash
curl https://channels.openzeppelin.com/testnet/gen
```

---

## marcFetch (auto-paying fetch)

Drop-in replacement for `fetch` that automatically handles 402 responses.

```typescript
import { marcFetch } from "marc-stellar-sdk";

const paidFetch = marcFetch({
  signer: keypair,
  rpcUrl: TESTNET.rpcUrl,
});

const res = await paidFetch("http://seller-agent/api/work");
const data = await res.json();
```

---

## Browser build (client-side wallet signing)

The main entry (`marc-stellar-sdk`) is Node-oriented: it re-exports `marcPaywall`
(Express middleware) and `marcFetch`, which pull in Node-only `@x402/*` packages.
For browser apps (the dashboard frontend, Vite/webpack builds, plain
`<script type="module">`) use the **`marc-stellar-sdk/browser`** subpath instead.
It contains only the isomorphic surface — contract clients, types, testnet
preset, and wallet-signing helpers — and bundles cleanly with zero Node imports.

```typescript
import {
  CommerceClient,
  IdentityClient,
  TESTNET,
  type WalletSigner,
} from "marc-stellar-sdk/browser";
```

### Signing with a wallet extension

All state-changing client methods accept either a `Keypair` (Node/demo flows) or
a `WalletSigner` (browser flows) — the `Signer` union. A `WalletSigner` is a
one-method interface that delegates to your wallet's `signTransaction`:

```typescript
const publicKey = wallet.publicKey(); // e.g. from Stellar Wallets Kit / Freighter

const freighterSigner: WalletSigner = {
  publicKey,
  async signTransaction(xdr, { networkPassphrase }) {
    const { signedTxXdr } = await window.freighterApi.signTransaction(xdr, {
      networkPassphrase,
    });
    return signedTxXdr;
  },
};

const commerce = new CommerceClient({ ...TESTNET });
const jobId = await commerce.createJob(
  freighterSigner,   // signer: Keypair | WalletSigner
  providerAddress,
  evaluatorAddress,
  TESTNET.usdcToken,
  10_000_000n,
  "Build a landing page",
);
```

Helpers exported from both entries:

| Export | Description |
|---|---|
| `WalletSigner` | Interface: `{ publicKey, signTransaction(xdr, { networkPassphrase }) }` |
| `KeypairSigner` | Adapter wrapping a `Keypair` as a `WalletSigner` |
| `toSigner(signer)` | Normalize a `Signer` (Keypair or WalletSigner) to `WalletSigner` — duck-typed, so it works even when the Keypair comes from a different `@stellar/stellar-sdk` install |
| `signerPublicKey(signer)` | Get the public key from either signer form |

**Building the browser bundle** (one command):

```bash
cd sdk && npm run build:browser   # esbuild → dist/browser.js + dist/browser.d.ts
```

`dist/browser.js` is a self-contained ESM bundle (~1 MB, minified, sourcemapped)
with no `@x402`/Express/Node imports. The `marc-stellar-sdk/browser` subpath is
wired up via the `exports` map in `sdk/package.json`.

---

## Agent Marketplace Demo

### Start all agents

```bash
./start-agents.sh
```

Starts the registry (`:4500`) and 4 seller agents (`:4501–4504`).

### Run the buyer TUI

```bash
cd agents/buyer && npm start
```

| Key | Action |
|---|---|
| `↑↓` | Browse available agents |
| `Tab` | Focus task input |
| `Enter` | Submit task / hire agent |
| `n` | Start a new task |
| `Ctrl+C` | Quit |

### How a job flows

1. Buyer selects an agent and types a task
2. Buyer TUI creates an escrow job on-chain (1 USDC locked)
3. Buyer POSTs `{ jobId, task }` to the seller's HTTP server
4. Seller calls Groq LLM to complete the task
5. Seller submits the deliverable on-chain
6. Buyer TUI detects submission, calls `complete()`
7. 99% USDC released to seller, 1% to treasury

### Agent capability manifests

Each seller exposes `GET /` returning its `agent.json`:

```json
{
  "id": "seller-webbuilder",
  "name": "Web Builder Agent",
  "description": "Builds complete HTML/CSS websites from a brief.",
  "tasks": ["build website", "create landing page"],
  "input": "A plain-text brief describing the website.",
  "output": "A single self-contained HTML file.",
  "price_usdc": 1,
  "wallet": "G...",
  "url": "http://localhost:4501"
}
```

The local registry at `http://localhost:4500/agents` aggregates all manifests.

---

## TUI Simulation

Run a fully automated simulation with 4 sellers and 5 buyers:

```bash
cd demo && npm run tui
```

Shows live:
- Seller status, job count, USDC balance
- Buyer status, job count, USDC balance  
- Activity feed with all on-chain events
- Spinner on active agents

---

## Environment Variables

| Variable | Description |
|---|---|
| `BUYER_SECRET` | Stellar secret key for the buyer |
| `SELLER_SECRET_1..4` | Stellar secret keys for each seller |
| `GROQ_API_KEY` | Groq API key (free at console.groq.com) |
| `X402_FACILITATOR_API_KEY` | x402 facilitator key (free, see above) |
| `STELLAR_RPC_URL` | Override Soroban RPC (default: testnet) |
| `BUYER_SECRET_1..5` | Additional buyer keys for TUI simulation |

---

## Deployed Contracts

| Contract | Testnet Address |
|---|---|
| Agent Identity | `CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5` |
| Agentic Commerce | `CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE` |

Verify on [Stellar Expert](https://stellar.expert/explorer/testnet).
