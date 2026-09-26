# MARC demo scripts

## `lifecycle.ts` — one-shot agent lifecycle orchestrator

Runs the full buyer ↔ seller lifecycle against a live Stellar testnet: spawns
a seller agent, runs the buyer agent, verifies the x402 payment, and exits 0
on success.

```bash
npm run lifecycle
```

### CLI flags

| Flag              | Default | Description                                                                   |
| ----------------- | ------- | ----------------------------------------------------------------------------- |
| `--dry-run`       | off     | Simulate the full lifecycle locally with no testnet RPC or credentials (#586).|
| `--step`          | off     | Pause between each phase for manual inspection.                               |
| `--cleanup`       | off     | Run the cleanup script after a successful live run.                           |
| `--timeout-sec N` | `60`    | Override the Stellar transaction timeout in seconds.                          |

#### `--dry-run` — offline simulation mode

Use this flag in CI environments or during local development when testnet
credentials or internet access are unavailable. It exercises the full
orchestration code path (all branching, logging, and phase ordering) without
invoking any Stellar RPC:

```bash
npm run lifecycle -- --dry-run
```

Expected output (exit code 0):

```
[lifecycle] … DRY-RUN mode — no testnet RPC will be called
[lifecycle] … [dry-run] starting seller-agent… (simulated)
[lifecycle] … [dry-run] seller-agent listening on :4402 (simulated)
[lifecycle] … [dry-run] seller HTTP ready (simulated)
[lifecycle] … [dry-run] running buyer-agent… (simulated)
[lifecycle] … [dry-run] buyer: registering agent identity… (simulated)
[lifecycle] … [dry-run] buyer: creating escrow job #DRY-001… (simulated)
[lifecycle] … [dry-run] buyer: sending x402 payment… (simulated)
[lifecycle] … [dry-run] buyer: payment verified ✓ (simulated)
[lifecycle] … [dry-run] buyer: deliverable received ✓ (simulated)
[lifecycle] … [dry-run] buyer: evaluator approving job… (simulated)
[lifecycle] … [dry-run] buyer: funds released to seller ✓ (simulated)
[lifecycle] … shutting down seller-agent (simulated)
[lifecycle] … SUCCESS — dry-run lifecycle completed (exit 0)
```

---

## `simulate.ts` — multi-agent marketplace simulation

Runs sellers and buyers against the configured Stellar network end-to-end
(register agents, fund escrow, submit/complete jobs).

```bash
npm run simulate
```

### CLI flags

| Flag        | Default    | Description                                              |
| ----------- | ---------- | -------------------------------------------------------- |
| `--sellers` | `4`        | Number of seller agents to spin up.                      |
| `--buyers`  | `5`        | Number of buyer agents to spin up.                       |
| `--budget`  | `10000000` | Escrow budget per job, in stroops (`10000000` = 1 USDC). |

Pass flags after `--` when invoking through `npm run simulate`, or directly
when invoking `tsx` yourself:

```bash
npm run simulate -- --sellers 2 --buyers 2 --budget 5000000
npx tsx simulate.ts --sellers 1 --buyers 1
```

Invalid or missing flag values (non-numeric, zero, negative, or the flag
given with no value) fall back to the defaults above rather than failing.
Running `npm run simulate` with no flags behaves exactly as before.

`simulate.ts` also supports two standalone modes that run instead of the
normal simulation (unaffected by the flags above):

- `--cancel` — runs the cancel & refund demo flow.
- `--stress <N>` — runs a stress test creating `N` jobs.
