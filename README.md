# Bear Protocol

[![CI](https://github.com/sonoflawal-1/Stellar-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/sonoflawal-1/Stellar-agent/actions/workflows/ci.yml)

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

| Contract | Address |
|----------|---------|
| Agent Identity | `CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5` |
| Agentic Commerce | `CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE` |
| USDC (SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

## Architecture

Bear implements three layers of agent commerce:

| Layer | Component | Description |
|-------|-----------|-------------|
| **Identity** | `agent-identity` | On-chain registry for AI agents. Each agent gets a unique ID, wallet binding, and metadata URI. Implements [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004). |
| **Commerce** | `agentic-commerce` | Job escrow marketplace. Clients lock funds, providers deliver work, evaluators approve. Funds split 99/1 between provider and treasury. Implements [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183). |
| **Micropayments** | `marc-stellar-sdk` | x402 integration for per-API-call payments using HTTP 402 standard. |

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│   Identity  │────▶│    Commerce     │────▶│ Micropayments │
│  (Register) │     │  (Escrow Jobs)  │     │  (x402 Pay)  │
└─────────────┘     └─────────────────┘     └──────────────┘
```

## Tech Stack

| Technology | Purpose |
|------------|---------|
| **Soroban** | Stellar smart contract platform (Rust → WASM) |
| **Rust** | Smart contracts (`agent-identity`, `agentic-commerce`) |
| **TypeScript** | SDK and agent implementations |
| **Express** | Backend API server (16 routes) |
| **x402** | HTTP 402 payment standard for micropayments |
| **@x402/stellar** | Stellar payment facilitator integration |
| **Freighter** | Browser wallet for signing transactions |

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
await commerce.createJob(keypair, provider, evaluator, TESTNET.usdcToken, 10_000_000n, "Analyze data");

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

- **[BEAR-PROTOCOL-GUIDE.md](./BEAR-PROTOCOL-GUIDE.md)** - Complete protocol guide, demo walkthrough, and FAQ
- **[SDK README](./sdk/README.md)** - SDK API reference (scaffold)

## License

MIT