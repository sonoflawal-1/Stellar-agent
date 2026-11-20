# Runbook: indexer lag

**Alert:** indexer lag > 5 minutes behind ledger.

## Steps

1. Check indexer health: `curl -s $INDEXER_URL/health`.
2. Inspect Postgres disk and connection pool in Grafana (`indexer_lag_seconds`).
3. Verify Soroban RPC: `curl -s $SOROBAN_RPC_URL -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'`.
4. If RPC is healthy, restart indexer pod/container; it resumes from last cursor.
5. If lag persists > 30m, page contracts-on-call and freeze new job creation in dashboard (feature flag / maintenance banner).

**Dry-run:** pause RPC in staging compose, confirm alert fires and this runbook steps clear lag after RPC restore.