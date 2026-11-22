# Contracts

Soroban crates: `agent-identity`, `agentic-commerce`.

## Agentic commerce fees

Each job records the platform fee rate in basis points at creation.
Admin changes through `set_fee_bps` apply only to jobs created afterward.
Existing jobs keep their original rate for payouts, including provider timeout
payouts through `claim_expired`.

## Build & test

```bash
rustup target add wasm32v1-none
stellar contract build --optimize
cargo test -p agent-identity -p agentic-commerce
```

## Mock RPC

Unit tests use `soroban_sdk::Env::default()` with `mock_all_auths()` — no live RPC required. Integration tests may use local standalone via `docker compose up stellar init`.