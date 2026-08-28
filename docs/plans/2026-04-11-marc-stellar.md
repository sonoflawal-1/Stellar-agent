# MARC on Stellar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the MARC Protocol (commerce layer for agent payments) on Stellar testnet in 48 hours: 2 Soroban contracts, a TypeScript SDK wrapping `x402-stellar`, a CLI demo, a static landing page, and all submission materials.

**Architecture:** Two Soroban contracts (`agent_identity` ERC-8004-style, `agentic_commerce` ERC-8183-style job escrow with 1% platform fee) sit on top of the existing Stellar `x402` payment rails. A thin TypeScript SDK exposes typed helpers for both contracts plus a re-export of `x402-stellar`'s Express paywall and fetch client. A CLI demo orchestrates the full buyer/seller lifecycle end-to-end for the pitch video. A static HTML/CSS landing page (1:1 visual identity with `marcprotocol.com`) handles the marketing surface.

**Tech Stack:** Rust 1.92 + `soroban-sdk` 22.x (contracts, `wasm32v1-none` target), Cargo workspace, Node 22+ + TypeScript 5.x + `@stellar/stellar-sdk` + `x402-stellar` (SDK/demo), Express 4 (paywall), plain HTML/CSS/vanilla JS + Inter (Google Fonts) + Lucide (landing), `stellar` CLI 25.2 for deploy, Vercel for static hosting.

---

## Reference Documents (read before starting)

- **Locked spec:** `docs/superpowers/specs/2026-04-11-marc-stellar-design.md`
- **Design system (visual tokens):** `docs/design-system.md`
- **Hackathon resources skill:** `.claude/skills/stellar-hackathon/SKILL.md`
- **Original MARC Solidity contracts (shape reference, NOT copy-paste):**
  - `/Users/ram/Desktop/marc/contracts/AgentIdentityRegistry.sol`
  - `/Users/ram/Desktop/marc/contracts/AgenticCommerceProtocol.sol`
- **Soroban auth-entry signing (must understand before SDK work):** https://developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations
- **x402-stellar README:** https://github.com/stellar/x402-stellar

---

## Operating Rules

1. **TDD for contracts.** Every contract entry point is written test-first. No entry point lands without a failing test followed by a passing test.
2. **Commit after every green test.** Small commits, conventional messages (`feat:`, `test:`, `chore:`, `docs:`, `fix:`).
3. **No rebases, no force pushes.** Linear history via normal commits is fine.
4. **Work directory:** `/Users/ram/Desktop/marc-stellar`. All file paths below are relative to this root unless stated otherwise.
5. **Do not add FHE, reputation, framework plugins, React dashboard, or anything else in the "Cut list" of the spec.** If a step feels like it needs something not in this plan, STOP and flag it before building it.
6. **Soroban syntax traps:** use `wasm32v1-none` target (not `wasm32-unknown-unknown` — 25.x CLI rejects the old target). Use `soroban-sdk::contracttype` for structs, `#[contract]` + `#[contractimpl]` for the module, and `env.storage().persistent()` for long-lived state. Use `Symbol::short("name")` for event topics.

---

## Phase 0: Workspace Scaffolding

### Task 0.1: Initialize Rust workspace + gitignore additions

**Files:**

- Create: `Cargo.toml` (workspace root)
- Create: `rust-toolchain.toml`
- Modify: `.gitignore`
- Create: `deployments/.gitkeep`

**Step 1: Write `Cargo.toml`**

```toml
[workspace]
resolver = "2"
members = [
    "contracts/agent-identity",
    "contracts/agentic-commerce",
]

[workspace.package]
version = "0.1.0"
edition = "2021"
rust-version = "1.81"
license = "MIT"

[workspace.dependencies]
soroban-sdk = "22.0.8"

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true
```

**Step 2: Write `rust-toolchain.toml`**

```toml
[toolchain]
channel = "stable"
targets = ["wasm32v1-none"]
```

**Step 3: Append to `.gitignore`**

```
# Rust
target/
**/*.rs.bk
Cargo.lock

# Node
node_modules/
dist/
*.tsbuildinfo

# Deployments (keep file, ignore contents except .gitkeep)
deployments/*.json

# OS / editor
.DS_Store
.vscode/
.idea/
```

**Step 4: Create `deployments/.gitkeep` (empty file)**

**Step 5: Commit**

```bash
git add Cargo.toml rust-toolchain.toml .gitignore deployments/.gitkeep
git commit -m "chore: initialize Cargo workspace for Soroban contracts"
```

---

### Task 0.2: Scaffold SDK package

**Files:**

- Create: `sdk/package.json`
- Create: `sdk/tsconfig.json`
- Create: `sdk/src/index.ts` (empty re-export stub)
- Create: `sdk/README.md` (one paragraph)

**Step 1: Write `sdk/package.json`**

```json
{
  "name": "marc-stellar-sdk",
  "version": "0.1.0",
  "description": "Commerce layer SDK for MARC on Stellar — typed helpers for agent_identity + agentic_commerce contracts, plus x402-stellar re-exports.",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@stellar/stellar-sdk": "^13.0.0",
    "x402-stellar": "^0.2.0"
  },
  "peerDependencies": {
    "express": "^4.19.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  }
}
```

**Step 2: Write `sdk/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

**Step 3: Write placeholder `sdk/src/index.ts`**

```ts
// marc-stellar-sdk entry point. Real exports land in phase 5.
export const MARC_STELLAR_SDK_VERSION = "0.1.0";
```

**Step 4: Write `sdk/README.md`**

```markdown
# marc-stellar-sdk

