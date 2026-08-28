# Contributing to Bear Protocol

Thank you for contributing to Bear — the commerce layer for AI agent payments on Stellar. This guide ensures quality, consistency, and traceability across the project.

## Table of Contents

1. [Commit Message Format](#commit-message-format)
2. [Test-Driven Development (TDD)](#test-driven-development-tdd)
3. [Running Tests](#running-tests)
4. [CLAUDE.md Update Protocol](#claudemd-update-protocol)
5. [Self-Audit Checklist](#self-audit-checklist)
6. [Workflow](#workflow)

---

## Commit Message Format

Bear uses **Conventional Commits** for clarity and automation. All commits must follow this format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type (required)

Must be one of:

- **`feat:`** A new feature or capability
- **`fix:`** A bug fix
- **`test:`** Adding or updating tests (no production code changes)
- **`docs:`** Documentation only (READMEs, comments, guides)
- **`chore:`** Tooling, dependency updates, build scripts (no feature or fix)
- **`style:`** Code formatting, linting, or aesthetics (no logic changes)
- **`refactor:`** Code reorganization (no feature or bug fix)

### Scope (optional but recommended)

Narrow scope to a specific component:

- `identity` → `agent-identity` contract
- `commerce` → `agentic-commerce` contract
- `sdk` → TypeScript SDK (`marc-stellar-sdk`)
- `dashboard` → Web dashboard
- `demo` → Demo agents or orchestration
- `landing` → Landing page
- `infra` → CI/CD, deployment, scripts

### Subject Line (required)

- Imperative mood: "add register() entry point" not "adds" or "added"
- No period at the end
- Max 50 characters
- Lowercase (except proper nouns like "USDC", "Stellar")

### Body (optional, but highly encouraged)

Provide context and rationale:

- Wrap at 72 characters
- Explain _why_, not _what_ (code explains what)
- Reference issues: `Resolves #123` or `Fixes #456`
- Call out breaking changes with a `BREAKING CHANGE:` prefix

### Footer (optional)

For issue tracking:

```
Resolves #123
Co-authored-by: Name <email>
```

### Examples

```
feat(identity): add update_uri entry point

Allow agents to update their metadata URI without re-registering.
Validates owner via require_auth() and emits UriUpdated event.

Resolves #45
```

```
test(commerce): add event payload assertions for JobCompleted

Events now include payout and fee amounts. Assert exact struct
fields using to_xdr() comparison to catch payload regressions.

Resolves #362
```

```
fix(commerce): guard create_job against double-init

create_job() silently succeeded before init() was called,
bypassing fee bps and admin validation. Now panics with
"not initialized" until admin calls init().

Resolves #363
```

---

## Test-Driven Development (TDD)

Quality over speed. Every feature and fix follows this cycle:

### 1. Write the Test First

Before touching production code, write a test that _fails_:

```rust
#[test]
fn test_register_new_agent_increments_id() {
    let env = Env::default();
    let contract_id = env.register_contract(None, AgentIdentityContract);
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let metadata_uri = "https://ipfs.example/agent1.json";

    // This test should fail until register() is implemented
    let id1 = client.register(&alice, metadata_uri);
    assert_eq!(id1, 1);
}
```

### 2. Run the Test → Verify It Fails

```bash
cargo test test_register_new_agent_increments_id
```

You should see:

```
error[E0425]: cannot find function `register` in this scope
```

or similar. The test must fail **before** you implement the feature.

### 3. Implement the Minimum to Pass

Write only what's needed to pass the test. Don't add extra features or error handling yet:

```rust
#[contractimpl]
impl AgentIdentityContract {
    pub fn register(env: Env, agent: Address, metadata_uri: String) -> u64 {
        let next_id: u64 = env.storage().instance().get(&Symbol::new(&env, "next_id")).unwrap_or(1);
        env.storage().instance().set(&Symbol::new(&env, "next_id"), &(next_id + 1));
        next_id
    }
}
```

### 4. Run the Test → Verify It Passes

```bash
cargo test test_register_new_agent_increments_id
```

You should see:

```
test test_register_new_agent_increments_id ... ok
```

### 5. Add Error Cases & Edge Cases

Now add tests for rejection and validation:

```rust
#[test]
#[should_panic(expected = "already registered")]
fn test_register_rejects_duplicate_agent() {
    // ...
}

#[test]
fn test_register_requires_auth() {
    // ...
}
```

### 6. Refactor & Verify

Once all tests pass, refactor for clarity and maintainability. Re-run tests after each change:

```bash
cargo test
```

---

## Running Tests

### Rust Tests (Soroban Contracts)

Run all tests in the workspace:

```bash
cargo test
```

Run tests for a specific contract:

```bash
cargo test --package agent-identity
cargo test --package agentic-commerce
```

Run a single test:

```bash
cargo test test_register_new_agent_increments_id -- --exact
```

Run tests with output (even on success):

```bash
cargo test -- --nocapture
```

### TypeScript Tests (SDK, Dashboard)

Per workspace:

```bash
# SDK
npm test --workspace ./sdk

# Dashboard
npm test --workspace ./dashboard

# Demo
npm test --workspace ./demo
```

If a package doesn't have tests defined yet, add a placeholder:

```json
{
  "scripts": {
    "test": "echo 'No tests defined'"
  }
}
```

### Coverage (Optional but Encouraged)

For Rust contracts, use `cargo tarpaulin` (requires `cargo install cargo-tarpaulin`):

```bash
cargo tarpaulin --workspace --out Html --output-dir coverage
```

For TypeScript:

```bash
npm test --workspace ./sdk -- --coverage
```

### CI Verification

Before pushing, verify both Rust and TypeScript checks pass locally:

```bash
cargo test
cargo clippy -- -D warnings
cargo fmt --check
```

---

## CLAUDE.md Update Protocol

**CLAUDE.md is the project memory for AI-assisted work.** After every task, update it so future sessions don't re-learn the same lessons. This is mandatory.

### When to Update CLAUDE.md

Update it at the end of:

- Every feature/fix/refactor that touches code
- Every time you discover a gotcha or learn something about the toolchain
- After every deployment or environment change
- After every incident or blocker you resolve

### What to Update

#### Section: "What's done"

Add a row to the table with:

- **Date:** Today's date (YYYY-MM-DD format)
- **Task:** Brief name of the work (e.g., "Phase 1.2: register + get_agent")
- **Outcome:** ✅ if complete, ⚠️ if blocked, 🔄 if ongoing
- **Notes:** Key learnings, gotchas, decisions, plan deviations

Example:

```markdown
| 2026-07-29 | docs: add CONTRIBUTING.md | ✅ | Covers TDD, commit format, CLAUDE.md protocol. All sections tested against current toolchain. |
```

#### Section: "Gotchas learned"

Append any new gotcha (surprise or lesson) you discovered:

```markdown
- `soroban-sdk` 27.x removes `Vec` from the auto-glob — must `use soroban_sdk::Vec;` explicitly in lib.rs.
```

#### Section: "Open risks / things to verify"

If you've verified a risk is now closed, mark it **CLOSED** with its resolution.

If you hit a new risk, add it under "Open risks" so future work knows to investigate.

### Self-Audit Before Writing CLAUDE.md

Use the self-audit checklist (below) before updating CLAUDE.md. Once you pass audit, update it immediately — do NOT defer.

---

## Self-Audit Checklist

Before committing ANY task, verify all of the following:

- [ ] **Does the diff only touch files listed in the current task's scope?** If you touched unrelated files, either remove those changes or document why they're necessary in CLAUDE.md notes.

- [ ] **Did I write the test FIRST and see it fail?** (TDD requirement.) If this is a docs/chore task, skip this, but still run tests to verify nothing broke.

- [ ] **Did I run the test after implementing and see it pass?** Run the full test suite (`cargo test` or `npm test`) to confirm no regressions.

- [ ] **Are there any `panic!()` messages without matching `#[should_panic]` tests?** Every panic path must have a test that verifies the panic happens with the expected message.

- [ ] **Are there any unused imports?** Run `cargo clippy` or `npx eslint` to catch them.

- [ ] **Did I cross-check the API against the docs?** For new Soroban SDK usage, verify against official docs or the source (`~/.cargo/registry/src/.../soroban-sdk-27.x.x/src/`).

- [ ] **Is the commit message conventional and accurate?** Follow the format above. If you're unsure, it's probably not descriptive enough — add more detail to the body.

- [ ] **Did I update CLAUDE.md's "What's done" section?** Record the outcome, date, and any gotchas. This is mandatory.

---

## Workflow

### For Feature Work

1. Create a branch: `git checkout -b feat/my-feature`
2. Write a test that fails
3. Implement the feature to make it pass
4. Add edge case / error tests
5. Run full test suite: `cargo test`
6. Update CLAUDE.md: add a row to "What's done" with outcome ✅
7. Commit: `git commit -m "feat(scope): description"` (conventional format)
8. Create a pull request (do NOT push directly to main)

### For Bug Fixes

1. Create a branch: `git checkout -b fix/my-bug`
2. Write a test that reproduces the bug (and fails)
3. Fix the bug to make the test pass
4. Run full test suite: `cargo test`
5. Update CLAUDE.md: add a row with outcome ✅, link the issue
6. Commit: `git commit -m "fix(scope): description\n\nResolves #123"`
7. Create a pull request

### For Docs / Chore

1. Create a branch: `git checkout -b docs/my-doc` or `git checkout -b chore/my-task`
2. Make the changes
3. Run `cargo fmt` and `cargo clippy` to catch style issues
4. Update CLAUDE.md (if applicable)
5. Commit: `git commit -m "docs(scope): description"` or `git commit -m "chore(scope): description"`
6. Create a pull request

### Pull Request Guidelines

- **Title:** Keep under 70 characters, use conventional format. Example: `feat(identity): add update_uri entry point`
- **Description:** Include a summary of changes, what was tested, and any blocked features or follow-ups.
- **Do NOT push to main directly.** All work goes through pull requests.
- **Avoid force pushes (`git push --force`).** Prefer normal commits to preserve history.
- **Do NOT amend or rebase published commits.** If you need to fix a commit, make a new commit instead.

### Pre-Commit Checklist

Before pushing any branch, run:

```bash
# Rust
cargo test
cargo clippy -- -D warnings
cargo fmt --check

# TypeScript (if modified)
npm test --workspace ./sdk
npm run lint --workspace ./sdk
npm run format --workspace ./sdk
```

---

## Getting Help

- **Toolchain issues?** Check `CLAUDE.md` "Gotchas learned" section — your issue is probably documented there.
- **Stellar/Soroban questions?** See the Emergency Contacts in `CLAUDE.md` or visit https://developers.stellar.org/docs/build
- **Design questions?** Read `ROADMAP.md` and `docs/superpowers/specs/` for architecture context.
- **Stuck on a test?** Check the test examples in `contracts/*/src/test.rs` — they follow the pattern this guide describes.

---

## Code of Conduct

- Be respectful and collaborative
- Assume good intent
- Ask for help early and often
- Share what you learn with the team
- Update CLAUDE.md for future contributors

Thank you for making Bear better! 🐻
