// Browser-safe entry point for the marc-stellar-sdk.
//
// The main entry (`index.js`) re-exports `marcPaywall` (Express middleware)
// and `marcFetch`, which pull in Node-only packages (`@x402/express`,
// `@x402/core/server`, `@x402/fetch`) and can't be bundled for the browser.
// This entry re-exports only the isomorphic surface: the two Soroban contract
// clients, shared types, the testnet preset, and wallet-signing helpers.
//
// Use it from browser apps (Vite, webpack, plain <script type="module">) with
// the `./browser` subpath:
//
//   import { CommerceClient, WalletSigner, TESTNET } from "marc-stellar-sdk/browser";
//
// Sign state-changing calls with a wallet extension by implementing
// `WalletSigner` (see `signer.ts`), e.g.:
//
//   const freighterSigner: WalletSigner = {
//     publicKey,
//     async signTransaction(xdr, { networkPassphrase }) {
//       const { signedTxXdr } = await window.freighterApi.signTransaction(
//         xdr,
//         { networkPassphrase },
//       );
//       return signedTxXdr;
//     },
//   };
export * from "./types.js";
export { IdentityClient } from "./identity.js";
export { CommerceClient } from "./commerce.js";
export * from "./signer.js";

export const MARC_STELLAR_SDK_VERSION = "0.1.0";
