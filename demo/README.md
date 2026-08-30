# MARC demo scripts

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
