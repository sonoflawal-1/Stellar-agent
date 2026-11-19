# marc-stellar-sdk

[![npm version](https://img.shields.io/npm/v/marc-stellar-sdk)](https://www.npmjs.com/package/marc-stellar-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Typed TypeScript helpers for the Bear Protocol's two Soroban contracts
(`agent_identity`, `agentic_commerce`), plus x402 payment middleware and a
self-paying `marcFetch` wrapper.

## Requirements

- **Node.js** ≥ 20 (ESM-only package)

## Installation

```bash
npm install marc-stellar-sdk
```

> **Note:** The package ships ESM only (`"type": "module"`). CommonJS is not
> supported. Ensure your project's `tsconfig.json` / `package.json` targets
> ESM (e.g. `"module": "NodeNext"`).

## Quick Start

```typescript
import { IdentityClient, CommerceClient, marcFetch, TESTNET } from "marc-stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const keypair = Keypair.fromSecret("S...");

// ── Identity ──────────────────────────────────────────────────────────────────
const identity = new IdentityClient(TESTNET);

// Register an agent on-chain
const agentId = await identity.register(keypair, "https://ipfs.io/ipfs/<cid>/metadata.json");

// Resolve an agent by Stellar address
const agent = await identity.agentOf(keypair.publicKey());

// ── Commerce (escrow) ─────────────────────────────────────────────────────────
const commerce = new CommerceClient(TESTNET);

// Client creates a funded job
const jobId = await commerce.createJob(
  keypair,
  providerAddress,
  evaluatorAddress,
  TESTNET.usdcToken,
  10_000_000n, // 10 USDC (7 decimals)
  "Analyse Q3 sales data and return a CSV summary",
);

// Provider submits deliverable
await commerce.submit(providerKeypair, jobId, "https://ipfs.io/ipfs/<deliverable-cid>");

// Evaluator approves → funds released 99 % provider / 1 % treasury
await commerce.complete(evaluatorKeypair, jobId);

// ── High-frequency micropayments (off-chain vouchers) ───────────────────────
const channel = await commerce.openChannel(
  payerKeypair,
  providerAddress,
  10_000_000n,
  channelVoucherKeypair,
);
let latestVoucher = channel.createVoucher(1_000n);
for (let request = 1; request < 100; request += 1) {
  latestVoucher = channel.createVoucher(1_000n); // signed locally; no RPC call
}
await commerce.closeChannel(channel.channelId, latestVoucher, providerKeypair);
// After 24 hours, either participant calls forceClose(participant, channelId).

// ── Paywall middleware (Express) ──────────────────────────────────────────────
import express from "express";
import { marcPaywall } from "marc-stellar-sdk";

const app = express();
app.use(
  "/api/summarize",
  marcPaywall({
    payee: keypair.publicKey(),
    price: 1_000_000, // 1 USDC
    network: "testnet",
  }),
);

// ── Auto-paying fetch ─────────────────────────────────────────────────────────
const fetch402 = marcFetch({
  signer: keypair,
  network: "testnet",
  // Custom headers forwarded on every request (e.g. API keys, auth tokens)
  headers: { "X-Api-Key": "my-key" },
  onPayment: (status) => console.log("payment:", status),
});

const res = await fetch402("https://agent.example/api/summarize", {
  method: "POST",
  body: JSON.stringify({ text: "..." }),
});
```

## Browser Usage (Freighter wallet)

Frontend apps can use the SDK without ever exposing a private key. The browser
entry point (`marc-stellar-sdk/browser`) signs every transaction through the
[Freighter](https://www.freighter.app/) extension, which prompts the user for
approval.

```typescript
import { BrowserIdentityClient, connectFreighter } from "marc-stellar-sdk/browser";
import { TESTNET } from "marc-stellar-sdk";

// 1. Connect the wallet (throws FreighterNotInstalledError if absent)
const { publicKey } = await connectFreighter();

// 2. Use the browser clients — Freighter popup appears for each signature
const identity = new BrowserIdentityClient(TESTNET);
const agentId = await identity.register(publicKey, "https://ipfs.io/ipfs/<cid>/metadata.json");

const commerce = new BrowserCommerceClient(TESTNET);
await commerce.createJob(publicKey, provider, evaluator, TESTNET.usdcToken, 10_000_000n, "...");
```

### `connectFreighter()`

Returns `{ publicKey }` for the connected account. Detects a network mismatch
between Freighter and the target network and throws a descriptive error.

### `FreighterSigner`

Implements the same `Signer` interface as `Keypair`, so it can be passed to any
SDK method that accepts a signer. It wraps `@stellar/freighter-api` and never
reads or stores a secret key.

### `FreighterNotInstalledError`

Thrown when the Freighter extension is not detected. Its message includes an
install link (`https://www.freighter.app/`) so apps can surface a helpful prompt.

## API Reference

### `IdentityClient`

| Method                                           | Description                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `register(keypair, uri)`                         | Register a new agent; returns `agentId: bigint`                                                           |
| `getAgent(agentId)`                              | Fetch an `Agent` record by numeric ID                                                                     |
| `agentOf(address)`                               | Look up the `Agent` registered to a Stellar address                                                       |
| `updateUri(keypair, agentId, newUri)`            | Update the metadata URI                                                                                   |
| `updateOwner(keypair, agentId, newOwnerKeypair)` | Transfer the agent to a new wallet; requires signatures from both the current owner and `newOwnerKeypair` |
| `deregister(keypair, agentId)`                   | Remove the agent registration                                                                             |

### `CommerceClient`

| Method                                                                | Description                                   |
| --------------------------------------------------------------------- | --------------------------------------------- |
| `createJob(keypair, provider, evaluator, token, budget, description)` | Create + fund an escrow job                   |
| `submit(keypair, jobId, deliverable)`                                 | Provider submits work                         |
| `complete(keypair, jobId)`                                            | Evaluator approves; triggers payout           |
| `cancel(keypair, jobId)`                                              | Client cancels and recovers budget            |
| `createJobMultiEval(client, provider, evaluators, threshold, ...)`     | Fund a job requiring M-of-N evaluator approvals |
| `approveJob(evaluator, jobId)`                                        | Record approval; pays out at quorum            |
| `openChannel(payer, provider, deposit, voucherKeypair, token?)`       | Open a one-way escrowed payment channel         |
| `closeChannel(channelId, voucher, provider)`                           | Submit or challenge with a signed cumulative voucher |
| `forceClose(participant, channelId)`                                   | Settle after the 24-hour challenge period       |
| `getJob(jobId)`                                                       | Fetch a `Job` record                          |
| `feeBps()`                                                            | Read the current protocol fee in basis points |

### `marcPaywall(opts)` — Express middleware

| Option    | Type                    | Description                                       |
| --------- | ----------------------- | ------------------------------------------------- |
| `payee`   | `string`                | Stellar address that receives payment             |
| `price`   | `number`                | Amount in smallest token units                    |
| `network` | `"testnet" \| "pubnet"` | Network (default: `"testnet"`)                    |
| `token`   | `string`                | Token contract address (defaults to testnet USDC) |

The facilitator URL is selected from `network` via the exported
`FACILITATOR_URLS` constant. An explicit `facilitatorUrl` always takes
precedence (e.g. for a self-hosted facilitator).

```typescript
import { marcPaywall, FACILITATOR_URLS } from "marc-stellar-sdk";

// Mainnet: uses FACILITATOR_URLS.mainnet automatically
app.use(
  "/api/summarize",
  marcPaywall({
    payTo: "GABC...",
    price: "$0.01",
    network: "stellar:pubnet",
    facilitatorApiKey: process.env.FACILITATOR_KEY,
  }),
);
```

### `marcFetch(opts)` — auto-paying fetch

| Option               | Type                              | Description                                                                 |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `signer`             | `Keypair`                         | Keypair used to sign payment transactions                                   |
| `network`            | `"testnet" \| "pubnet"`           | Network (default: `"testnet"`)                                              |
| `rpcUrl`             | `string?`                         | Custom Soroban RPC URL                                                      |
| `headers`            | `Record<string, string>?`         | Custom HTTP headers forwarded on every request (e.g. API keys, auth tokens) |
| `onPayment`          | `(status: PaymentStatus) => void` | Payment lifecycle callback                                                  |
| `timeoutMs`          | `number?`                         | Per-request timeout in milliseconds                                         |
| `maxPaymentAttempts` | `number?`                         | Max 402-retry attempts (default: `1`)                                       |
| `fetchImpl`          | `typeof fetch?`                   | Custom fetch implementation (tests / adapters)                              |
| `allowedPayees`      | `string[]?`                       | Allowlist of payee addresses accepted from 402 challenges                   |
| `allowedAssets`      | `string[]?`                       | Allowlist of asset (token) contract addresses accepted from 402 challenges  |
| `maxAmount`          | `bigint?`                         | Maximum amount (smallest token units) accepted from a 402 challenge         |

#### Payment challenge validation (safe defaults)

A malicious server can return a 402 challenge that asks for payment to an
arbitrary address or token. `marcFetch` validates every challenge against the
configured allowlists **before** signing or submitting any payment; a rejected
challenge throws and **no network payment is made**.

```typescript
const fetch402 = marcFetch({
  signer: keypair,
  network: "testnet",
  allowedPayees: ["GPAYEE...", "GOTHERPAYEE..."],
  allowedAssets: [TESTNET.usdcToken],
  maxAmount: 5_000_000n, // never pay more than 5 USDC per request
});
```

> **Security:** Always configure `allowedPayees` and `allowedAssets` in
> production. When neither is set, the SDK emits a warning and accepts any
> payee/asset from the challenge — this permissive mode is intended only for
> local development and tests.
=======

### Network presets

```typescript
import { TESTNET, MAINNET } from "marc-stellar-sdk";
```

Both presets expose `rpcUrl`, `networkPassphrase`, `identityContract`,
`commerceContract`, and `usdcToken`. Contract addresses can be overridden via
environment variables:

| Variable                         | Description                           |
| -------------------------------- | ------------------------------------- |
| `MARC_TESTNET_IDENTITY_CONTRACT` | Override testnet identity contract    |
| `MARC_TESTNET_COMMERCE_CONTRACT` | Override testnet commerce contract    |
| `MARC_TESTNET_USDC_TOKEN`        | Override testnet USDC token           |
| `STELLAR_RPC_URL`                | Override RPC endpoint (both networks) |

## Types

```typescript
import type {
  Agent,
  Job,
  JobStatus,
  MarcConfig,
  MarcFetchOptions,
  PaymentStatus,
  CommerceEventName,
} from "marc-stellar-sdk";
```

Providers can validate collected signatures with `verifyChannelVoucher(voucher,
voucherPublicKey)`. Vouchers are cumulative, domain-separated commitments;
store the highest-value valid voucher and submit it during channel closing.
Use a dedicated voucher keypair and keep its secret private; it is distinct
from the wallet that funds the on-chain channel.

## Publishing (maintainers)

The `prepublishOnly` script runs `clean` + `build` before every publish.