Typed TypeScript helpers for the two MARC Soroban contracts, plus re-exports of `x402-stellar`. See `../docs/superpowers/specs/2026-04-11-marc-stellar-design.md` for the design.
```

**Step 5: Install deps to validate**

Run: `cd sdk && npm install && cd ..`
Expected: lockfile generated, no errors.

**Step 6: Commit**

```bash
git add sdk/
git commit -m "chore: scaffold marc-stellar-sdk package"
```

---

### Task 0.3: Scaffold demo + landing + docs + scripts directories

**Files:**

- Create: `demo/package.json`
- Create: `demo/tsconfig.json`
- Create: `demo/.env.example`
- Create: `landing/.gitkeep`
- Create: `scripts/deploy-testnet.sh` (skeleton)
- Create: `scripts/build.sh`

**Step 1: Write `demo/package.json`**

```json
{
  "name": "marc-stellar-demo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "seller": "tsx seller-agent.ts",
    "buyer": "tsx buyer-agent.ts",
    "lifecycle": "tsx lifecycle.ts"
  },
  "dependencies": {
    "marc-stellar-sdk": "file:../sdk",
    "@stellar/stellar-sdk": "^13.0.0",
    "x402-stellar": "^0.2.0",
    "express": "^4.19.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  }
}
```

**Step 2: Write `demo/tsconfig.json`** (same as sdk, `rootDir: "."`, no `outDir`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["*.ts"]
}
```

**Step 3: Write `demo/.env.example`**

```
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
USDC_TOKEN_CONTRACT=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
AGENT_IDENTITY_CONTRACT=
AGENTIC_COMMERCE_CONTRACT=
X402_FACILITATOR_URL=https://facilitator.x402.org
BUYER_SECRET=
SELLER_SECRET=
SELLER_PORT=4402
```

Note: `USDC_TOKEN_CONTRACT` value above is Circle's canonical testnet USDC SAC on Stellar (verified in `stellar-hackathon` skill). Update if the deploy script confirms a different address on the deploy day.

**Step 4: Write `scripts/build.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "==> Building Soroban contracts"
cargo build --target wasm32v1-none --release
echo "==> Optimizing WASM"
for wasm in target/wasm32v1-none/release/*.wasm; do
  stellar contract optimize --wasm "$wasm"
done
echo "==> Building SDK"
(cd sdk && npm run build)
echo "==> Done"
```

**Step 5: Write `scripts/deploy-testnet.sh` skeleton**

```bash
#!/usr/bin/env bash
set -euo pipefail
# Deploys agent_identity + agentic_commerce to Stellar testnet.
# Requires: stellar CLI configured with an identity named "deployer".
# Outputs: deployments/testnet.json with contract addresses.
echo "==> Deploying MARC Stellar contracts to testnet"
echo "NOTE: This script is populated in Phase 4."
exit 1
```

**Step 6: chmod + commit**

```bash
chmod +x scripts/build.sh scripts/deploy-testnet.sh
touch landing/.gitkeep
git add demo/ landing/.gitkeep scripts/
git commit -m "chore: scaffold demo, landing, and scripts directories"
```

---

## Phase 1: `agent_identity` Contract (warm-up, TDD)

### Task 1.1: Create contract crate + smoke test

**Files:**

- Create: `contracts/agent-identity/Cargo.toml`
- Create: `contracts/agent-identity/src/lib.rs`
- Create: `contracts/agent-identity/src/test.rs`

**Step 1: Write `contracts/agent-identity/Cargo.toml`**

```toml
[package]
name = "agent-identity"
version.workspace = true
edition.workspace = true
publish = false

[lib]
crate-type = ["cdylib"]
doctest = false

[dependencies]
soroban-sdk = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
```

**Step 2: Write empty `contracts/agent-identity/src/lib.rs`**

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Symbol};

#[contract]
pub struct AgentIdentityContract;

#[contractimpl]
impl AgentIdentityContract {}

#[cfg(test)]
mod test;
```

**Step 3: Write smoke test in `contracts/agent-identity/src/test.rs`**

```rust
#![cfg(test)]
use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Env, Address};

#[test]
fn contract_can_be_deployed() {
    let env = Env::default();
    let contract_id = env.register(AgentIdentityContract, ());
    let _client = AgentIdentityContractClient::new(&env, &contract_id);
    // If the contract registers without panicking, the test passes.
}
```

**Step 4: Run the test**

Run: `cargo test -p agent-identity`
Expected: 1 passed.

**Step 5: Commit**

```bash
git add contracts/agent-identity/
git commit -m "feat(agent-identity): scaffold contract with smoke test"
```

---

### Task 1.2: Storage types + `register` happy path

**Files:**

- Modify: `contracts/agent-identity/src/lib.rs`
- Modify: `contracts/agent-identity/src/test.rs`

**Step 1: Add the failing test first**

Append to `test.rs`:

```rust
#[test]
fn register_assigns_sequential_ids_and_stores_agent() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let uri_a = String::from_str(&env, "ipfs://alice.json");
    let uri_b = String::from_str(&env, "ipfs://bob.json");

    let id_a = client.register(&alice, &uri_a);
    let id_b = client.register(&bob, &uri_b);

    assert_eq!(id_a, 1);
    assert_eq!(id_b, 2);

    let agent_a = client.get_agent(&id_a).unwrap();
    assert_eq!(agent_a.owner, alice);
    assert_eq!(agent_a.uri, uri_a);

    assert_eq!(client.agent_of(&alice), Some(1));
    assert_eq!(client.agent_of(&bob), Some(2));
}
```

**Step 2: Run the test**

Run: `cargo test -p agent-identity register_assigns`
Expected: FAIL — `register` method does not exist.

**Step 3: Implement the minimum to pass**

Replace the contents of `lib.rs` with:

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Symbol};

#[derive(Clone)]
#[contracttype]
pub struct Agent {
    pub id: u64,
    pub owner: Address,
    pub uri: String,
}

#[contracttype]
enum DataKey {
    NextId,
    Agent(u64),
    OwnerToId(Address),
}

#[contract]
pub struct AgentIdentityContract;

#[contractimpl]
impl AgentIdentityContract {
    /// Register a new agent. Caller must sign for `owner`.
    pub fn register(env: Env, owner: Address, uri: String) -> u64 {
        owner.require_auth();

        if env.storage().persistent().has(&DataKey::OwnerToId(owner.clone())) {
            panic!("owner already registered");
        }

        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1);

        let agent = Agent { id: next, owner: owner.clone(), uri };
        env.storage().persistent().set(&DataKey::Agent(next), &agent);
        env.storage().persistent().set(&DataKey::OwnerToId(owner.clone()), &next);
        env.storage().instance().set(&DataKey::NextId, &(next + 1));

        env.events().publish(
            (Symbol::new(&env, "registered"), owner),
            next,
        );

        next
    }

    pub fn get_agent(env: Env, id: u64) -> Option<Agent> {
        env.storage().persistent().get(&DataKey::Agent(id))
    }

    pub fn agent_of(env: Env, owner: Address) -> Option<u64> {
        env.storage().persistent().get(&DataKey::OwnerToId(owner))
    }
}

#[cfg(test)]
mod test;
```

