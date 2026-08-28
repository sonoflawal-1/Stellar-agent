---
name: stellar-hackathon
description: Reference resources for the Stellar Hacks Agents (x402 + Stripe MPP) hackathon. Use when working on the marc-stellar project — building agent payment infrastructure on Stellar/Soroban. Covers x402, MPP (Charge + Session), Soroban primitives, official SDKs, facilitators, starter templates, reference implementations, and AI dev tooling.
---

# Stellar Hacks: Agents — x402 × Stripe MPP Hackathon Reference

Source: https://dorahacks.io/hackathon/stellar-agents-x402-stripe-mpp/resources

Use this skill whenever working on the `marc-stellar` project. It is the curated resource index for the hackathon. Do not re-fetch official docs when this file already has the link and summary you need.

## Context

The hackathon is about agentic payment protocols on Stellar. Two primary standards are in scope:

- **x402** — Coinbase-backed, per-request HTTP 402 payments. Client signs a Soroban auth entry; server pulls payment via a facilitator. Good for one-off micropayments.
- **MPP** (Stripe Machine Payments Protocol) — two modes:
  - **Charge intent** — per-request Soroban token transfer (like x402 Charge).
  - **Session intent** — fund a unidirectional payment channel once, then high-frequency off-chain payments via signed commitments. Batched on-chain settlement.

Both run on **Soroban** (Stellar smart contracts, Rust/WASM). Core primitive is **auth-entry signing**: wallets sign Soroban authorization entries so a relayer/facilitator can invoke the payment transfer atomically.

## Core Protocols

### x402 (Coinbase)

- **Stellar x402 overview**: https://developers.stellar.org/docs/build/agentic-payments/x402
- **x402 Quickstart Guide**: https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide
- **Built-on-Stellar facilitator**: https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar
- **Live demo**: https://stellar.org/x402-demo
- **Facilitator supported networks**: https://www.x402.org/facilitator/supported (stellar:testnet included)
- **Coinbase x402 docs**: https://docs.cdp.coinbase.com/x402/docs/welcome
- **Protocol spec**: https://www.x402.org/
- **Test services playground**: https://xlm402.com

### MPP (Stripe)

- **Stellar MPP overview**: https://developers.stellar.org/docs/build/agentic-payments/mpp
- **Charge guide** (per-request, pull/push credentials): https://developers.stellar.org/docs/build/agentic-payments/mpp/charge-guide
- **Session guide** (unidirectional payment channels): https://developers.stellar.org/docs/build/agentic-payments/mpp/channel-guide
- **Live demo**: https://mpp.stellar.buzz (Node server charging 0.01 USDC/request on testnet)
- **one-way-channel Soroban contract**: https://github.com/stellar-experimental/one-way-channel
- **Stripe MPP docs**: https://docs.stripe.com/payments/machine
- **Stripe MPP quickstart**: https://docs.stripe.com/payments/machine/mpp/quickstart
- **Protocol spec**: https://mpp.dev
- **Stripe product page**: https://stripe.com/blog/machine-payments-protocol
- **Stripe reference sample**: https://github.com/stripe-samples/machine-payments

## Official SDKs and Repos

| Package                   | URL                                        | Purpose                                                                     |
| ------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `stellar/x402-stellar`    | https://github.com/stellar/x402-stellar    | Official monorepo — facilitator, simple-paywall demo, channel account setup |
| `x402-stellar` (npm)      | https://www.npmjs.com/package/x402-stellar | x402 integration library                                                    |
| `coinbase/x402`           | https://github.com/coinbase/x402           | Official x402 protocol repo                                                 |
| `stellar/stellar-mpp-sdk` | https://github.com/stellar/stellar-mpp-sdk | Official MPP SDK + examples                                                 |
| `@stellar/mpp` (npm)      | https://www.npmjs.com/package/@stellar/mpp | MPP client library                                                          |
| `mppx` (npm)              | https://www.npmjs.com/package/mppx         | Core MPP framework                                                          |

## Facilitators

x402 requires a facilitator service (exposes `/verify`, `/settle`, `/supported`). Two options:

- **OpenZeppelin Relayer Plugin** (run your own): https://github.com/OpenZeppelin/relayer-plugin-x402-facilitator
- **OZ docs**: https://docs.openzeppelin.com/relayer/1.4.x/guides/stellar-x402-facilitator-guide
- **Coinbase-hosted facilitator**: available for stellar:testnet

## Compatible Wallets (x402 auth-entry signing required)

Freighter (browser), Albedo, Hana, HOT, Klever, OneKey.
Note: **Freighter mobile does NOT support x402.**

## Starter Templates / Reference Apps

### x402

- **x402 Starter Template (browser wallet)**: https://github.com/ElliotFriend/x402/tree/stellar-browser-wallet-example/examples/typescript/fullstack/browser-wallet-example
- **1-shot Stellar x402 app** (video paywall): https://github.com/oceans404/1-shot-stellar/tree/main/x402-app
- **Economic Load Balancer** (multi-chain router): https://github.com/marcelosalloum/x402/tree/x402-hackathon
- **Stellar Observatory** (space weather via x402, MCP server): https://github.com/elliotfriend/stellar-observatory — live: https://stellar-observatory.vercel.app
- **jamesbachini x402 Stellar demo** (minimal local): https://github.com/jamesbachini/x402-Stellar-Demo
- **x402 MCP server for agents**: https://github.com/jamesbachini/x402-mcp-stellar — lets Claude Code / Codex pay for x402 services
- **Sponsored agent account** (give an agent a USDC wallet in <1 min, no XLM needed): https://github.com/oceans404/stellar-sponsored-agent-account — skill: https://stellar-sponsored-agent-account.onrender.com/SKILL.md

