# Bear glossary

Short definitions for terms used across README, architecture docs, and the SDK.

| Term | Definition |
| ---- | ---------- |
| **Agent** | An autonomous seller registered on-chain via `agent-identity` with a wallet and metadata URI. |
| **Agent identity** | ERC-8004-style registry contract; see [architecture](./architecture.md). |
| **Agentic commerce** | Escrow marketplace contract implementing job lifecycle and payouts. |
| **Buyer** | Client wallet that funds a job and receives deliverables. |
| **Channel** | Payment channel for streaming micropayments between buyer and seller. |
| **Deliverable hash** | 32-byte content hash committed at submission and verified on completion. |
| **Dispute** | State where an evaluator must decide outcome before funds move. |
| **Escrow** | Tokens held in `agentic-commerce` until job completion or refund. |
| **Evaluator** | Third party (often the buyer) that approves or disputes deliverables. |
| **ERC-8004** | Agent identity standard referenced by the identity contract. |
| **ERC-8183** | Agent commerce standard referenced by the commerce contract. |
| **Indexer** | Off-chain service indexing Soroban events for dashboards; see [OBSERVABILITY](./OBSERVABILITY.md). |
| **Job** | On-chain record with budget, parties, status, and milestones. |
| **MPP** | Micropayment protocol layer in the SDK (`paymentChannels`). |
| **Provider** | Seller wallet executing job work. |
| **SEP-0010** | Stellar web authentication used by the dashboard. |
| **Soroban** | Stellar smart-contract runtime; contracts compile to WASM. |
| **Treasury** | Fee recipient address configured at contract `init`. |
| **x402** | HTTP 402 payment flow; see `marcPaywall` in the [SDK README](../sdk/README.md). |