**Step 4: Run the test**

Run: `cargo test -p agent-identity`
Expected: 2 passed.

**Step 5: Commit**

```bash
git add contracts/agent-identity/
git commit -m "feat(agent-identity): implement register + get_agent + agent_of"
```

---

### Task 1.3: `update_uri` entry point

**Files:**

- Modify: `contracts/agent-identity/src/lib.rs`
- Modify: `contracts/agent-identity/src/test.rs`

**Step 1: Add failing tests** (update happy path + "not owner" panic)

Append to `test.rs`:

```rust
#[test]
fn update_uri_changes_the_agent_uri() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a1.json"));
    client.update_uri(&alice, &id, &String::from_str(&env, "ipfs://a2.json"));

    let agent = client.get_agent(&id).unwrap();
    assert_eq!(agent.uri, String::from_str(&env, "ipfs://a2.json"));
}

#[test]
#[should_panic(expected = "not agent owner")]
fn update_uri_rejects_non_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let mallory = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a1.json"));
    client.update_uri(&mallory, &id, &String::from_str(&env, "ipfs://hax.json"));
}
```

**Step 2: Run — expect failure**

Run: `cargo test -p agent-identity update_uri`
Expected: FAIL — `update_uri` does not exist.

**Step 3: Add `update_uri` to `lib.rs`** (inside `#[contractimpl]`)

```rust
pub fn update_uri(env: Env, caller: Address, id: u64, new_uri: String) {
    caller.require_auth();
    let mut agent: Agent = env
        .storage()
        .persistent()
        .get(&DataKey::Agent(id))
        .unwrap_or_else(|| panic!("agent not found"));
    if agent.owner != caller {
        panic!("not agent owner");
    }
    agent.uri = new_uri;
    env.storage().persistent().set(&DataKey::Agent(id), &agent);
    env.events().publish(
        (Symbol::new(&env, "uri_updated"), caller),
        id,
    );
}
```

**Step 4: Run tests**

Run: `cargo test -p agent-identity`
Expected: 4 passed.

**Step 5: Commit**

```bash
git add contracts/agent-identity/
git commit -m "feat(agent-identity): add update_uri entry point + owner-only guard"
```

---

### Task 1.4: `deregister` entry point

**Files:**

- Modify: `contracts/agent-identity/src/lib.rs`
- Modify: `contracts/agent-identity/src/test.rs`

**Step 1: Add failing test**

```rust
#[test]
fn deregister_removes_agent_and_owner_lookup() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a.json"));
    client.deregister(&alice, &id);

    assert!(client.get_agent(&id).is_none());
    assert_eq!(client.agent_of(&alice), None);
}
```

**Step 2: Run — expect FAIL**

**Step 3: Implement `deregister`** (inside `#[contractimpl]`)

```rust
pub fn deregister(env: Env, caller: Address, id: u64) {
    caller.require_auth();
    let agent: Agent = env
        .storage()
        .persistent()
        .get(&DataKey::Agent(id))
        .unwrap_or_else(|| panic!("agent not found"));
    if agent.owner != caller {
        panic!("not agent owner");
    }
    env.storage().persistent().remove(&DataKey::Agent(id));
    env.storage().persistent().remove(&DataKey::OwnerToId(agent.owner.clone()));
    env.events().publish(
        (Symbol::new(&env, "deregistered"), agent.owner),
        id,
    );
}
```

**Step 4: Run tests — expect 5 passed.**

**Step 5: Commit**

```bash
git add contracts/agent-identity/
git commit -m "feat(agent-identity): add deregister entry point"
```

---

### Task 1.5: Build identity contract WASM

**Step 1: Build**

Run: `cargo build -p agent-identity --target wasm32v1-none --release`
Expected: compiles clean, produces `target/wasm32v1-none/release/agent_identity.wasm`.

**Step 2: Optimize**

Run: `stellar contract optimize --wasm target/wasm32v1-none/release/agent_identity.wasm`
Expected: produces `agent_identity.optimized.wasm` alongside.

**Step 3: Commit** (nothing to commit — target/ is ignored — skip)

---

## Phase 2: `agentic_commerce` Contract (TDD)

### Task 2.1: Scaffold crate + smoke test

**Files:**

- Create: `contracts/agentic-commerce/Cargo.toml` (same shape as identity)
- Create: `contracts/agentic-commerce/src/lib.rs`
- Create: `contracts/agentic-commerce/src/test.rs`

**Step 1: Copy the identity `Cargo.toml`, rename package to `agentic-commerce`.**

**Step 2: Write stub `lib.rs`**

