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
| `getJob(jobId)`                                                       | Fetch a `Job` record                          |
| `feeBps()`                                                            | Read the current protocol fee in basis points |

### `marcPaywall(opts)` — Express middleware

| Option    | Type                    | Description                                       |
| --------- | ----------------------- | ------------------------------------------------- |
| `payee`   | `string`                | Stellar address that receives payment             |
| `price`   | `number`                | Amount in smallest token units                    |
| `network` | `"testnet" \| "pubnet"` | Network (default: `"testnet"`)                    |
| `token`   | `string`                | Token contract address (defaults to testnet USDC) |

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

## Publishing (maintainers)

The `prepublishOnly` script runs `clean` + `build` automatically:

```bash
npm publish --access public
```

Ensure you are logged into npm (`npm login`) and the `version` field in
`package.json` has been bumped before publishing.

## License

[MIT](./LICENSE)
