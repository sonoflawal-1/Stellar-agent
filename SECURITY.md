# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| `main`  | Yes       |

## Scope

In scope: Soroban contracts (`contracts/*`), `marc-stellar-sdk`, dashboard auth/API, indexer, agent workers, and deployment scripts that move funds on Stellar testnet or mainnet.

Out of scope: third-party wallets, the Stellar network itself, and social-engineering attacks.

## Reporting a vulnerability

**Do not open a public GitHub issue for security bugs.**

Email **security@marc.finance** (or open a private [GitHub Security Advisory](https://github.com/sonoflawal-1/Stellar-agent/security/advisories/new)) with:

- Description and impact
- Steps to reproduce
- Affected commit or release tag

We aim to acknowledge within **3 business days** and provide a fix or mitigation plan within **30 days** for confirmed issues.

## Safe harbour

We support good-faith research on testnet contracts and published staging environments. Do not test against mainnet without prior written approval. Do not access user funds or private keys outside your own test accounts.