```rust
#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Env, String, Symbol,
};

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JobStatus {
    Open,
    Funded,
    Submitted,
    Completed,
    Rejected,
    Cancelled,
}

#[derive(Clone)]
#[contracttype]
pub struct Job {
    pub id: u64,
    pub client: Address,
    pub provider: Address,
    pub evaluator: Address,
    pub token: Address,
    pub budget: i128,
    pub status: JobStatus,
    pub description: String,
    pub deliverable: String,
}

#[contracttype]
enum DataKey {
    NextId,
    Job(u64),
    Treasury,
    Admin,
    FeeBps,
}

const DEFAULT_FEE_BPS: u32 = 100; // 1%
const MAX_FEE_BPS: u32 = 500;     // 5% hard cap
const BPS_DENOM: i128 = 10_000;

#[contract]
pub struct AgenticCommerceContract;

#[contractimpl]
impl AgenticCommerceContract {
    pub fn init(env: Env, admin: Address, treasury: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::FeeBps, &DEFAULT_FEE_BPS);
        env.storage().instance().set(&DataKey::NextId, &1u64);
    }
}

#[cfg(test)]
mod test;
```

**Step 3: Write smoke test**

```rust
#![cfg(test)]
use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

fn setup(env: &Env) -> (AgenticCommerceContractClient, Address, Address) {
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let contract_id = env.register(AgenticCommerceContract, ());
    let client = AgenticCommerceContractClient::new(env, &contract_id);
    client.init(&admin, &treasury);
    (client, admin, treasury)
}

#[test]
fn init_sets_admin_and_treasury() {
    let env = Env::default();
    env.mock_all_auths();
    let (_client, _admin, _treasury) = setup(&env);
}
```

**Step 4: Run**

Run: `cargo test -p agentic-commerce`
Expected: 1 passed.

**Step 5: Commit**

```bash
git add contracts/agentic-commerce/
git commit -m "feat(agentic-commerce): scaffold contract with init + smoke test"
```

---

### Task 2.2: `create_job` with token escrow pull

**Files:**

- Modify: `contracts/agentic-commerce/src/lib.rs`
- Modify: `contracts/agentic-commerce/src/test.rs`

**Step 1: Failing test**

Append to `test.rs`:

```rust
use soroban_sdk::token::{StellarAssetClient, TokenClient};

fn deploy_token<'a>(env: &Env, admin: &Address) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let contract = env.register_stellar_asset_contract_v2(admin.clone());
    let addr = contract.address();
    (addr.clone(), TokenClient::new(env, &addr), StellarAssetClient::new(env, &addr))
}

#[test]
fn create_job_transfers_budget_into_escrow() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let evaluator = buyer.clone(); // buyer is also evaluator in our v1

    let (token_addr, token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let contract_id = client.address.clone();
    let budget: i128 = 100_000;

    let job_id = client.create_job(
        &buyer,
        &seller,
        &evaluator,
        &token_addr,
        &budget,
        &String::from_str(&env, "ipfs://job.json"),
    );

    assert_eq!(job_id, 1);
    assert_eq!(token.balance(&contract_id), 100_000);
    assert_eq!(token.balance(&buyer), 900_000);

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Funded);
    assert_eq!(job.budget, budget);
    let _ = treasury;
}
```

**Step 2: Run — expect FAIL**

**Step 3: Implement `create_job`** (inside `#[contractimpl]`)

```rust
pub fn create_job(
    env: Env,
    client_addr: Address,
    provider: Address,
    evaluator: Address,
    token: Address,
    budget: i128,
    description: String,
) -> u64 {
    client_addr.require_auth();
    if budget <= 0 {
        panic!("budget must be positive");
    }

    let next: u64 = env.storage().instance().get(&DataKey::NextId).unwrap();
    let job = Job {
        id: next,
        client: client_addr.clone(),
        provider,
        evaluator,
        token: token.clone(),
        budget,
        status: JobStatus::Funded,
        description,
        deliverable: String::from_str(&env, ""),
    };

    // Pull funds into contract escrow.
    let token_client = token::Client::new(&env, &token);
    token_client.transfer(&client_addr, &env.current_contract_address(), &budget);

    env.storage().persistent().set(&DataKey::Job(next), &job);
    env.storage().instance().set(&DataKey::NextId, &(next + 1));

    env.events().publish(
        (Symbol::new(&env, "job_created"), client_addr),
        (next, budget),
    );

    next
}

pub fn get_job(env: Env, id: u64) -> Option<Job> {
    env.storage().persistent().get(&DataKey::Job(id))
}
```

**Step 4: Run**

Run: `cargo test -p agentic-commerce`
Expected: 2 passed.

**Step 5: Commit**

```bash
git add contracts/agentic-commerce/
git commit -m "feat(agentic-commerce): create_job escrows budget from client"
```

---

### Task 2.3: `submit` entry point (provider-only)

**Files:**

- Modify: `contracts/agentic-commerce/src/lib.rs`
- Modify: `contracts/agentic-commerce/src/test.rs`

**Step 1: Add two failing tests** (happy path + provider-only guard)

```rust
#[test]
fn submit_flips_status_and_records_deliverable() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer, &seller, &buyer, &token_addr, &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
    );

    client.submit(&seller, &id, &String::from_str(&env, "ipfs://work.json"));

    let job = client.get_job(&id).unwrap();
    assert_eq!(job.status, JobStatus::Submitted);
    assert_eq!(job.deliverable, String::from_str(&env, "ipfs://work.json"));
}

#[test]
#[should_panic(expected = "not provider")]
fn submit_rejects_non_provider() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer, &seller, &buyer, &token_addr, &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
    );
    client.submit(&mallory, &id, &String::from_str(&env, "ipfs://hax.json"));
}
```

**Step 2: Run — FAIL**

**Step 3: Implement `submit`**

```rust
pub fn submit(env: Env, caller: Address, id: u64, deliverable: String) {
    caller.require_auth();
    let mut job: Job = env
        .storage()
        .persistent()
        .get(&DataKey::Job(id))
        .unwrap_or_else(|| panic!("job not found"));
    if caller != job.provider {
        panic!("not provider");
    }
    if job.status != JobStatus::Funded {
        panic!("invalid status");
    }
    job.status = JobStatus::Submitted;
    job.deliverable = deliverable;
    env.storage().persistent().set(&DataKey::Job(id), &job);
    env.events().publish(
        (Symbol::new(&env, "job_submitted"), caller),
        id,
    );
}
```

