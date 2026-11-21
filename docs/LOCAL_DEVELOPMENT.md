# Local Development Guide

This guide walks you through running a fully local Soroban/Stellar network using Docker's
[stellar/quickstart](https://github.com/stellar/quickstart) image. A local standalone network
lets you develop offline, avoid testnet rate limits, and reset state instantly.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Docker | 20+ | [docs.docker.com](https://docs.docker.com/get-docker/) |
| Node.js | see `.nvmrc` (also declared in each package's `engines`) | [nodejs.org](https://nodejs.org) or [nvm](https://github.com/nvm-sh/nvm) |
| Rust | 1.81+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| stellar-cli | latest | `cargo install stellar-cli --locked` |

> **Node version policy:** the repository pins a single supported Node.js version in `.nvmrc`,
> and every package declares the same range in its `engines` field. Before installing
> dependencies, switch to the pinned version:
>
> ```bash
> nvm use        # or: fnm use / asdf install nodejs
> node --version # should match .nvmrc
> ```
>
> CI runs the test matrix against the supported Node versions, so using the pinned version
> locally keeps your environment consistent with CI.

## 1. Start the Standalone Network

Pull and run the quickstart image in standalone mode:

```bash
docker run --rm -it \
  -p 8000:8000 \
  --name stellar-local \
  stellar/quickstart:latest \
  --standalone \
  --enable-soroban-rpc
```

The container exposes:

| Endpoint | URL |
|----------|-----|
| Horizon API | `http://localhost:8000` |
| Soroban RPC | `http://localhost:8000/soroban/rpc` |
| Friendbot (faucet) | `http://localhost:8000/friendbot` |

> **Tip:** Add `--protocol-version 22` (or whichever version you need) to pin the protocol.

## 2. Configure stellar-cli for Local Network

Add a local network entry so `stellar-cli` targets your Docker container:

```bash
stellar network add local \
  --rpc-url http://localhost:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017"
```

Verify it works:

```bash
stellar network ls
# Should list: local, testnet, mainnet
```

## 3. Generate and Fund Accounts

### Generate keys

```bash
# Admin / deployer key
stellar keys generate admin --network local

# Seller agent keys
stellar keys generate seller1 --network local
stellar keys generate seller2 --network local
stellar keys generate seller3 --network local
stellar keys generate seller4 --network local
```

### Fund via Friendbot

```bash
# Get the public key for each identity
ADMIN_PK=$(stellar keys address admin)
S1_PK=$(stellar keys address seller1)
S2_PK=$(stellar keys address seller2)
S3_PK=$(stellar keys address seller3)
S4_PK=$(stellar keys address seller4)

# Hit Friendbot (10 000 XLM each)
for pk in $ADMIN_PK $S1_PK $S2_PK $S3_PK $S4_PK; do
  curl "http://localhost:8000/friendbot?addr=${pk}"
done
```

Confirm balances:

```bash
stellar account show $ADMIN_PK --network local
```

## 4. Deploy Contracts Locally

### Build WASM artifacts

```bash
cargo build --release --target wasm32-unknown-unknown
```

WASM files will be in `target/wasm32-unknown-unknown/release/`.

### Deploy Agent Identity contract

```bash
IDENTITY_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/agent_identity.wasm \
  --source admin \
  --network local)

echo "Agent Identity contract: $IDENTITY_ID"
```

### Deploy Agentic Commerce contract

```bash
COMMERCE_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/agentic_commerce.wasm \
  --source admin \
  --network local)

echo "Agentic Commerce contract: $COMMERCE_ID"
```

### Initialize the contracts

```bash
# Initialize identity registry
stellar contract invoke \
  --id $IDENTITY_ID \
  --source admin \
  --network local \
  -- initialize \
  --admin $ADMIN_PK

# Initialize commerce contract
stellar contract invoke \
  --id $COMMERCE_ID \
  --source admin \
  --network local \
  -- initialize \
  --admin $ADMIN_PK \
  --usdc_token <USDC_SAC_LOCAL>
```

## 5. Configure Environment Variables

Copy the demo env file and fill in your local values:

```bash
cp demo/.env.example demo/.env
```

Edit `demo/.env`:

```dotenv
# Local standalone network
NETWORK=local
RPC_URL=http://localhost:8000/soroban/rpc
NETWORK_PASSPHRASE="Standalone Network ; February 2017"

# Deployed contract IDs (from step 4)
IDENTITY_CONTRACT=<IDENTITY_ID>
COMMERCE_CONTRACT=<COMMERCE_ID>
USDC_TOKEN=<USDC_SAC_LOCAL>

# Seller agent secrets (stellar keys export <name> --network local)
SELLER_SECRET_1=<secret for seller1>
SELLER_SECRET_2=<secret for seller2>
SELLER_SECRET_3=<secret for seller3>
SELLER_SECRET_4=<secret for seller4>
```

## 6. Run the Agents Locally

```bash
# Terminal 1: start registry + all seller agents
./start-agents.sh

# Terminal 2: start the buyer agent
cd agents/buyer && npm start
```

Each agent's logs are color-coded by prefix (e.g. `[REGISTRY]`, `[WEBBUILDER]`) so you can
follow individual streams at a glance.

## 7. Offline Testing with Mock Mode (`MOCK_LLM=true`)

Running seller agents normally requires active external LLM API credentials (`GROQ_API_KEY`). For local integration testing, CI pipelines, or offline development, you can enable mock mode by setting:

```bash
export MOCK_LLM=true
```

Or by adding `MOCK_LLM=true` to your `.env` configuration file:

```dotenv
MOCK_LLM=true
```

### How Mock Mode Works

When `MOCK_LLM=true`:
- `GROQ_API_KEY` is not required for agent startup.
- External LLM API calls are bypassed entirely.
- Seller agents generate realistic canned deliverables:
  - **Web Builder (`seller-webbuilder`)**: Returns a sample HTML/CSS landing page template.
  - **Copywriter (`seller-copywriter`)**: Returns sample marketing copy structured with headline, subhead, body, and CTA.
  - **Namer (`seller-namer`)**: Returns a numbered list of 5 brand name ideas with rationale.
  - **Researcher (`seller-researcher`)**: Returns a formatted JSON research summary with verifiable citations and source URLs.
- The full payment, escrow creation, deliverable submission, and registry reputation flow can be tested end-to-end for free without third-party API dependencies.

## 8. Resetting State

Because the container runs with `--rm`, stopping it wipes all chain state:

```bash
docker stop stellar-local
# Re-run step 1 and re-deploy from step 4 to start fresh
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `docker: Error response from daemon: port is already allocated` | Another service owns port 8000. Change the host port: `-p 8001:8000` and update `RPC_URL`. |
| `stellar: network 'local' not found` | Re-run `stellar network add local …` from step 2. |
| Friendbot returns 400 | Account already funded. Skip or re-create the container. |
| `cargo build` fails with `wasm32-unknown-unknown` target missing | `rustup target add wasm32-unknown-unknown` |
| Contract invoke error `HostError: Value not found` | Contract not initialized. Run the `initialize` invoke from step 4. |

## Frequently Asked Questions & Troubleshooting

### How do I get testnet USDC from the Circle faucet?

Circle runs a USDC faucet for Stellar testnet. Fund a testnet account first (via
[Friendbot](https://friendbot.stellar.org)), then request testnet USDC from the
[Circle USDC faucet](https://faucet.circle.com) by pasting your Stellar testnet public key.

```bash
# 1. Fund the account with testnet XLM
curl "https://friendbot.stellar.org?addr=$(stellar keys address admin)"

# 2. Request testnet USDC at https://faucet.circle.com using the same public key
```

Once funded, verify the balance on
[Stellar Expert (testnet)](https://stellar.expert/explorer/testnet) by searching your public key.

### Why does the OpenZeppelin facilitator require the canonical USDC SAC?

The OpenZeppelin facilitator settles payments against the **canonical USDC Stellar Asset Contract (SAC)**
for the network. If you point `USDC_TOKEN` at a custom or locally deployed token, the facilitator
cannot match the asset it expects and settlement fails. Always use the canonical USDC SAC address
for the network you are targeting:

| Network | Canonical USDC SAC |
|---------|--------------------|
| Testnet | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Mainnet | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |

> **Note:** On a local standalone network there is no canonical USDC, so deploy your own SAC and
> set `USDC_TOKEN` to that address (see step 4).

### How do I switch Freighter to Stellar Testnet?

1. Open the Freighter browser extension.
2. Click the network selector at the top of the popup.
3. Choose **Testnet** (or **Futurenet** if you are testing there).
4. Confirm the network passphrase shown matches `Test SDF Network ; September 2015`.

If your agent still reports a network mismatch, make sure `NETWORK_PASSPHRASE` in your `.env`
matches the network selected in Freighter, then restart the agent.

### How do I resolve `tx failed: txINTERNAL_ERROR`?

`txINTERNAL_ERROR` is a generic Soroban RPC failure. Work through these checks in order:

1. **Network mismatch** — the RPC URL, network passphrase, and Freighter network must all agree.
2. **Unfunded account** — fund the source account with Friendbot (testnet) or the local faucet.
3. **Stale sequence number** — retry the transaction; the SDK re-fetches the sequence automatically.
4. **Contract not initialized** — run the `initialize` invoke (see step 4).
5. **Insufficient USDC** — confirm the payer holds the canonical USDC SAC balance.

Inspect the failing transaction on [Stellar Expert (testnet)](https://stellar.expert/explorer/testnet)
to see the exact ledger error.

### How do I reset local agent caches?

Agents cache identity and listing state between runs. To start clean:

```bash
# Stop running agents first, then clear caches
rm -rf agents/*/.cache agents/*/node_modules/.cache

# Optional: wipe the whole local chain state
docker stop stellar-local
```

After clearing caches, re-run `./start-agents.sh` and the buyer agent. If you also stopped the
Docker container, re-deploy the contracts from step 4 before restarting.

## Further Reading

- [Stellar Quickstart Docker image](https://github.com/stellar/quickstart)
- [Soroban documentation](https://developers.stellar.org/docs/build/smart-contracts/overview)
- [stellar-cli reference](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
- [Stellar Expert — testnet explorer](https://stellar.expert/explorer/testnet)
- [Stellar Laboratory — testnet](https://lab.stellar.org)
- [Circle USDC faucet](https://faucet.circle.com)
- [MAINNET_MIGRATION.md](./MAINNET_MIGRATION.md) — checklist before going to production
