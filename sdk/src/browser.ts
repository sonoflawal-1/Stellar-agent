/**
 * Browser-compatible entry point for marc-stellar SDK.
 *
 * Re-exports all browser-safe APIs. marcPaywall is intentionally excluded
 * since it requires Express (Node.js only). Use marcFetch for browser-based
 * x402 payment handling instead.
 */

export * from "./types.js";
export { IdentityClient } from "./identity.js";
export { CommerceClient } from "./commerce.js";
export { marcFetch, type MarcFetchOptions } from "./marcFetch.js";

// ScVal encoding helpers for custom contract interactions
export {
  i128ToScVal,
  u128ToScVal,
  u64ToScVal,
  u32ToScVal,
  strToScVal,
  addrToScVal,
} from "./commerce.js";

export const MARC_STELLAR_SDK_VERSION = "0.1.0";