**Step 4: Run** — 4 passed.

**Step 5: Commit**

```bash
git commit -am "feat(agentic-commerce): add submit entry point"
```

---

### Task 2.4: `complete` with 99/1 fee split

**Files:**

- Modify: `contracts/agentic-commerce/src/lib.rs`
- Modify: `contracts/agentic-commerce/src/test.rs`

**Step 1: Failing test**

```rust
#[test]
fn complete_splits_payout_99_1_between_provider_and_treasury() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer, &seller, &buyer, &token_addr, &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
    );
    client.submit(&seller, &id, &String::from_str(&env, "ipfs://work.json"));
    client.complete(&buyer, &id);

    assert_eq!(token.balance(&seller), 99_000);
    assert_eq!(token.balance(&treasury), 1_000);
    assert_eq!(token.balance(&client.address), 0);
    let job = client.get_job(&id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
}
```

**Step 2: Run — FAIL**

**Step 3: Implement `complete`**

```rust
pub fn complete(env: Env, caller: Address, id: u64) {
    caller.require_auth();
    let mut job: Job = env
        .storage()
        .persistent()
        .get(&DataKey::Job(id))
        .unwrap_or_else(|| panic!("job not found"));
    if caller != job.evaluator {
        panic!("not evaluator");
    }
    if job.status != JobStatus::Submitted {
        panic!("invalid status");
    }
    let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap();
    let fee: i128 = (job.budget * (fee_bps as i128)) / BPS_DENOM;
    let payout: i128 = job.budget - fee;

    let token_client = token::Client::new(&env, &job.token);
    token_client.transfer(&env.current_contract_address(), &job.provider, &payout);
    if fee > 0 {
        let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
        token_client.transfer(&env.current_contract_address(), &treasury, &fee);
    }

    job.status = JobStatus::Completed;
    env.storage().persistent().set(&DataKey::Job(id), &job);

    env.events().publish(
        (Symbol::new(&env, "job_completed"), caller),
        (id, payout, fee),
    );
}
```

**Step 4: Run** — 5 passed.

**Step 5: Commit**

```bash
git commit -am "feat(agentic-commerce): add complete with 1% platform fee split"
```

---

### Task 2.5: `cancel` refund path

**Files:**

- Modify: `contracts/agentic-commerce/src/lib.rs`
- Modify: `contracts/agentic-commerce/src/test.rs`

**Step 1: Failing test**

```rust
#[test]
fn cancel_refunds_buyer_when_not_yet_submitted() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer, &seller, &buyer, &token_addr, &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
    );
    assert_eq!(token.balance(&buyer), 900_000);

    client.cancel(&buyer, &id);
    assert_eq!(token.balance(&buyer), 1_000_000);
    let job = client.get_job(&id).unwrap();
    assert_eq!(job.status, JobStatus::Cancelled);
}
```

**Step 2: Run — FAIL**

**Step 3: Implement `cancel`**

```rust
pub fn cancel(env: Env, caller: Address, id: u64) {
    caller.require_auth();
    let mut job: Job = env
        .storage()
        .persistent()
        .get(&DataKey::Job(id))
        .unwrap_or_else(|| panic!("job not found"));
    if caller != job.client {
        panic!("not client");
    }
    if job.status != JobStatus::Funded {
        panic!("invalid status");
    }
    let token_client = token::Client::new(&env, &job.token);
    token_client.transfer(&env.current_contract_address(), &job.client, &job.budget);
    job.status = JobStatus::Cancelled;
    env.storage().persistent().set(&DataKey::Job(id), &job);
    env.events().publish(
        (Symbol::new(&env, "job_cancelled"), caller),
        id,
    );
}
```

**Step 4: Run** — 6 passed.

**Step 5: Commit**

```bash
git commit -am "feat(agentic-commerce): add cancel refund path"
```

---

### Task 2.6: Admin functions + fee cap guard

**Files:**

- Modify: `contracts/agentic-commerce/src/lib.rs`
- Modify: `contracts/agentic-commerce/src/test.rs`

**Step 1: Failing tests**

```rust
#[test]
fn admin_can_update_treasury_and_fee_within_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let new_treasury = Address::generate(&env);
    client.set_treasury(&admin, &new_treasury);
    client.set_fee_bps(&admin, &200u32);
    assert_eq!(client.fee_bps(), 200);
}

#[test]
#[should_panic(expected = "fee too high")]
fn set_fee_bps_rejects_over_max() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    client.set_fee_bps(&admin, &501u32);
}
```

**Step 2: Implement** (append to `impl`)

```rust
pub fn set_treasury(env: Env, caller: Address, new_treasury: Address) {
    caller.require_auth();
    let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
    if caller != admin { panic!("not admin"); }
    env.storage().instance().set(&DataKey::Treasury, &new_treasury);
}

pub fn set_fee_bps(env: Env, caller: Address, new_bps: u32) {
    caller.require_auth();
    let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
    if caller != admin { panic!("not admin"); }
    if new_bps > MAX_FEE_BPS { panic!("fee too high"); }
    env.storage().instance().set(&DataKey::FeeBps, &new_bps);
}

pub fn fee_bps(env: Env) -> u32 {
    env.storage().instance().get(&DataKey::FeeBps).unwrap()
}
```

**Step 3: Run** — 8 passed.

**Step 4: Commit**

```bash
git commit -am "feat(agentic-commerce): add admin treasury + fee setters with 5% cap"
```

---

### Task 2.7: Build commerce contract WASM

Run:

```bash
cargo build -p agentic-commerce --target wasm32v1-none --release
stellar contract optimize --wasm target/wasm32v1-none/release/agentic_commerce.wasm
```

Expected: both WASM files produced under 50 KB.

No commit (target/ is ignored).

---

## Phase 3: Testnet Deployment

### Task 3.1: Configure stellar CLI identity