### DeFi / Composition References

- **AI Freighter Integration**: https://github.com/carstenjacobsen/ai-freighter-integration
- **AI Soroswap Integration** (multi-DEX): https://github.com/carstenjacobsen/ai-soroswap-integration
- **AI DeFindex Integration** (yield vaults): https://github.com/carstenjacobsen/ai-defindex-integration
- **AI Passkeys Integration** (WebAuthn smart wallet): https://github.com/carstenjacobsen/ai-passkeys-integration
- **AI Etherfuse Integration**: https://github.com/carstenjacobsen/ai-etherfuse-integration
- **Stellar DeFi App dashboard**: https://github.com/kaankacar/stellar-defi-app (Blend, Soroswap, Phoenix, Aquarius, SDEX, Reflector)
- **Ya Otter Save** (fiat→stablebonds→DEX→USDC→Blend): https://github.com/briwylde08/ya-otter-save
- **Anchor Starter Pack** (SEP-1/6/10/12/24/31/38): https://github.com/ElliotFriend/regional-starter-pack

## Stellar Dev Tooling

| Tool                       | URL                                                  | Notes                              |
| -------------------------- | ---------------------------------------------------- | ---------------------------------- |
| Docs                       | https://developers.stellar.org/                      | Core docs                          |
| llms.txt                   | https://developers.stellar.org/llms.txt              | Machine-readable digest for LLMs   |
| SDKs                       | https://developers.stellar.org/docs/tools/sdks       | All language SDKs                  |
| Stellar CLI                | https://developers.stellar.org/docs/tools/cli        | Build/deploy Soroban contracts     |
| Lab                        | https://developers.stellar.org/docs/tools/lab        | Browser-based wallet gen + testing |
| Quickstart (local network) | https://developers.stellar.org/docs/tools/quickstart | Docker local network               |
| Wallets Kit                | https://stellarwalletskit.dev/                       | Unified wallet connection          |
| Scaffold Stellar           | https://scaffoldstellar.org                          | Full app lifecycle CLI             |

## Soroban Building Blocks (essential reading)

- **Contract Accounts**: https://developers.stellar.org/docs/build/guides/contract-accounts
- **Contract Authorization model**: https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization
- **Signing Soroban Invocations** (auth-entry signing): https://developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations

## AI Dev Assistance

- **Stellar Dev Skill** (Claude Code): https://github.com/stellar/stellar-dev-skill — invoke as `stellar-dev:stellar-dev`
- **OpenZeppelin Skills**: https://github.com/OpenZeppelin/openzeppelin-skills — `/plugin marketplace add OpenZeppelin/openzeppelin-skills` (includes MCP server for contract generation)
- **Smart Account Kit** (passkey wallets): https://github.com/kalepail/smart-account-kit
- **Stellar MCP server**: https://github.com/kalepail/stellar-mcp-server
- **XDR MCP**: https://github.com/stellar-experimental/mcp-stellar-xdr
- **OpenZeppelin on Stellar** (audited libs, Wizard, Relayer, Detectors): https://www.openzeppelin.com/networks/stellar
- **Free AI setup guide**: https://github.com/kaankacar/stellar-ai-guide-mx/blob/main/Free_AI_Setup.md

## Community / Gotchas

- **Stellar Hackathon FAQ**: https://github.com/briwylde08/stellar-hackathon-faq
- **Stellar DeFi Gotchas** (400+ findings from vibe-coding runs): https://github.com/kaankacar/stellar-defi-gotchas
- **Ecosystem DB** (646 projects indexed): https://github.com/lumenloop/stellar-ecosystem-db — check here BEFORE building to avoid duplicating existing work
- **Ecosystem Resources**: https://github.com/stellar/ecosystem-resources/

## Quick Decision Tree

- **Need per-request micropayment for an API?** → x402 Charge OR MPP Charge
- **Agent makes hundreds of calls/sec?** → MPP Session (payment channel)
- **Need a facilitator?** → Use Coinbase-hosted on testnet first, OpenZeppelin Relayer plugin for mainnet/self-host
- **Need wallet in AI context?** → Sponsored agent account repo (no XLM bootstrap needed)
- **Unsure if something already exists?** → Check Stellar Ecosystem DB first
- **Need to auth a Soroban call from off-chain?** → Read "Signing Soroban Invocations" + contract-authorization docs

## Project Context: marc-stellar

This project is a Stellar/Soroban adaptation of the MARC Protocol (https://github.com/marc-protocol/marc), originally built on Zama fhEVM. The original uses **FHE (Fully Homomorphic Encryption)** to hide payment amounts on-chain. **Stellar has no FHE**, so the Stellar port must use a different privacy primitive. See the design doc in `docs/superpowers/specs/` for the chosen approach.

Original MARC repo on disk: `/Users/ram/Desktop/marc`
This project: `/Users/ram/Desktop/marc-stellar`
