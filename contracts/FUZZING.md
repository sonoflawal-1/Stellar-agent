# Fuzzing Runbook

This document describes the automated fuzzing suite for the Soroban contracts in this
repository. The suite uses [`cargo-fuzz`](https://github.com/rust-fuzz/cargo-fuzz)
(libFuzzer) to subject contract parsers and state-transition logic to millions of
randomized inputs, catching panics, memory issues, and unbounded-input handling that
unit tests miss.

## Overview

Fuzz targets live in `contracts/fuzz/`:

| Target | Contract | Entry points exercised |
| --- | --- | --- |
| `agent_identity` | `agent-identity` | `register()`, `update_uri()` with arbitrary UTF-8/binary strings |
| `agentic_commerce` | `agentic-commerce` | `create_job()`, `submit()`, and voucher verification |

Each target feeds arbitrary bytes into the contract entry points and asserts that the
contract either succeeds or returns a clean contract error — never an unhandled panic.

## Prerequisites

1. **Rust nightly toolchain.** `cargo-fuzz` requires nightly for the
   `-Z sanitizer` flags.

   ```bash
   rustup toolchain install nightly
   rustup component add rust-src --toolchain nightly
   ```

2. **cargo-fuzz.** Install the CLI:

   ```bash
   cargo install cargo-fuzz
   ```

   Verify the installation:

   ```bash
   cargo fuzz --version
   ```

3. **libFuzzer runtime.** On Linux/macOS this is bundled with the Rust nightly
   toolchain. On Windows, use WSL2 or a Linux container — libFuzzer is not supported
   natively.

## Running Targets Locally

All commands are run from the `contracts/fuzz/` directory (or with `--manifest-path`).

Run a single target indefinitely:

```bash
cd contracts/fuzz
cargo +nightly fuzz run agent_identity
```

Run the commerce target:

```bash
cargo +nightly fuzz run agentic_commerce
```

Run for a bounded number of iterations (useful for a quick smoke check):

```bash
cargo +nightly fuzz run agent_identity -- -runs=1000000
```

Run for a bounded wall-clock time (e.g. 10 minutes):

```bash
cargo +nightly fuzz run agent_identity -- -max_total_time=600
```

Run with multiple parallel workers (scales with CPU cores):

```bash
cargo +nightly fuzz run agent_identity -- -jobs=8 -workers=8
```

List all available targets:

```bash
cargo +nightly fuzz list
```

## Interpreting Crashes

When libFuzzer finds a crashing input it writes an artifact to
`contracts/fuzz/artifacts/<target>/` and prints a summary such as:

```
==12345== ERROR: libFuzzer: deadly signal
...
artifact_prefix='./artifacts/agent_identity/'; Test unit written to
./artifacts/agent_identity/crash-<hash>
```

To reproduce a crash:

```bash
cargo +nightly fuzz run agent_identity artifacts/agent_identity/crash-<hash>
```

To get a symbolized backtrace, set:

```bash
RUST_BACKTRACE=1 cargo +nightly fuzz run agent_identity artifacts/agent_identity/crash-<hash>
```

### What counts as a failure

- **Unhandled panic** — any `panic!`, `unwrap()`, `expect()`, or arithmetic overflow
  that escapes the contract boundary. These are bugs and must be fixed.
- **Memory errors** — out-of-bounds reads/writes, use-after-free, or leaks reported by
  the sanitizer.
- **Timeouts / OOM** — inputs that cause unbounded work or allocation. These indicate
  missing input bounds.

### What does *not* count as a failure

- A clean contract error returned for malformed input (e.g. `InvalidUri`,
  `InputTooLong`, `Unauthorized`). The harness treats these as expected outcomes.
- Rejections of oversized inputs, as long as the rejection is a clean error and not a
  panic or allocation blow-up.

### Triage workflow

1. Reproduce the crash with the artifact file.
2. Minimize it:

   ```bash
   cargo +nightly fuzz tmin agent_identity artifacts/agent_identity/crash-<hash>
   ```

3. Add a regression unit test in the corresponding contract crate that covers the
   minimized input.
4. Fix the root cause (add bounds checks, replace `unwrap()` with error handling, etc.).
5. Re-run the target to confirm the crash no longer reproduces.

## Adding Corpus Seeds

Corpus seeds give the fuzzer a head start with realistic inputs. Seeds live in
`contracts/fuzz/corpus/<target>/`. Each file is a raw byte blob fed directly to the
target.

Add a seed:

```bash
# A valid-looking URI
printf 'ipfs://QmExampleHash' > contracts/fuzz/corpus/agent_identity/valid_uri

# A boundary-length URI (at the max allowed length)
head -c 256 /dev/zero | tr '\0' 'a' > contracts/fuzz/corpus/agent_identity/max_len_uri

# An oversized URI (should be rejected cleanly)
head -c 4096 /dev/zero | tr '\0' 'a' > contracts/fuzz/corpus/agent_identity/oversized_uri
```

Guidelines for good seeds:

- Include at least one valid input per entry point.
- Include boundary cases: empty, 1 byte, exactly at the max length, and one byte over.
- Include adversarial encodings: invalid UTF-8, embedded NULs, multi-byte sequences.
- Keep seeds small; the fuzzer will mutate them.

The corpus is committed to the repository so that CI and other developers benefit from
it. libFuzzer also maintains a growing corpus in
`contracts/fuzz/corpus/<target>/` during local runs — review and commit interesting
new entries.

## Nightly CI Smoke Check

The nightly pipeline runs a **10-minute fuzzing smoke check** for each target. The
check is defined in `.github/workflows/fuzz-nightly.yml` and invokes:

```bash
cd contracts/fuzz
cargo +nightly fuzz run agent_identity -- -max_total_time=600 -rss_limit_mb=4096
cargo +nightly fuzz run agentic_commerce -- -max_total_time=600 -rss_limit_mb=4096
```

The job:

1. Installs the nightly toolchain and `cargo-fuzz`.
2. Restores the cached corpus from previous runs (so coverage accumulates over time).
3. Runs each target for 10 minutes with a memory cap.
4. Uploads any crash artifacts as build artifacts and fails the job if a crash is found.
5. Saves the updated corpus back to the cache.

A failure in this job blocks the nightly build and opens a tracking issue with the
crash artifact attached.

## Acceptance Criteria

The fuzzing suite is considered healthy when:

- [ ] Each target runs **>1,000,000 iterations** without discovering unhandled panics
      or memory crashes.
- [ ] Oversized inputs are rejected with **clean contract errors** (no panics, no
      unbounded allocation).
- [ ] The nightly 10-minute smoke check passes for both targets.
- [ ] Any discovered crash is minimized, covered by a regression test, and fixed.

To verify the iteration count locally:

```bash
cargo +nightly fuzz run agent_identity -- -runs=1000000
```

A successful run prints `Done 1000000 runs` with no crash artifacts.

## Continuous Security Scanning

`cargo fuzz` is integrated into the continuous security scanning pipeline. On every
nightly run (and on demand via `workflow_dispatch`), the pipeline executes the smoke
check described above. Crash artifacts are retained for 30 days and surfaced in the
security dashboard.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `error: no such command: fuzz` | `cargo-fuzz` not installed | `cargo install cargo-fuzz` |
| `error: the option Z is only accepted on the nightly compiler` | Running on stable | Prefix with `+nightly` |
| `libFuzzer not found` | Unsupported platform | Use Linux/macOS or WSL2 |
| Target builds but exits immediately | Missing `fuzz_target!` macro | Check `fuzz_targets/<target>.rs` |
| OOM during run | Unbounded input handling | Add length bounds in the contract |