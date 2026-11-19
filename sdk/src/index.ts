export * from "./types.js";
export * from "./events.js";
// #1048 — typed event decoding: exhaustive BearEvent union + assertNever helper
export {
  decodeBearEvent,
  assertNever,
  type BearEvent,
  type BearEventType,
} from "./events.js";
export * from "./subscribeJob.js";
export * from "./errors.js";
// #953/#955 — typed payment failure + budget guard errors
export {
  BudgetExceededError,
  PaymentRejectedError,
  InsufficientFundsError,
} from "./errors.js";
// #948 — decoded contract error names + typed contract errors
export {
  CONTRACT_ERRORS,
  BearContractError,
  wrapContractError,
} from "./contractErrors.js";
export { formatAmount, parseAmount, isValidMetadataUri } from "./format.js";
// #952 — multi-token amount helpers using on-chain decimals
export { toBaseUnits, fromBaseUnits, TokenRegistry } from "./format.js";
// #954/#955 — payment receipt + budget guard types
export type {
  PaymentReceipt,
  MarcFetchResult,
  BudgetOptions,
  BudgetExceededInfo,
} from "./types.js";
// #706 — SHA-256 deliverable payload content hash helpers
export {
  computeDeliverableHash,
  verifyDeliverableHash,
  type DeliverableHashInput,
} from "./deliverableHash.js";
export { IdentityClient } from "./identity.js";
export { CommerceClient } from "./commerce.js";
export type {
  ChannelVoucher,
  EvaluatorProgress,
  PaymentChannelSession,
} from "./commerce.js";
export {
  channelVoucherPayload,
  createChannelVoucher,
  verifyChannelVoucher,
} from "./paymentChannels.js";
export * from "./signer.js";
export { marcPaywall, FACILITATOR_URLS, type MarcPaywallOptions } from "./marcPaywall.js";
export { marcPaywallFastify, type MarcPaywallFastifyOptions } from "./marcPaywallFastify.js";
export { marcPaywallHono, type MarcPaywallHonoOptions } from "./marcPaywallHono.js";
export { marcPaywallNext, type MarcPaywallNextOptions } from "./marcPaywallNext.js";
export {
  marcPaywallNodeHttp,
  MarcPaywallNodeHttpHandler,
  type MarcPaywallNodeHttpOptions,
} from "./marcPaywallNodeHttp.js";
export {
  marcFetch,
  marcFetchStream,
  parsePaymentRequiredHeader,
  type MarcFetchOptions,
  type MarcStreamOptions,
  type StreamChunk,
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

// #781 — RPC failover pool (exported for advanced usage / observability)
export { RpcFailoverPool, type RpcEndpointHealth } from "./baseClient.js";

// #726 — OpenTelemetry distributed tracing bootstrap
export {
  initTracing,
  getTracer,
  injectTraceparent,
  withSpan,
  type InitTracingOptions,
  type SpanAttributes,
} from "./tracing.js";

/**
 * The current semantic version of the `marc-stellar-sdk` package.
 *
 * Useful for logging, debugging, and compatibility checks at runtime.
 *
 * @example
 * ```typescript
 * import { MARC_STELLAR_SDK_VERSION } from "marc-stellar-sdk";
 * console.log("SDK version:", MARC_STELLAR_SDK_VERSION); // "0.1.0"
 * ```
 */
export const MARC_STELLAR_SDK_VERSION = "0.1.0";

// #694 — whitelisted token addresses on testnet
export const TESTNET_ALLOWED_TOKENS = {
  USDC: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  // Add EURC and XLM SAC when deployed
} as const;

export type { Milestone, MilestoneInput } from './types.js';

// #698 — atomic batch job creation
export type { JobRequest, BatchJobsCreatedEvent } from './commerce.js';

// #979 — webhook subscription management: timing-safe HMAC-SHA256 signature verification
export { verifyWebhookSignature } from "./webhookSignature.js";
