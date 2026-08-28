# MARC on Stellar — Roadmap

Single-page status tracker. **If you're a Claude agent picking up this project, read this file first** — then `CLAUDE.md` for rules/gotchas, then `docs/plans/2026-04-11-marc-stellar.md` for the full step-by-step.

**Goal:** Ship MARC (commerce layer for agent payments) on Stellar testnet in 48h. Two Soroban contracts + TS SDK + CLI demo + landing page.
**Deadline:** 2026-04-11 + 48h.
**Hackathon:** Stellar Hacks: Agents (x402 × Stripe MPP).

---

## Current state

**Phase:** 7 (Submission Materials)
**Last completed:** Phase 6 — Landing page shipped at `landing/index.html` with hero, protocol stack, how-it-works, contract addresses, SDK snippets, i18n, consent banner, and Vercel deploy config ✅
**Next action:** Phase 7 Task 7.1 — finalize README for submission

**Deployed contracts (testnet):**

- `agent_identity` = `CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5`
- `agentic_commerce` = `CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE`
- `deployer` = `GA5VIZYCUM3IUZZNQTTB7YSLJSE5WZ2EI5EGWNLTWQ234SLSH45MPKX3`

---

## Phase tracker

| #     | Phase                       | Status      | Tasks   | Notes                                                                                                                                      |
| ----- | --------------------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Workspace scaffolding       | ✅ done     | 3/3     | Rust workspace + SDK + demo + landing + scripts                                                                                            |
| 1     | `agent_identity` contract   | ✅ done     | 5/5     | 7 tests green, 4.2 KB WASM, 6 entry points                                                                                                 |
| 2     | `agentic_commerce` contract | ✅ done     | 7/7     | 12 tests green, 9.4 KB WASM, 10 entry points, 99/1 fee split verified                                                                      |
| 3     | Testnet deployment          | ✅ done     | 3/3     | Both contracts live, init invoked, fee_bps=100 verified                                                                                    |
| 4     | TypeScript SDK              | ✅ done     | 6/6     | types, IdentityClient, CommerceClient, marcPaywall, marcFetch, index — all compiled, runtime verified                                      |
| 5     | CLI demo                    | ✅ done     | 4/4     | seller-agent, buyer-agent, lifecycle orchestrator, testnet dry run — job #1 completed, 99/1 split verified                                 |
| **6** | **Landing page**            | ✅ **done** | **4/4** | HTML + CSS + JS + Vercel deploy — `landing/index.html` shipped with full protocol stack, contracts, SDK snippets, i18n, and consent banner |
| 7     | Submission materials        | ⬜ todo     | 0/6     | README, LIGHTPAPER, PROTOCOL, pitch video, DoraHacks form, git tag                                                                         |

---

## Phase 2 task breakdown (what we're doing right now)

| #   | Task                                                    | State | Green criteria                                           |
| --- | ------------------------------------------------------- | ----- | -------------------------------------------------------- |
| 2.1 | Scaffold `agentic-commerce` crate + `init` + smoke test | ✅    | 2 tests: init sets state, double-init panics             |
| 2.2 | `create_job` with token escrow pull                     | ✅    | Budget moves buyer → contract; status = Funded           |
| 2.3 | `submit` (provider-only guard)                          | ✅    | 2 tests: happy + non-provider panic                      |
| 2.4 | `complete` with 99/1 fee split                          | ✅    | Seller 99k, treasury 1k, contract 0                      |
| 2.5 | `cancel` refund path                                    | ✅    | Full budget back to buyer, status = Cancelled            |
| 2.6 | `set_treasury` + `set_fee_bps` (admin, 5% cap)          | ✅    | 3 tests: admin update + 501 bps panic + non-admin reject |
| 2.7 | Build release WASM + optimize                           | ✅    | 9387 B, 10 entry points, clippy clean                    |

**Actual:** 12 tests green, WASM 9.4 KB, zero clippy warnings. ✅

---

## Downstream dependencies (what each phase unlocks)

```
Phase 0 (scaffold)
  └─> Phase 1 (agent_identity) ✅
       └─> Phase 2 (agentic_commerce) 🚧
            ├─> Phase 3 (deploy both contracts)
            │    └─> Phase 4 (SDK wrappers — needs deployed addresses)
            │         └─> Phase 5 (CLI demo — needs SDK + deployed addresses)
            │              └─> Phase 7.4 (pitch video — films the demo)
            └─> Phase 6 (landing page — independent, can run parallel)
                 └─> Phase 7.1-.3 (README + lightpaper — references everything)
                      └─> Phase 7.5-.6 (DoraHacks submit + git tag)
```

**Critical path:** 2 → 3 → 4 → 5 → 7.4. If any of these breaks, we have no demo to ship.

---

## Cut list (if we fall behind, in order)

1. Dark mode toggle (never started)
2. Orange particle background animation
3. How-it-works section on landing
4. `docs/PROTOCOL.md` (reference only — lightpaper is enough)
5. `cancel` entry point + its test (only if literally cannot compile)
6. Landing page entirely — ship just README + video

**Never cut:** both contracts, the CLI demo, the pitch video, the README.

---

## Where to find things

- **Operating rules + gotchas:** `CLAUDE.md` (auto-loaded into Claude context every session)
- **Full step-by-step plan:** `docs/plans/2026-04-11-marc-stellar.md`
- **Locked scope + contract designs:** `docs/superpowers/specs/2026-04-11-marc-stellar-design.md`
- **Visual design tokens + landing specs:** `docs/design-system.md`
- **Hackathon resources (x402, MPP, Soroban):** `.claude/skills/stellar-hackathon/SKILL.md`
- **Original MARC Solidity (shape reference only, don't copy):** `/Users/ram/Desktop/marc/contracts/`

---

## Update protocol

After every task completes:

1. Check the box in the "Phase task breakdown" table above
2. Bump "Last completed" and "Next action" at the top
3. When a whole phase finishes, flip its row to ✅ and move to the next phase row
4. Commit the ROADMAP.md change alongside the task's feature commit (or as a separate `docs: roadmap` commit)