**Step 1: Create identity**

Run:

```bash
stellar keys generate deployer --network testnet --fund
```

Expected: prints a public key `G...`. Fund from friendbot happens automatically via `--fund`.

**Step 2: Verify**

Run: `stellar keys address deployer`
Record the output in your notes — you'll need it for the treasury address too (same key is fine for the demo).

---

### Task 3.2: Populate deploy script

**File:** `scripts/deploy-testnet.sh`

Replace the skeleton with:

```bash
#!/usr/bin/env bash
set -euo pipefail

NETWORK="testnet"
IDENTITY="deployer"
OUT_DIR="deployments"
OUT_FILE="$OUT_DIR/testnet.json"

mkdir -p "$OUT_DIR"

echo "==> Building contracts"
cargo build --target wasm32v1-none --release

IDENTITY_WASM="target/wasm32v1-none/release/agent_identity.wasm"
COMMERCE_WASM="target/wasm32v1-none/release/agentic_commerce.wasm"

echo "==> Optimizing"
stellar contract optimize --wasm "$IDENTITY_WASM"
stellar contract optimize --wasm "$COMMERCE_WASM"

IDENTITY_OPT="${IDENTITY_WASM%.wasm}.optimized.wasm"
COMMERCE_OPT="${COMMERCE_WASM%.wasm}.optimized.wasm"

echo "==> Deploying agent_identity"
IDENTITY_ADDR=$(stellar contract deploy \
  --source "$IDENTITY" --network "$NETWORK" \
  --wasm "$IDENTITY_OPT")
echo "    $IDENTITY_ADDR"

echo "==> Deploying agentic_commerce"
COMMERCE_ADDR=$(stellar contract deploy \
  --source "$IDENTITY" --network "$NETWORK" \
  --wasm "$COMMERCE_OPT")
echo "    $COMMERCE_ADDR"

ADMIN=$(stellar keys address "$IDENTITY")
echo "==> Initializing agentic_commerce with admin=$ADMIN treasury=$ADMIN"
stellar contract invoke \
  --source "$IDENTITY" --network "$NETWORK" \
  --id "$COMMERCE_ADDR" \
  -- init --admin "$ADMIN" --treasury "$ADMIN"

cat > "$OUT_FILE" <<EOF
{
  "network": "testnet",
  "deployer": "$ADMIN",
  "agent_identity": "$IDENTITY_ADDR",
  "agentic_commerce": "$COMMERCE_ADDR",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "==> Wrote $OUT_FILE"
```

**Step 2: Run**

Run: `./scripts/deploy-testnet.sh`
Expected: two contract addresses printed, `deployments/testnet.json` created.

**Step 3: Commit the script (not the json)**

```bash
git add scripts/deploy-testnet.sh
git commit -m "chore: implement deploy-testnet.sh"
```

---

## Phase 4: SDK Implementation

### Task 4.1: `src/types.ts`

**File:** `sdk/src/types.ts`

```ts
export type Address = string;

export interface Agent {
  id: bigint;
  owner: Address;
  uri: string;
}

export enum JobStatus {
  Open = "Open",
  Funded = "Funded",
  Submitted = "Submitted",
  Completed = "Completed",
  Rejected = "Rejected",
  Cancelled = "Cancelled",
}

export interface Job {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  token: Address;
  budget: bigint;
  status: JobStatus;
  description: string;
  deliverable: string;
}

export interface MarcConfig {
  rpcUrl: string;
  networkPassphrase: string;
  identityContract: Address;
  commerceContract: Address;
  usdcToken: Address;
}
```

Commit: `git add sdk/src/types.ts && git commit -m "feat(sdk): add types module"`

---

### Task 4.2: `src/identity.ts` — thin contract wrapper

**File:** `sdk/src/identity.ts`

```ts
import {
  Contract,
  Keypair,
  Networks,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
  Address,
} from "@stellar/stellar-sdk";
import type { Agent, MarcConfig } from "./types.js";

export class IdentityClient {
  private server: rpc.Server;
  private contract: Contract;

  constructor(private cfg: MarcConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
    this.contract = new Contract(cfg.identityContract);
  }

  async register(owner: Keypair, uri: string): Promise<bigint> {
    const op = this.contract.call(
      "register",
      new Address(owner.publicKey()).toScVal(),
      nativeToScVal(uri, { type: "string" }),
    );
    return await this.invoke(owner, op, (v) => BigInt(scValToNative(v) as string));
  }

  async getAgent(id: bigint): Promise<Agent | null> {
    const op = this.contract.call("get_agent", nativeToScVal(id, { type: "u64" }));
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      if (!native) return null;
      return {
        id: BigInt(native.id),
        owner: native.owner,
        uri: native.uri,
      } as Agent;
    });
  }

  async agentOf(owner: string): Promise<bigint | null> {
    const op = this.contract.call("agent_of", new Address(owner).toScVal());
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      return native == null ? null : BigInt(native);
    });
  }

  // --- internals ---

  private async invoke<T>(
    signer: Keypair,
    op: xdr.Operation,
    decode: (scVal: xdr.ScVal) => T,
  ): Promise<T> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new Error(`submit failed: ${sent.errorResult}`);
    let getResp = await this.server.getTransaction(sent.hash);
    while (getResp.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await this.server.getTransaction(sent.hash);
    }
    if (getResp.status !== "SUCCESS") throw new Error(`tx failed: ${getResp.status}`);
    return decode(getResp.returnValue!);
  }

  private async simulate<T>(op: xdr.Operation, decode: (v: xdr.ScVal) => T): Promise<T> {
    // Simulate against the deployer's key (read-only); caller provides one-time key.
    const ephemeral = Keypair.random();
    const dummy = new Account(ephemeral.publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
    const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
    if (!result) throw new Error("no simulation result");
    return decode(result.retval);
  }
}

// Minimal typed imports we need from stellar-sdk's re-exported namespaces:
import { xdr, Account } from "@stellar/stellar-sdk";
```

