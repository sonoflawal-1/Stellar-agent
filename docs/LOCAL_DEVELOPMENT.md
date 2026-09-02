# Local Development Guide

This guide walks you through running a fully local Soroban/Stellar network using Docker's
[stellar/quickstart](https://github.com/stellar/quickstart) image. A local standalone network
lets you develop offline, avoid testnet rate limits, and reset state instantly.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Docker | 20+ | [docs.docker.com](https://docs.docker.com/get-docker/) |
| Node.js | 20+ | [nodejs.org](https://nodejs.org) |
| Rust | 1.81+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| stellar-cli | latest | `cargo install stellar-cli --locked` |

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

## 7. Resetting State

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

## Further Reading

- [Stellar Quickstart Docker image](https://github.com/stellar/quickstart)
- [Soroban documentation](https://developers.stellar.org/docs/build/smart-contracts/overview)
- [stellar-cli reference](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
- [MAINNET_MIGRATION.md](./MAINNET_MIGRATION.md) — checklist before going to production
