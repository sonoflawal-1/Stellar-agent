export * from "./types.js";
export { formatAmount } from "./format.js";
export { IdentityClient } from "./identity.js";
export { CommerceClient } from "./commerce.js";
export * from "./signer.js";
export { marcPaywall, type MarcPaywallOptions } from "./marcPaywall.js";
export { marcPaywallFastify, type MarcPaywallFastifyOptions } from "./marcPaywallFastify.js";
export {
  marcPaywallNodeHttp,
  MarcPaywallNodeHttpHandler,
  type MarcPaywallNodeHttpOptions,
} from "./marcPaywallNodeHttp.js";
export {
  marcFetch,
  parsePaymentRequiredHeader,
  type MarcFetchOptions,
  type PaymentStatus,
  type ParsedPaymentRequirement,
} from "./marcFetch.js";

// Core configuration types (framework-agnostic)
export type {
  MarcPaywallCoreOptions,
  PaymentCheckRequest,
  PaymentCheckResponse,
} from "./marcPaywallCore.js";

// ScVal encoding/decoding helpers for custom contract interactions
export {
  i128ToScVal,
  u128ToScVal,
  u64ToScVal,
  u32ToScVal,
  strToScVal,
  addrToScVal,
  i128FromScVal,
  u128FromScVal,
  u64FromScVal,
  u32FromScVal,
  strFromScVal,
  addrFromScVal,
} from "./commerce.js";

export const MARC_STELLAR_SDK_VERSION = "0.1.0";