**Note:** The `@stellar/stellar-sdk` public API for 13.x may differ slightly at the edges (e.g. `rpc.Server` vs `SorobanRpc.Server`). If TypeScript complains, check the installed version with `npm ls @stellar/stellar-sdk` and adjust imports accordingly. Do NOT rewrite the whole file — just the imports and 1-2 call sites.

**Step 2: Build**

Run: `cd sdk && npm run build`
Expected: compiles, produces `dist/identity.js` + `dist/identity.d.ts`.

**Step 3: Commit**

```bash
git add sdk/src/identity.ts
git commit -m "feat(sdk): add IdentityClient wrapper"
```

---

### Task 4.3: `src/commerce.ts` — escrow wrapper

**File:** `sdk/src/commerce.ts`

Similar shape to `identity.ts`. Methods: `createJob`, `submit`, `complete`, `cancel`, `getJob`, `feeBps`. Use the same `invoke`/`simulate` pattern (extract to a shared helper in `src/rpc.ts` if feeling fancy — but YAGNI says duplicate is fine for 48h).

Commit: `git commit -am "feat(sdk): add CommerceClient wrapper"`

---

### Task 4.4: `src/marcPaywall.ts` — re-export x402 middleware with MARC defaults

**File:** `sdk/src/marcPaywall.ts`

```ts
import { paymentMiddleware } from "x402-stellar";
import type { Request, Response, NextFunction } from "express";

export interface MarcPaywallOptions {
  payTo: string;
  price: `${number} ${"USDC" | "XLM"}`;
  network?: "stellar:testnet" | "stellar";
  description?: string;
  facilitatorUrl?: string;
}

export function marcPaywall(opts: MarcPaywallOptions) {
  const { payTo, price, network = "stellar:testnet", description, facilitatorUrl } = opts;
  return paymentMiddleware(
    payTo,
    {
      [""]: { price, network, config: { description } },
    },
    facilitatorUrl ? { url: facilitatorUrl } : undefined,
  ) as unknown as (req: Request, res: Response, next: NextFunction) => void;
}
```

**Note:** the exact `paymentMiddleware` signature depends on the `x402-stellar` version — read its `README.md` before writing this file and align to the current API. Adjust the `MarcPaywallOptions` shape only if the library demands it.

Commit: `git commit -am "feat(sdk): add marcPaywall Express middleware"`

---

### Task 4.5: `src/marcFetch.ts` — client-side auto-402

**File:** `sdk/src/marcFetch.ts`

```ts
import { wrapFetchWithPayment } from "x402-stellar";

/**
 * Wraps global fetch so 402 responses are automatically paid from the provided
 * Stellar signing callback. Use in the buyer agent demo.
 */
export function marcFetch(signer: unknown /* x402-stellar signer type */) {
  return wrapFetchWithPayment(fetch, signer as any);
}
```

Again: match the real `x402-stellar` signer type at implementation time.

Commit: `git commit -am "feat(sdk): add marcFetch auto-402 wrapper"`

---

### Task 4.6: `src/index.ts` — public surface

**File:** `sdk/src/index.ts`

```ts
export * from "./types.js";
export { IdentityClient } from "./identity.js";
export { CommerceClient } from "./commerce.js";
export { marcPaywall } from "./marcPaywall.js";
export { marcFetch } from "./marcFetch.js";

export const MARC_STELLAR_SDK_VERSION = "0.1.0";
```

Run: `cd sdk && npm run build`
Expected: clean build.

Commit: `git commit -am "feat(sdk): export public surface"`

---

## Phase 5: CLI Demo

### Task 5.1: `demo/seller-agent.ts`

**File:** `demo/seller-agent.ts`

Node script that:

1. Loads `.env`
2. Reads `../deployments/testnet.json`
3. Registers the seller identity on `agent_identity` (if not already)
4. Starts an Express server with `marcPaywall` protecting `/api/work`
5. Logs its own public key, agent id, and listening port

```ts
import "dotenv/config";
import express from "express";
import { readFileSync } from "fs";
import { Keypair } from "@stellar/stellar-sdk";
import { IdentityClient, marcPaywall, type MarcConfig } from "marc-stellar-sdk";

const deployments = JSON.parse(readFileSync("../deployments/testnet.json", "utf8"));
const cfg: MarcConfig = {
  rpcUrl: process.env.STELLAR_RPC_URL!,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE!,
  identityContract: deployments.agent_identity,
  commerceContract: deployments.agentic_commerce,
  usdcToken: process.env.USDC_TOKEN_CONTRACT!,
};

const seller = Keypair.fromSecret(process.env.SELLER_SECRET!);
console.log("Seller:", seller.publicKey());

const identity = new IdentityClient(cfg);
let agentId = await identity.agentOf(seller.publicKey());
if (!agentId) {
  agentId = await identity.register(seller, "ipfs://seller-metadata.json");
  console.log("Registered as agent", agentId);
} else {
  console.log("Already registered as agent", agentId);
}

const app = express();
app.use(
  marcPaywall({
    payTo: seller.publicKey(),
    price: "0.01 USDC",
    network: "stellar:testnet",
    description: "One MARC-protected worker call",
    facilitatorUrl: process.env.X402_FACILITATOR_URL,
  }),
);
app.get("/api/work", (_req, res) => {
  res.json({ result: "Generated report #" + Date.now(), seller: seller.publicKey() });
});

const port = Number(process.env.SELLER_PORT ?? 4402);
app.listen(port, () => console.log(`Seller listening on :${port}`));
```

Commit: `git commit -am "feat(demo): add seller-agent script"`

---

### Task 5.2: `demo/buyer-agent.ts`

**File:** `demo/buyer-agent.ts`

Script that:

1. Registers the buyer identity
2. Creates a job with a 10 USDC budget
3. Hits the seller's `/api/work` endpoint N times via `marcFetch` (so x402 micropayments fire)
4. Calls `submit` on behalf of the seller (for demo simplicity — in real life the seller does this)
5. Calls `complete` as the buyer → 99/1 split fires

