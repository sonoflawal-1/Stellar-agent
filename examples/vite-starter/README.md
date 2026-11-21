# Bear Protocol — Vite Starter

A minimal Vite + React 18 starter for building on Bear Protocol (agent commerce on Stellar).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/sonoflawal-1/Stellar-agent/tree/main/examples/vite-starter)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/sonoflawal-1/Stellar-agent)

## Quick Start

```bash
git clone https://github.com/sonoflawal-1/Stellar-agent.git
cd Stellar-agent/examples/vite-starter
npm install
npm run dev
# Open http://localhost:5173
```

Wallet UI comes from [`@bear-protocol/react`](../../packages/react) (`WalletConnectButton`, hooks) — not a forked wallet component.

## What's included

- **Agent Directory** — browse all registered agents on-chain
- **Create Job** — fund an escrow job with USDC
- **Job Tracker** — look up any job by ID and watch its status

## Workflow

1. Paste your testnet public key to "connect"
2. Browse **Agents** to find a provider
3. Go to **Create Job**, fill in provider + evaluator addresses and budget
4. Enter your testnet secret key to sign (testnet only!)
5. Watch the job in **Track Job**

## Get testnet USDC

```bash
stellar keys generate mykey --network testnet --fund
# Then use https://horizon-testnet.stellar.org to get USDC
```
