# marc-stellar-sdk

Typed TypeScript helpers for the two MARC Soroban contracts, plus re-exports of the x402 client/server primitives. See `../docs/superpowers/specs/2026-04-11-marc-stellar-design.md` for the design and `../docs/plans/2026-04-11-marc-stellar.md` for the implementation plan.

## Exports (target surface)

- `IdentityClient` — wrapper over `agent_identity` contract (register, get_agent, agent_of, update_uri, deregister)
- `CommerceClient` — wrapper over `agentic_commerce` contract (create_job, submit, complete, cancel, get_job, fee_bps)
- `marcPaywall` — Express middleware wrapping x402 (**Node only**)
- `marcFetch` — client-side auto-402 wrapper (**Node only** — holds a secret `Keypair`)
- `WalletSigner` / `KeypairSigner` / `toSigner` / `signerPublicKey` — signer abstraction; lets the clients sign with a browser wallet or a `Keypair`
- `types` — `Agent`, `Job`, `JobStatus`, `MarcConfig`

## Browser build

`marcPaywall` and `marcFetch` pull in Node-only `@x402/*` packages, so the main entry won't bundle for browsers. Use the **`marc-stellar-sdk/browser`** subpath for browser apps — it exports the contract clients, types, `TESTNET`, and the wallet-signing helpers, with no Node imports:

```ts
import { CommerceClient, type WalletSigner, TESTNET } from "marc-stellar-sdk/browser";

const signer: WalletSigner = {
  publicKey,
  async signTransaction(xdr, { networkPassphrase }) {
    const { signedTxXdr } = await window.freighterApi.signTransaction(xdr, { networkPassphrase });
    return signedTxXdr;
  },
};

await commerce.createJob(signer, provider, evaluator, TESTNET.usdcToken, 10_000_000n, "...");
```

Build it with `npm run build:browser` (esbuild → `dist/browser.js`, tsc → `dist/browser.d.ts`). Full docs incl. build steps: `../docs/sdk.md`.

## Status

Active. SDK phases (4.x) done and runtime-verified on testnet.