Keep it under 120 lines. Hardcode N=3 calls. Print every state transition with a timestamp so the recording is easy to follow.

Commit: `git commit -am "feat(demo): add buyer-agent script"`

---

### Task 5.3: `demo/lifecycle.ts` — one-shot orchestrator

Spawns `seller-agent` as a subprocess, waits 3 seconds, then runs buyer-agent inline. Kills seller when buyer finishes. Exits 0 on success.

Commit: `git commit -am "feat(demo): add lifecycle orchestrator"`

---

### Task 5.4: Dry run on testnet

Run:

```bash
cd demo && npm install && npm run lifecycle
```

Expected output (approximate):

```
Seller: G...
Registered as agent 1
Seller listening on :4402
Buyer: G...
Registered as agent 2
Job created: id=1 budget=10000000
x402 payment settled (1/3): txHash=...
x402 payment settled (2/3): txHash=...
x402 payment settled (3/3): txHash=...
Submitted: ipfs://work.json
Completed: paid seller 9900000, treasury 100000
DONE
```

If anything fails, fix it before moving on. This is the critical integration gate.

Commit any fixes: `git commit -am "fix(demo): <what you fixed>"`

---

## Phase 6: Landing Page

### Task 6.1: `landing/index.html`

**File:** `landing/index.html`

Structure per `docs/design-system.md`:

1. Nav bar (72px, sticky)
2. Hero section (full viewport, orange wireframe geodesic sphere SVG inline, two-line headline, two pill CTAs)
3. Protocol stack section (3 cards: Agentic Commerce, Agent Identity, x402 + MPP Integration)
4. How it works section (4 numbered steps)
5. Deployed contracts section (reads addresses from a plain `<dl>`; hand-paste from `deployments/testnet.json`)
6. Footer

Use semantic HTML (`<nav>`, `<section>`, `<main>`, `<footer>`). Inline the geodesic sphere SVG (grab one from a public-domain source or hand-roll 3 concentric ellipses). Use Lucide icons via `<script src="https://unpkg.com/lucide@latest">`. Use Inter via Google Fonts preconnect.

**Copy exactly per `docs/design-system.md` copy pivots table.** No "privacy layer" language anywhere.

---

### Task 6.2: `landing/style.css`

**File:** `landing/style.css`

Implement every token from `docs/design-system.md` as a CSS custom property at `:root`. Then style each section. Target: ~300 lines of CSS. Use `clamp()` for responsive typography. Mobile breakpoint at 768px.

---

### Task 6.3: `landing/app.js`

**File:** `landing/app.js`

Minimal vanilla JS:

- Intersection observer for section fade-in
- Copy-to-clipboard on contract address click
- Nav underline follows active section on scroll

~60 lines. No bundler, no transpilation.

---

### Task 6.4: Deploy landing to Vercel

Step 1: `cd landing && npx vercel --prod`
Step 2: Record the URL; paste into README and submission form.
Step 3: Commit landing/:

```bash
git add landing/
git commit -m "feat(landing): static marketing site matching marcprotocol.com identity"
```

---

## Phase 7: Submission Materials

### Task 7.1: Top-level `README.md`

One page. Sections: What is this, Contracts on testnet (addresses), Run the demo, Architecture diagram (ASCII), Links (landing URL, pitch video, design spec).

Commit: `git commit -am "docs: add top-level README"`

### Task 7.2: `docs/LIGHTPAPER.md`

One-page pitch doc: problem → solution → architecture → why Stellar → what we built.

Commit: `git commit -am "docs: add LIGHTPAPER"`

### Task 7.3: `docs/PROTOCOL.md`

2-page technical doc: contract APIs, state machines, events, fee math, x402 integration points.

Commit: `git commit -am "docs: add PROTOCOL reference"`

### Task 7.4: Record pitch video

1. Open terminal split: left=`demo && npm run lifecycle`, right=landing page in Arc
2. Start screen capture (QuickTime)
3. 30s pitch: "MARC on Stellar adds a commerce layer on top of x402..."
4. 60s demo: run lifecycle, narrate each state transition
5. 30s outro: show landing page + GitHub link + call to action
6. Export as `marc-stellar-pitch.mp4`
7. Upload to YouTube unlisted; save the URL

### Task 7.5: DoraHacks submission

Fill the form:

- Project name: MARC on Stellar
- Tagline: "The commerce layer for agent payments."
- Repo: https://github.com/<user>/marc-stellar
- Video: <YouTube URL>
- Landing: <Vercel URL>
- Testnet contracts: from `deployments/testnet.json`
- Team: <name>

### Task 7.6: Final commit + tag

```bash
git add .
git commit -m "chore: submission-ready state for Stellar Agents hackathon"
git tag v0.1.0-hackathon
```

---

## Success Checklist

- [ ] `cargo test --workspace` is green
- [ ] Both contracts deployed to testnet; addresses in `deployments/testnet.json`
- [ ] `cd demo && npm run lifecycle` runs end-to-end against testnet without manual intervention
- [ ] Landing page live on Vercel, correct copy (no "privacy layer" mentions)
- [ ] README links to landing, video, and design spec
- [ ] Pitch video ≤ 2:30, shows the lifecycle running
- [ ] DoraHacks submission form filled and submitted
- [ ] Git tag `v0.1.0-hackathon` pushed

---

## Cut-Earlier Order (if you fall behind)

If Day 2 is tight, cut in this order (easiest → hardest sacrifice):

1. Dark mode toggle (never started)
2. Orange particle background animation
3. How-it-works section on landing
4. `docs/PROTOCOL.md` (reference only — lightpaper is enough)
5. `cancel` entry point and its tests (only if you literally cannot get it to compile)
6. Landing page entirely — ship just the README and the video

Never cut: both contracts, the CLI demo, the video, the README.
