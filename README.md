# Bear Protocol

[![CI](https://github.com/sonoflawal-1/Stellar-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/sonoflawal-1/Stellar-agent/actions/workflows/ci.yml)
[![Soroban Protocol Matrix](https://github.com/sonoflawal-1/Stellar-agent/actions/workflows/protocol-matrix.yml/badge.svg)](https://github.com/sonoflawal-1/Stellar-agent/actions/workflows/protocol-matrix.yml)

A commerce layer for AI agent payments built on the Stellar blockchain. Bear gives AI agents everything they need to transact with each other — identity, escrow, and micropayments — without any human middleman.

## Quick Start

```bash
git clone https://github.com/sonoflawal-1/Stellar-agent.git
cd Stellar-agent

# Install Node dependencies (per workspace - see Setup below)
# cargo build --release

# Run Rust tests
cargo test  # 19 unit tests
```

## Live Testnet Contracts

| Contract         | Address                                                    |
| ---------------- | ---------------------------------------------------------- |
| Agent Identity   | `CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5` |
| Agentic Commerce | `CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE` |
| USDC (SAC)       | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

## Architecture

Bear implements three layers of agent commerce:

| Layer             | Component          | Description                                                                                                                                                                                             |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity**      | `agent-identity`   | On-chain registry for AI agents. Each agent gets a unique ID, wallet binding, and metadata URI. Implements [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004).                                         |
| **Commerce**      | `agentic-commerce` | Job escrow marketplace. Clients lock funds, providers deliver work, evaluators approve. Funds split 99/1 between provider and treasury. Implements [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183). |
| **Micropayments** | `marc-stellar-sdk` | x402 integration for per-API-call payments using HTTP 402 standard.                                                                                                                                     |

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│   Identity  │────▶│    Commerce     │────▶│ Micropayments │
│  (Register) │     │  (Escrow Jobs)  │     │  (x402 Pay)  │
└─────────────┘     └─────────────────┘     └──────────────┘
```

## Tech Stack

| Technology        | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| **Soroban**       | Stellar smart contract platform (Rust → WASM)          |
| **Rust**          | Smart contracts (`agent-identity`, `agentic-commerce`) |
| **TypeScript**    | SDK and agent implementations                          |
| **Express**       | Backend API server (16 routes)                         |
| **x402**          | HTTP 402 payment standard for micropayments            |
| **@x402/stellar** | Stellar payment facilitator integration                |
| **Freighter**     | Browser wallet for signing transactions                |

## Project Structure

```
├── contracts/
│   ├── agent-identity/     # Identity registry contract
│   └── agentic-commerce/   # Job escrow contract
├── sdk/                   # TypeScript SDK (marc-stellar-sdk)
├── dashboard/             # Interactive web dashboard
├── demo/                  # Demo landing page
└── agents/
    ├── buyer/             # Buyer agent (CLI demo)
    ├── registry/          # Agent registry service
    └── seller-*/          # Provider agents (webbuilder, copywriter, namer, researcher)
```

## Prerequisites

- **Rust** 1.81+ (for building Soroban contracts)
- **Node.js** 20+ (for SDK, dashboard, agents)
- **stellar-cli** (`cargo install stellar-cli --locked`)
- **Freighter** browser extension (optional, for wallet features)
- **GitHub CLI** (`gh auth login`) for certain deployment workflows

## Setup

### Install Dependencies

Install Node.js dependencies per workspace:

```bash
cd sdk && npm install
cd ../dashboard && npm install
cd ../demo && npm install
cd ../agents/registry && npm install
cd ../agents/buyer && npm install
# Install seller agents as needed
```

### Build Rust Contracts

```bash
cargo build --release
```

### GitHub Authentication (Optional)

For deployment workflows that require GitHub:

```bash
gh auth login
```

### Environment Configuration

Copy the example env file and configure your keys:

```bash
cp demo/.env.example demo/.env
# Edit demo/.env with your testnet credentials
```

> **Note:** The demo requires actual testnet wallets with USDC. Get testnet USDC and generate keypairs via:
>
> ```bash
> # Generate a key and fund from faucet
> stellar keys generate mykey --network testnet --fund
> ```

## Running Tests

### Rust Tests

```bash
cargo test
# Runs 19 unit tests (7 identity + 12 commerce)
```

### TypeScript Tests

TypeScript tests use standard npm test (add `"test": "echo \"No tests defined\""` to package.json if needed):

```bash
npm test --workspace ./sdk
npm test --workspace ./dashboard
```

## Running the Demo

```bash
# Terminal 1: Start all seller agents
./start-agents.sh

# Terminal 2: Start the buyer agent
cd agents/buyer && npm start
```

Or start the full dashboard for interactive demo:

```bash
cd dashboard && npm start
# Visit http://localhost:3000/app
```

## Offline Local Development

Bear ships with a fully autonomous, offline Soroban sandbox defined in `docker-compose.yml`. It runs a local Stellar Quickstart node (`stellar/quickstart:testing`) on a standalone network, auto-compiles and deploys the contracts, funds test keypairs, and wires up the indexer, dashboard, and agents — no internet connection or remote testnet access required.

### Prerequisites

- **Docker** 24+ with **Compose v2** (`docker compose` plugin)
- No other tooling is needed — Rust, `stellar-cli`, and Node are all provided inside the containers

### Quick Start

```bash
docker compose up
```

That single command spins up the full stack:

1. **Stellar node** — a local standalone network via Stellar Quickstart, exposing the RPC endpoint (default `http://localhost:8000/soroban/rpc`).
2. **Init service** — waits for the local RPC healthcheck to pass, then compiles the `agent-identity` and `agentic-commerce` contracts to WASM, deploys them to the local network, initializes them, and funds the test keypairs used by the dashboard and agents.
3. **Indexer, dashboard, and agents** — start only after the init service reports the contracts are deployed and the RPC is healthy.

The environment is **100% offline**: it never contacts the remote Stellar testnet or any external network. All accounts, contracts, and balances are local and deterministic, so runs are reproducible.

### Environment Configuration

The init service exports the local network configuration to `.env.docker`, which the dashboard and agents load automatically:

```bash
# .env.docker (generated on boot)
STELLAR_RPC_URL=http://localhost:8000/soroban/rpc
STELLAR_NETWORK_PASSPHRASE=Standalone Network ; February 2017
IDENTITY_CONTRACT=<deployed contract id>
COMMERCE_CONTRACT=<deployed contract id>
USDC_TOKEN=<local SAC contract id>
```

To point the SDK at the local sandbox instead of the remote testnet, load these values in place of the `TESTNET` defaults:

```typescript
import { IdentityClient, CommerceClient } from "marc-stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const config = {
  rpcUrl: process.env.STELLAR_RPC_URL!, // http://localhost:8000/soroban/rpc
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE!,
  identityContract: process.env.IDENTITY_CONTRACT!,
  commerceContract: process.env.COMMERCE_CONTRACT!,
  usdcToken: process.env.USDC_TOKEN!,
};

const identity = new IdentityClient(config);
await identity.register(Keypair.fromSecret(process.env.TEST_SECRET!), "https://ipfs.agent/metadata.json");
```

### Teardown

Stop and remove the containers, network, and volumes:

```bash
docker compose down -v
```

The next `docker compose up` recreates the sandbox from scratch, recompiling and redeploying the contracts and re-funding the test keypairs.

## Dashboard Theming

The dashboard supports a dark/light mode toggle that respects your OS preference by default and remembers your manual choice.

- **System preference:** On first load, the theme is auto-detected via the `prefers-color-scheme` media query.
- **Manual toggle:** Clicking the theme toggle sets a `data-theme` attribute (`dark` or `light`) on the `<html>` element and animates the icon on switch.
- **Persistence:** Your manual choice is stored in `localStorage` under the key `bear-theme` and restored on subsequent visits.
- **Accessibility:** The toggle exposes an `aria-label` and keeps a visible focus ring in both modes.

## SDK Usage

```typescript
import { IdentityClient, CommerceClient, marcPaywall, marcFetch, TESTNET } from "marc-stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk";

// Configure with testnet defaults
const config = {
  rpcUrl: TESTNET.rpcUrl,
  networkPassphrase: TESTNET.networkPassphrase,
  identityContract: TESTNET.identityContract,
  commerceContract: TESTNET.commerceContract,
  usdcToken: TESTNET.usdcToken,
};

// Register an agent identity
const identity = new IdentityClient(config);
const keypair = Keypair.fromSecret("...");
await identity.register(keypair, "https://ipfs.agent/metadata.json");

// Create an escrow job
const commerce = new CommerceClient(config);
await commerce.createJob(
  keypair,
  provider,
  evaluator,
  TESTNET.usdcToken,
  10_000_000n,
  "Analyze data",
);

// Monetize an API endpoint
app.use("/api/summarize", marcPaywall({ price: 1_000_000, token: "USDC" }));

// Auto-pay for API calls
const result = await marcFetch("https://agent.example/api/summarize", {
  method: "POST",
  body: JSON.stringify({ text: "..." }),
  signer: keypair,
});
```

## Documentation

- **[API Reference (GitHub Pages)](https://sonoflawal-1.github.io/Stellar-agent/)** - Published TypeDoc/rustdoc site: [TypeScript SDK docs](https://sonoflawal-1.github.io/Stellar-agent/typescript/) and [Rust contract docs](https://sonoflawal-1.github.io/Stellar-agent/rust/)
- **[docs/glossary.md](./docs/glossary.md)** — user-facing Bear terminology
- **[docs/MAINNET_READINESS_CHECKLIST.md](./docs/MAINNET_READINESS_CHECKLIST.md)** — mainnet launch gates
- **[docs/runbooks/](./docs/runbooks/)** — operational runbooks (indexer lag, RPC outage, stuck escrow, key rotation)
- **[docs/TUTORIAL.md](./docs/TUTORIAL.md)** - Beginner quickstart: register an agent, escrow a job, and test an x402 payment in under 10 minutes
- **[BEAR-PROTOCOL-GUIDE.md](./BEAR-PROTOCOL-GUIDE.md)** - Complete protocol guide, demo walkthrough, and FAQ
- **[SDK README](./sdk/README.md)** - SDK API reference (scaffold)
- **[MAINNET_MIGRATION.md](./docs/MAINNET_MIGRATION.md)** - Security audit checklist, infrastructure hardening, tokenomics, and legal considerations for mainnet

## License

MIT

## Handsoff notes

<!-- handsoff-issue-618 -->
- #618: [Security] Add Content Security Policy headers configuration in dashboard/server.ts

<!-- handsoff-issue-656 -->
- #656: feat(sdk): implement Server-Sent Events streaming for long-running job results

<!-- handsoff-issue-1037 -->
- #1037: fix(dashboard): /api/build/submit must verify the transaction network passphrase and source

<!-- handsoff-issue-1039 -->
- #1039: feat(indexer): agent leaderboard endpoint (reputation, volume, completion rate)
