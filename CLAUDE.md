# CLAUDE.md — marc-stellar project memory

This file is auto-loaded into Claude Code's context every session for this project. Treat it as ground truth. Update it after every task so future sessions don't re-learn the same lessons.

## Project in one sentence

MARC on Stellar — a commerce layer for agent payments (job escrow + agent identity) built on Soroban, sitting on top of the existing Stellar x402/MPP payment rails. Hackathon submission for Stellar Hacks: Agents (x402 × Stripe MPP). 48-hour deadline starting 2026-04-11.

## Source of truth documents (read in this order before any work)

0. **`ROADMAP.md`** — ⭐ single-page "where are we, what's next" status tracker. Always read first.
1. `docs/superpowers/specs/2026-04-11-marc-stellar-design.md` — **LOCKED** scope, contract designs, architecture
2. `docs/plans/2026-04-11-marc-stellar.md` — bite-sized TDD implementation plan
3. `docs/design-system.md` — visual tokens + landing page component specs
4. `.claude/skills/stellar-hackathon/SKILL.md` — curated hackathon resources (x402, MPP, Soroban, tools)

If anything in this file contradicts those docs, those docs win.

## Operating rules (this session)

1. **Quality over speed.** We are NOT rushing. Each task gets full TDD, self-audit, and commit. If a shortcut would save 10 minutes but skip a test, we take the 10 minutes.
2. **TDD for every contract entry point.** Failing test → run it to see it fail → implement → run it to see it pass → commit. No exceptions.
3. **Self-audit after every task.** Before committing, re-read the diff, re-read relevant CLAUDE.md sections, re-read the task definition in the plan, verify nothing was hallucinated or skipped.
4. **Audit previous sections before starting new ones.** Phase N+1 begins with a 60-second review of the "What's done" section of this file to catch drift.
5. **Update this file after every task.** Record what changed, what gotchas were hit, what decisions were made.
6. **No scope creep.** If a task surfaces work not in the plan, STOP and flag it — do not silently add it.
7. **Commit after every green test.** Linear history via normal commits. No rebases, no force pushes, no amends.

## Toolchain (verified 2026-04-11)

- Rust 1.92.0 (stable)
- Cargo 1.92.0
- stellar CLI 25.2.0 (Homebrew)
- Node.js 25.2.1, npm 11.7.0
- Rust target: `wasm32v1-none` (installed; `wasm32-unknown-unknown` is deprecated for Soroban 25+)

## Locked dependency versions (DO NOT bump without re-testing)

| Dependency | Version | Why |
|---|---|---|
| `soroban-sdk` | `25.3.1` | Matches stellar-cli 25.x major. SDK 26.0.0 is 2 days old and unverified against our CLI. |
| `@stellar/stellar-sdk` | `^14.6.1` | Upgraded from 12.x — protocol 25 requires 14.x+ XDR. x402-stellar's `^12.0.0` peer dep is type-only (no runtime import), so the violation is safe. |
| `x402-stellar` | `^0.2.0` | Latest on npm. Peer-deps `@stellar/stellar-sdk@^12.0.0`. Only 2 published versions (0.1.0, 0.2.0). |
| `express` | `^4.19.0` | Peer of `x402-stellar` paywall. |
| `typescript` | `^5.6.0` | |

**If a version needs changing, update this table AND the plan AND the affected Cargo.toml/package.json.**

## Project conventions

- Contract crate names: `agent-identity`, `agentic-commerce` (kebab in Cargo.toml, snake in WASM filenames)
- Contract struct name: `AgentIdentityContract`, `AgenticCommerceContract`
- All state-changing entry points MUST call `caller.require_auth()` on the authorizing address
- Use `env.storage().persistent()` for job/agent state, `env.storage().instance()` for singletons (admin, treasury, next_id, fee_bps)
- Events: topic is `(Symbol::new(&env, "name"), actor_address)`, data is a tuple
- Tests: `env.mock_all_auths()` in every test; use `Address::generate(&env)` for fresh addresses
- SDK file layout: one class per contract (`IdentityClient`, `CommerceClient`), shared `types.ts`, `marcPaywall.ts` + `marcFetch.ts` wrap `x402-stellar`
- Commit messages: conventional commits (`feat:`, `test:`, `chore:`, `docs:`, `fix:`)

