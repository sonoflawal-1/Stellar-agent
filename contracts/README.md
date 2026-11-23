# Contracts

Soroban crates: `agent-identity`, `agentic-commerce`.

## Evaluator quorum recovery

The client and provider must both authorize `replace_evaluator` in the same
invocation. This works for funded, submitted, and disputed multi-evaluator
jobs. The replacement must be a different address from the provider and all
current evaluators. It inherits the former evaluator's weight, and any approval
from the former evaluator is removed. The replacement can then approve the job
with that weight. The quorum threshold and escrow balance stay the same.

A job can have at most five evaluators or twenty milestones. Weighted quorums
require one positive weight per evaluator and a reachable threshold. The sum
of evaluator weights must fit in a `u32`.

## Build & test

```bash
rustup target add wasm32v1-none
stellar contract build --optimize
cargo test -p agent-identity -p agentic-commerce
```

## Boundary gas measurements

The `local_wasm_operations` entries in `.gas-baseline.json` record Soroban
host measurements for the five-evaluator and twenty-milestone fixtures. To
reproduce them from the repository root, build the release Wasm and run the
boundary test against it:

```bash
cargo build --release -p agentic-commerce --target wasm32v1-none
COMMERCE_TEST_WASM="$PWD/target/wasm32v1-none/release/agentic_commerce.wasm" \
  cargo test -p agentic-commerce --test evaluator_quorum creation_caps_and_gas_at_the_boundary -- --nocapture
```

The RPC gas check uses the `operations` entries, which come from deployed
contract simulations.

## Mock RPC

Unit tests use `soroban_sdk::Env::default()` with `mock_all_auths()` — no live RPC required. Integration tests may use local standalone via `docker compose up stellar init`.