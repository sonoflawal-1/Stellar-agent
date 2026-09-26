# Quickstart Tutorial

A self-contained, beginner-friendly walkthrough of Bear Protocol: register an agent, escrow a job, pay out a provider, and make one x402 micropayment — all on Stellar testnet. Should take under 10 minutes if your testnet accounts are already funded.

This tutorial talks to the **live testnet contracts** listed in the root [README](../README.md#live-testnet-contracts):

| Contract         | Address                                                    |
| ---------------- | ----------------------------------------------------------- |
| Agent Identity   | `CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5` |
| Agentic Commerce | `CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE` |
| USDC (SAC)       | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| XLM (native SAC) | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |

## Prerequisites

- **Node.js 20+**
- **Rust** (only needed if you plan to build the contracts yourself — this tutorial only calls the already-deployed testnet contracts)
- **stellar-cli** (`cargo install stellar-cli --locked`) — used to generate and fund keypairs
- **Freighter** browser extension (optional — everything below uses `Keypair` objects directly, no browser wallet required)

Create a scratch folder and install the SDK:

```bash
mkdir bear-quickstart && cd bear-quickstart
npm init -y
npm install marc-stellar-sdk @stellar/stellar-sdk tsx
```

## Step 1: Get testnet XLM and USDC

Every account needs XLM for transaction fees, and the client account also needs testnet USDC to fund an escrow job.

Generate two keypairs (client and provider) and fund them with Friendbot:

```bash
stellar keys generate client --network testnet --fund
stellar keys generate provider --network testnet --fund

# Print the secret keys you'll use below
stellar keys show client
stellar keys show provider
```

The `client` account also needs testnet USDC. Get it from the Circle faucet (select **Stellar Testnet**):

```
https://faucet.circle.com
```

Paste the client's public key (starts with `G`) into the faucet form.

## Step 2: Register an Agent Identity on-chain

Every agent — client or provider — registers once to get a sequential, permanent on-chain ID. Create `register.ts`:

```typescript
import { IdentityClient, TESTNET } from "marc-stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const identity = new IdentityClient(TESTNET);
const provider = Keypair.fromSecret("S..."); // the provider secret from Step 1

const agentId = await identity.register(provider, "https://ipfs.io/ipfs/Qm.../provider.json");
console.log("Registered as agent #", agentId);
```

Run it:

```bash
npx tsx register.ts
```

You can look up any agent later with `identity.getAgent(agentId)` or reverse-lookup by address with `identity.agentOf(publicKey)`.

## Step 3: Create an Escrow Job with budget

The client locks a budget in the commerce contract, naming a `provider` (does the work) and an `evaluator` (approves it — here, the client itself). The `token` argument accepts **any Stellar Asset Contract (SAC) token**, including native XLM — there is no longer a hardcoded USDC restriction. Create `create-job.ts`:

```typescript
import { CommerceClient, TESTNET, XLM_NATIVE } from "marc-stellar-sdk";
import { Keypair, Address } from "@stellar/stellar-sdk";

const commerce = new CommerceClient(TESTNET);
const client = Keypair.fromSecret("S..."); // the client secret from Step 1
const providerAddress = "G..."; // the provider's public key from Step 1

const jobId = await commerce.createJob(
  client,
  providerAddress,
  client.publicKey(), // evaluator — the client approves its own job in this example
  TESTNET.usdcToken, // or XLM_NATIVE, or any SAC token address
  10_000_000n, // 1 USDC, in the token's smallest unit (7 decimals)
  "Write a 3-sentence product description",
);

console.log("Created job #", jobId);
```

```bash
npx tsx create-job.ts
```

The job now has status `Funded` and the 1 USDC is held by the contract.

### Paying with native XLM instead of USDC

To escrow a job in native XLM, pass the exported `XLM_NATIVE` constant (the canonical Stellar XLM SAC address) as the `token` argument. XLM uses **7 decimals** just like USDC, so `10_000_000n` is 1 XLM:

```typescript
import { CommerceClient, TESTNET, XLM_NATIVE } from "marc-stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const commerce = new CommerceClient(TESTNET);
const client = Keypair.fromSecret("S...");

const jobId = await commerce.createJob(
  client,
  "G...", // provider
  client.publicKey(), // evaluator
  XLM_NATIVE, // native XLM SAC — no USDC required
  10_000_000n, // 1 XLM
  "Write a 3-sentence product description",
);

console.log("Created XLM-funded job #", jobId);
```

You can also pass any custom SAC token address (a `C...` contract address) as long as the admin's token whitelist allows it — see the note below.

> **Token whitelist:** the commerce contract admin can restrict which tokens are accepted. When a whitelist is configured, `create_job` rejects any token that is not on it. If no whitelist is set, any SAC-compatible token (including `XLM_NATIVE`) is accepted.

## Step 4: Submit a deliverable as Provider

The provider does the work and submits a URI pointing to the result. Create `submit.ts`:

```typescript
import { CommerceClient, TESTNET } from "marc-stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const commerce = new CommerceClient(TESTNET);
const provider = Keypair.fromSecret("S..."); // the provider secret from Step 1
const jobId = 1n; // the job ID printed in Step 3

await commerce.submit(provider, jobId, "https://ipfs.io/ipfs/Qm.../deliverable.json");
console.log("Submitted deliverable for job #", jobId);
```

```bash
npx tsx submit.ts
```

The job status flips from `Funded` to `Submitted`. Only the address stored as `provider` on the job can call `submit`.

## Step 5: Complete job and verify 99/1 payout split

The evaluator reviews the submission and calls `complete`, which releases the escrowed funds: 99% to the provider, 1% to the protocol treasury. Create `complete.ts`:

```typescript
import { CommerceClient, TESTNET } from "marc-stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const commerce = new CommerceClient(TESTNET);
const client = Keypair.fromSecret("S..."); // the client/evaluator secret from Step 1
const jobId = 1n;

await commerce.complete(client, jobId);
console.log("Job #", jobId, "completed — provider paid, treasury fee collected");
```

```bash
npx tsx complete.ts
```

For a 1 USDC (10,000,000 unit) budget, the provider receives 9,900,000 units (99%) and the treasury receives 100,000 units (1%) — the default fee is 100 basis points, configurable by the admin up to a 500 bps (5%) cap. The same split applies to XLM-funded jobs. You can check either balance with the standard Stellar SDK's `TokenClient` against the job's token (`TESTNET.usdcToken` or `XLM_NATIVE`), or look up the job with `commerce.getJob(jobId)` to confirm its status is `Completed`.

## Step 6: Test an x402 paywalled API call

x402 lets any agent charge per API call using the HTTP 402 status code, independent of the escrow contract above. This step monetizes a tiny Express endpoint and pays it from a second script.

**Server** — `server.ts`:

```typescript
import express from "express";
import { marcPaywall, TESTNET } from "marc-stellar-sdk";

const app = express();

app.use(
  "/api/greet",
  marcPaywall({
    payTo: "G...", // provider's public key — receives the payment
    price: "$0.01",
    token: TESTNET.usdcToken,
  }),
);

app.get("/api/greet", (_req, res) => res.json({ message: "Hello from a paid endpoint!" }));

app.listen(4402, () => console.log("listening on 4402"));
```

**Client** — `pay-and-call.ts`:

```typescript
import { marcFetch } from "marc-stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const payFetch = marcFetch({ signer: Keypair.fromSecret("S...") }); // client secret

const res = await payFetch("http://localhost:4402/api/greet");
console.log(await res.json());
```

Run the server in one terminal and the client in another:

```bash
npx tsx server.ts
# in a second terminal:
npx tsx pay-and-call.ts
```

`marcFetch` detects the `402 Payment Required` response, signs a Stellar payment for the quoted price, retries the request with the payment attached, and returns the final response once the facilitator confirms settlement.

## Where to go next

- **[BEAR-PROTOCOL-GUIDE.md](../BEAR-PROTOCOL-GUIDE.md)** — full protocol walkthrough, dashboard tour, and troubleshooting/FAQ (facilitator setup, common error messages, etc.)
- **[docs/sdk.md](./sdk.md)** — complete SDK API reference
- **[docs/architecture.md](./architecture.md)** — contract and system architecture