## Self-audit checklist (run before committing any task)

1. [ ] Does the diff only touch files listed in the current task's `Files:` section?
2. [ ] Did I write the test FIRST and see it fail?
3. [ ] Did I run the test after implementing and see it pass?
4. [ ] Are there any `panic!()` messages in the code that don't have matching `should_panic(expected = ...)` tests?
5. [ ] Are there any imports that are not used?
6. [ ] Did I cross-check the Soroban API against `~/.cargo/registry/src/.../soroban-sdk-25.3.1/src/` if the code is doing something I haven't done before?
7. [ ] Is the commit message conventional and accurate?
8. [ ] Did I update CLAUDE.md's "What's done" section with this task's outcome?

## What's done

| Date | Task | Outcome | Notes |
|---|---|---|---|
| 2026-04-11 | Scaffolding: hackathon skill, design spec, design system, impl plan, CLAUDE.md | ✅ | All 5 committed. |
| 2026-04-11 | Phase 0.1: Cargo workspace root | ✅ | `Cargo.toml` + `rust-toolchain.toml` + `.gitignore` + `deployments/.gitkeep`. Workspace parses (`cargo metadata` clean). **Plan drift:** members list is empty for now — each phase adds its own crate to the list when scaffolding it. Plan section 0.1 step 1 shows members populated upfront, but that fails `cargo metadata` because the crates don't exist yet. Fixed in-place and documented. |
| 2026-04-11 | Phase 0.2: SDK package scaffold | ✅ | `sdk/package.json` + `tsconfig.json` + `src/index.ts` stub + `README.md`. `npm install` clean (125 pkgs, 0 vulns). `npx tsc --noEmit` clean. **Plan drift:** `@stellar/stellar-sdk` pinned to `^12.3.0` (not ^13) because `x402-stellar@0.2.0` requires peer `^12.0.0`. Latest stellar-sdk is 15.0.1 but we can't use it. Phase 4 SDK code must target stellar-sdk 12.x API (`SorobanRpc.Server`, not `rpc.Server`). |
| 2026-04-11 | Phase 0.3: Demo + landing + scripts | ✅ | `demo/package.json` (with `marc-stellar-sdk` as file: dep) + `tsconfig.json` + `.env.example`, `landing/.gitkeep`, `scripts/build.sh` + `scripts/deploy-testnet.sh` (skeleton, exit 1). Both scripts chmod +x. Demo also pinned to stellar-sdk ^12.3.0. npm install deferred until Phase 5 so we're not carrying duplicate node_modules. |
| 2026-04-11 | Phase 1.1: agent-identity scaffold + smoke test | ✅ | `contracts/agent-identity/{Cargo.toml,src/lib.rs,src/test.rs}`, added to workspace members. Smoke test uses `env.register(Contract, ())` (25.x API). Needed a `version()` stub so the `#[contractimpl]` isn't empty. |
| 2026-04-11 | Phase 1.2: register + get_agent + agent_of | ✅ | TDD: failing test → impl → 2 passing. **Idiom gotcha caught:** `env.events().publish` is deprecated in 25.x; migrated to `#[contractevent]` struct macro with `#[topic]` field attribute. Events are now type-safe and included in the contract's ABI spec. |
| 2026-04-11 | Phase 1.3: update_uri (owner-only) | ✅ | 2 new tests (happy + `#[should_panic(expected = "not agent owner")]`). `UriUpdated` event. 4 total tests green. |
| 2026-04-11 | Phase 1.4: deregister | ✅ | 3 new tests: cleanup, non-owner reject, re-register-after-deregister (ids are sequential, never reused). `Deregistered` event. 7 total tests green. |
| 2026-04-11 | Phase 1.5: build release WASM + optimize | ✅ | `cargo build --target wasm32v1-none --release` → 4900 B. `stellar contract build --optimize` → 4242 B with 6 exported functions: `agent_of`, `deregister`, `get_agent`, `register`, `update_uri`, `version`. **Gotcha:** `stellar contract optimize` is deprecated; must use `build --optimize`. Updated `scripts/build.sh`. |
| 2026-04-11 | Phase 2.1: agentic-commerce scaffold + init | ✅ | `contracts/agentic-commerce/{Cargo.toml,src/lib.rs,src/test.rs}` added to workspace. `init(admin, treasury)` sets admin/treasury/FeeBps=100/NextId=1, panics on double-init. 2 tests green. |
| 2026-04-11 | Phase 2.2: create_job with token escrow | ✅ | TDD. Used `env.register_stellar_asset_contract_v2(admin)` + `StellarAssetClient::mint` + `TokenClient::transfer` from `soroban_sdk::token`. Plan used deprecated alias `token::Client`; switched to `token::TokenClient`. Plan used deprecated `env.events().publish`; migrated to `#[contractevent] JobCreated`. 3 tests green. |
| 2026-04-11 | Phase 2.3: submit (provider-only) | ✅ | 2 new tests (happy + `#[should_panic(expected = "not provider")]`). `JobSubmitted` event. 5 total. |
| 2026-04-11 | Phase 2.4: complete with 99/1 fee split | ✅ | Math: `fee = budget * fee_bps / 10_000`, `payout = budget - fee`. 2 new tests verify 99k/1k/0 balances + non-evaluator reject. `JobCompleted` event carries payout + fee. 7 total. |
| 2026-04-11 | Phase 2.5: cancel refund path | ✅ | Only allowed while `Funded`. Returns full budget to client. 2 new tests (happy + non-client reject). `JobCancelled` event. 9 total. |
| 2026-04-11 | Phase 2.6: admin setters + 5% cap | ✅ | `set_treasury`, `set_fee_bps`, `fee_bps` getter. Hard cap `MAX_FEE_BPS=500`. 3 new tests: admin happy-path, 501 bps panic, non-admin reject. 12 total. |
| 2026-04-11 | Phase 2.7: build release WASM + optimize | ✅ | `stellar contract build --optimize` → `agentic_commerce.wasm` 9387 B (vs 50 KB budget = 19%), 10 exported functions: `cancel`, `complete`, `create_job`, `fee_bps`, `get_job`, `init`, `set_fee_bps`, `set_treasury`, `submit`, `version`. Both contracts built clean. |
| 2026-04-11 | Phase 2 polish: clippy clean | ✅ | Clippy flagged `needless_borrows_for_generic_args` on `&env.current_contract_address()` in 4 callsites (token transfers). Fixed by hoisting to a local `let contract_addr = env.current_contract_address();` and borrowing that. Workspace clippy `-D warnings` green. 12/12 tests still green after refactor. |
| 2026-04-11 | Phase 3.0: deploy script rewrite | ✅ | Plan's script was written against deprecated `stellar contract optimize` + `.optimized.wasm` naming. Rewrote to use `stellar contract build --optimize` (in-place) + `--source-account` flag. `bash -n` clean. |
| 2026-04-11 | Phase 3.1: deployer identity + friendbot fund | ✅ | `stellar keys generate deployer --network testnet --fund` saved key to `~/.config/stellar/identity/deployer.toml`. Address: `GA5VIZYCUM3IUZZNQTTB7YSLJSE5WZ2EI5EGWNLTWQ234SLSH45MPKX3`. |
| 2026-04-11 | Phase 3.2: testnet deploy + init | ✅ | `./scripts/deploy-testnet.sh` uploaded 2 WASMs, deployed 2 contracts, invoked `init`. Addresses: `agent_identity = CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5`, `agentic_commerce = CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE`. Written to `deployments/testnet.json` (gitignored). |
| 2026-04-11 | Phase 3 sanity: live invoke | ✅ | `fee_bps()` on commerce returns `100` (1%) proving init ran. `version()` returns `1` on both contracts. Read-only invokes only simulate; 25.x CLI prints `Simulation identified as read-only. Send by rerunning with --send=yes` before the result — the result is still printed. |
| 2026-04-11 | Phase 4.1: sdk/src/types.ts | ✅ | `Address`, `Agent`, `Job`, `JobStatus`, `MarcConfig` mirroring on-chain structs. `bigint` for `u64`/`i128`. `TESTNET` preset with deployed addresses + `usdcToken` from x402-stellar's `STELLAR_TOKENS["stellar-testnet"].USDC`. |
| 2026-04-12 | Phase 4.2: sdk/src/identity.ts | ✅ | `IdentityClient`: register, getAgent, agentOf, updateUri, deregister. `rpc.Server` verified identical to `SorobanRpc.Server` in 12.3.0 — plan's imports work as-is, no rename needed. |
| 2026-04-12 | Phase 4.3: sdk/src/commerce.ts | ✅ | `CommerceClient`: createJob, submit, complete, cancel, getJob, feeBps, setTreasury, setFeeBps. Same invoke/simulate pattern. ScVal encoding: i128 for budget, u64 for job IDs, u32 for fee bps. |
| 2026-04-12 | Phase 4.4: sdk/src/marcPaywall.ts | ✅ | Express middleware using x402-stellar's real `useFacilitator` API (verify+settle). **Plan drift:** plan assumed `paymentMiddleware` export which does NOT exist in x402-stellar@0.2.0. Built our own middleware from primitives. |
| 2026-04-12 | Phase 4.5: sdk/src/marcFetch.ts | ✅ | Auto-402 fetch wrapper. Detects 402, reads `X-PAYMENT-REQUIREMENTS`, builds+signs Stellar payment tx, retries with `X-PAYMENT` header. **Plan drift:** plan assumed `wrapFetchWithPayment` which doesn't exist. |
| 2026-04-12 | Phase 4.6: sdk/src/index.ts | ✅ | Barrel exports: IdentityClient, CommerceClient, marcPaywall, marcFetch, TESTNET, JobStatus, types. `npx tsc` clean, 12 dist files (6 .js + 6 .d.ts). Runtime verified via ESM import. |
| 2026-04-12 | stellar-sdk 12→14 upgrade | ✅ | 12.x and 13.x fail with "Bad union switch: 4" (protocol 25 XDR). 14.6.1 works. x402-stellar's `^12.0.0` peer dep is type-only — no runtime impact. |
| 2026-04-12 | Phase 5.1–5.3: demo scripts | ✅ | seller-agent.ts (marcPaywall on /api/work), buyer-agent.ts (marcFetch + full job lifecycle), lifecycle.ts (orchestrator spawns seller, runs buyer, exits 0). All typecheck clean. |
| 2026-04-12 | Phase 5.4: testnet dry run | ✅ | Full lifecycle completes on testnet. Job #1 created, funded (10M MUSD escrow), submitted, completed. 99/1 split verified on-chain: seller +9.9M, treasury +100K, contract 0. x402 micropayments fail (facilitator not reachable) but contract flow is fully functional. Used custom MUSD SAC (`CCWHIM2BEG5OEDNLQ5DBQE2KY5TZMVN627HQ6NLUJHWP5GQDBO5SXLBS`) since we can't mint Circle's testnet USDC. |
| 2026-06-24 | Demo and landing polish | ✅ | buyer-agent.ts now uses configurable exponential backoff via BUYER_POLL_* env vars, seller-agent.ts accepts FACILITATOR_URL/API_KEY aliases, demo/.env.example now includes the missing secrets and contract vars, and landing/index.html defers the StackBlitz embed until the Try It section scrolls into view. |

