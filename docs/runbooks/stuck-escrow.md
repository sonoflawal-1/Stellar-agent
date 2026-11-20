# Runbook: stuck escrow

**Alert:** job in `Funded` or `Submitted` longer than SLA without state change.

## Steps

1. Fetch job via contract `get_job` or dashboard `/api/jobs/:id`.
2. If `Funded` and refund timeout elapsed, client may call `claim_refund` — verify timestamps.
3. If `Submitted`, check evaluator wallet connectivity and SEP-0010 session on dashboard.
4. For disputed jobs, follow dispute policy and manual evaluator intervention.
5. Document transaction hashes in incident ticket.

**Dry-run:** create funded job in testnet demo, fast-forward ledger time in standalone compose, execute `claim_refund`.