# Mainnet readiness checklist

Track operational gates before pointing production traffic at mainnet contracts. Update **Status** as work completes.

| Item | Owner | Status | Notes |
| ---- | ----- | ------ | ----- |
| Third-party contract audit completed | Security | ☐ | Link report in release notes |
| Critical audit findings remediated | Contracts | ☐ | |
| Reproducible WASM hashes published | DevOps | ☐ | See `docs/REPRODUCIBLE_WASM_BUILDS.md` |
| `verify-mainnet` script passes | DevOps | ☐ | `npx tsx scripts/verify-mainnet.ts` |
| Multisig / HSM for deployer keys | Ops | ☐ | |
| Indexer + dashboard monitoring live | Ops | ☐ | Grafana per `docs/OBSERVABILITY.md` |
| Runbooks exercised | On-call | ☐ | `docs/runbooks/` |
| Rate limits and RPC failover tested | Backend | ☐ | |
| Incident comms channel defined | Ops | ☐ | |
| Mainnet contract addresses in `deployments/mainnet.json` | Contracts | ☐ | |

See also [MAINNET_MIGRATION.md](./MAINNET_MIGRATION.md) for narrative context.