## Gotchas learned (append after each surprise)

- `wasm32-unknown-unknown` target is deprecated by stellar-cli 25.x — use `wasm32v1-none`.
- `stellar contract deploy` auto-uploads, installs, and deploys in one step (vs. older 3-step flow).
- `cargo search` can be stale — prefer `cargo info <crate>` or the crates.io JSON API for live version data.
- soroban-sdk 26.0.0 was published 2026-04-09 (2 days before this hackathon). Unverified against CLI 25.2.0. Stick with 25.3.1.
- In Soroban 22+, the testutils `env.register(Contract, ())` returns a contract ID directly — no separate `register_contract` helper needed.
- Cargo workspace `members = [...]` list must reference existing crates — can't list them upfront. Use empty list and add each member when scaffolding its crate.
- `soroban-sdk` 25.x **deprecates `env.events().publish()`** — use `#[contractevent]` struct with `#[topic]` field attrs and call `.publish(&env)` on an instance. Events are then type-safe and show up in the contract ABI spec. Plan was written for the old API; migrated in Phase 1.2.
- `soroban-sdk` 25.x **auto-generates `contracts/<crate>/test_snapshots/test/<test_name>.<n>.json`** when tests run. These are committed so test output is reproducible across runs and CI.
- `stellar contract optimize --wasm <path>` is **deprecated** in stellar-cli 25.x. Use `stellar contract build --optimize` instead — it builds, optimizes, hashes, and lists exported functions in one pass. `scripts/build.sh` uses the new command.
- An empty `#[contractimpl]` block (no entry points) is allowed to compile but gives you a client type that can't be used. Always keep at least a `version() -> u32` stub in the initial scaffold.
- Inside `#[contractimpl]` methods, the `env` argument is a normal owned `Env` (not `&Env`), and Rust's `Address` ownership rules mean you need `owner.clone()` at every callsite that reuses the same address after `require_auth()` or storage ops.
- `soroban_sdk::token::Client` is a **deprecated alias** — use `soroban_sdk::token::TokenClient` (read-only) and `soroban_sdk::token::StellarAssetClient` (admin/mint-capable) directly.
- `env.register_stellar_asset_contract_v2(admin: Address) -> StellarAssetContract` (25.x testutils) is the supported way to deploy a SAC in tests. Call `.address()` on the return value. The old `register_stellar_asset_contract` (v1) is gone.
- Clippy `-D warnings` flags `&env.current_contract_address()` as `needless_borrows_for_generic_args` because the generated token client methods take generic `IntoVal` args. Hoist to `let contract_addr = env.current_contract_address();` and borrow that instead of inlining.
- stellar-cli 25.x: `stellar contract build --optimize` writes the wasm **in place** (same filename, NO `.optimized.wasm` suffix). Plans/scripts inherited from older versions that expect a separate `.optimized.wasm` file must be rewritten.
- `stellar contract invoke` uses `--source-account` (not `--source`) as the canonical flag in 25.x. `--source` is still an alias but `--source-account` is what `--help` shows.
- Multi-line shell commands with `\` line continuations pasted into a single-line bash wrapper sometimes introduce an empty `''` arg that stellar-cli rejects as "unexpected argument ''". Inline the command on one line when shelling it out from tool calls.
- Read-only contract calls in 25.x print `Simulation identified as read-only. Send by rerunning with --send=yes` to stderr, then the result to stdout. The result IS returned — ignore the suggestion unless you actually need to write to ledger.
- `@stellar/stellar-sdk` 12.3.0 exports BOTH `rpc` and `SorobanRpc` as the same object. Code written for either 12.x or 13.x namespace works. Verified at runtime: `rpc === SorobanRpc` is `true`.
- `x402-stellar@0.2.0` does NOT export `paymentMiddleware` or `wrapFetchWithPayment` — those were hallucinated in the plan. The real API: `useFacilitator({url})` → `{verify, settle, supported, list}`, plus `encodePaymentHeader`/`decodePaymentHeader` for header encoding, and `STELLAR_TOKENS`/`STELLAR_NETWORKS` for token/network catalogs.
- `x402-stellar` is ESM-only (no CJS main). Cannot `require()` it — must use ESM `import`. Our SDK's `"type": "module"` + `"module": "NodeNext"` in tsconfig handles this correctly.
- Testnet USDC SAC address from x402-stellar: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (7 decimals).
- `@stellar/stellar-sdk` 12.x and 13.x both crash with `Bad union switch: 4` when parsing transaction results from testnet (protocol 25). Only 14.x+ has the updated XDR types. The x402-stellar `^12.0.0` peer dep is safe to violate — it's types-only at runtime.
- SAC-wrapped classic assets: `stellar tx new payment --amount N` gives N units in the SAC `balance()` call (1:1 mapping, no decimal scaling). A classic issue of 1000 = 1000 SAC units, not 10B stroops.
- To use a custom token in `agentic_commerce`: (1) `stellar tx new change-trust` for each account, (2) `stellar tx new payment` from issuer to each account, (3) `stellar contract asset deploy` to get the SAC contract address, (4) use that SAC address as the `token` param.
- Soroban contracts don't need classic trustlines to receive SAC tokens — the SAC tracks Soroban balances internally.
- x402-stellar's default facilitator URL (`facilitator.stellar-x402.org`) is unreachable. `facilitator.x402.org` is also dead. The working facilitator is **OpenZeppelin's hosted service** at `https://channels.openzeppelin.com/x402/testnet`. Requires Bearer API key auth — generate a key via `GET https://channels.openzeppelin.com/testnet/gen`. Pass `createAuthHeaders` in `FacilitatorConfig` to add the key to verify/settle/supported calls.
- The OZ facilitator only settles real USDC, not custom SAC tokens like our MUSD. x402 micropayments will return "Payment verification failed" with MUSD — the protocol flow works (402 → payment → retry) but settlement fails. This is fine for demo purposes.

