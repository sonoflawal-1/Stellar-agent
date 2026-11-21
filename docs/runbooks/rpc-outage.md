# Runbook: Soroban RPC outage

**Alert:** dashboard or agents report RPC errors / timeouts.

## Steps

1. Confirm outage scope (single region vs global) via provider status page.
2. Fail over to secondary `SOROBAN_RPC_URL` in env if configured.
3. Set dashboard read-only mode; block `/api/jobs/create` submissions.
4. Notify users on status channel; estimate recovery from provider ETA.
5. After recovery, run `scripts/verify-mainnet.ts` (testnet/mainnet as appropriate) before re-enabling writes.

**Dry-run:** set invalid RPC in staging `.env`, verify read-only banner and recovery steps.