## Open risks / things to verify during implementation

- ~~`register_stellar_asset_contract_v2` API signature may have changed in 25.x~~ **CLOSED:** Works as documented. Used in Phase 2.2.
- ~~`token::Client::new(&env, &token_addr)` path~~ **CLOSED:** Deprecated alias; use `token::TokenClient` directly. Fixed in Phase 2.2.
- ~~`x402-stellar`'s `paymentMiddleware` signature~~ **CLOSED:** Function doesn't exist. x402-stellar@0.2.0 exports `useFacilitator` (verify/settle), `encodePaymentHeader`/`decodePaymentHeader`, `PaymentRequirements`/`PaymentPayload` schemas, and `STELLAR_TOKENS`/`STELLAR_NETWORKS` catalogs. We built our own Express middleware + fetch wrapper from these primitives in Tasks 4.4-4.5.
- ~~`stellar-sdk` 12.x vs 13.x namespace~~ **CLOSED:** In 12.3.0, `rpc` and `SorobanRpc` are the **same object** (`rpc === SorobanRpc` is true). All plan imports (`rpc.Server`, `rpc.Api.isSimulationError`, etc.) work as-is. No rename needed.

## Emergency contacts (if totally stuck)

- Stellar Dev Skill: https://github.com/stellar/stellar-dev-skill
- Soroban docs: https://developers.stellar.org/docs/build
- stellar-cli issue tracker: https://github.com/stellar/stellar-cli/issues
- Hackathon FAQ: https://github.com/briwylde08/stellar-hackathon-faq
