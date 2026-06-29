// Shared types for the marc-stellar SDK.
//
// These mirror the on-chain structures of the two Soroban contracts
// (`agent_identity`, `agentic_commerce`) so callers can work with
// strongly-typed JS objects instead of raw ScVal.
//
// Numeric fields that are `u64` / `i128` on-chain are modelled as `bigint`
// on the JS side to preserve precision.

/**
 * A Stellar account or contract address in its StrKey form.
 *
 * - Account addresses start with `G...`
 * - Contract addresses start with `C...`
 *
 * We intentionally leave this as a string alias rather than a branded type —
 * callers get one type to think about, and `@stellar/stellar-sdk`'s `Address`
 * class handles StrKey <-> ScVal conversion internally.
 */
export type Address = string;

/**
 * On-chain `Agent` record returned by `agent_identity.get_agent(id)`.
 *
 * Matches the Rust struct:
 *   pub struct Agent { pub id: u64, pub owner: Address, pub uri: String }
 */
export interface Agent {
  id: bigint;
  owner: Address;
  uri: string;
}

/**
 * Lifecycle states for a job in `agentic_commerce`.
 *
 * The string values match the Rust enum variant names emitted by
 * `scValToNative` so we can round-trip without a manual mapping table.
 *
 * NOTE: `Open` is reserved for a future "unfunded intent" flow — the current
 * contract transitions straight from pre-creation to `Funded` during
 * `create_job` because the escrow transfer happens atomically. We keep the
 * variant here so the SDK doesn't break when the contract grows.
 */
export enum JobStatus {
  Open = "Open",
  Funded = "Funded",
  Submitted = "Submitted",
  Completed = "Completed",
  Rejected = "Rejected",
  Cancelled = "Cancelled",
}

/**
 * On-chain `Job` record returned by `agentic_commerce.get_job(id)`.
 *
 * Matches the Rust struct 1:1. `budget` is `i128` on-chain so JS sees `bigint`.
 */
export interface Job {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  token: Address;
  budget: bigint;
  status: JobStatus;
  description: string;
  deliverable: string;
  funded_at: bigint;
  created_at: bigint;
  updated_at: bigint;
}

/**
 * Connection + deployment configuration required by every SDK client.
 *
 * Constructed once per process (or per network) and passed to
 * `IdentityClient` / `CommerceClient`.
 */
export interface MarcConfig {
  /** Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org`. */
  rpcUrl: string;
  /** Network passphrase, e.g. `Networks.TESTNET`. */
  networkPassphrase: string;
  /** Deployed `agent_identity` contract address. */
  identityContract: Address;
  /** Deployed `agentic_commerce` contract address. */
  commerceContract: Address;
  /** USDC (or test SAC) token address used as the escrow currency. */
  usdcToken: Address;
  /** Optional callback fired after every successful on-chain tx. */
  onTx?: (hash: string, method: string) => void;
}

/**
 * Hard-coded deployment preset for Stellar testnet.
 *
 * Values mirror `deployments/testnet.json` at the repo root. Updated whenever
 * `scripts/deploy-testnet.sh` writes a new snapshot. Callers can spread this
 * into a `MarcConfig` and override what they need (e.g. a local RPC URL).
 *
 * `usdcToken` comes from x402-stellar's `STELLAR_TOKENS["stellar-testnet"].USDC`
 * token catalog — it's the canonical USDC SAC on testnet.
 */
export const TESTNET = {
  network: "stellar-testnet" as const,
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: (typeof process !== "undefined" && process.env["STELLAR_RPC_URL"])
    ? process.env["STELLAR_RPC_URL"]
    : "https://soroban-testnet.stellar.org",
  identityContract:
    "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5" as Address,
  commerceContract:
    "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE" as Address,
  deployer:
    "GA5VIZYCUM3IUZZNQTTB7YSLJSE5WZ2EI5EGWNLTWQ234SLSH45MPKX3" as Address,
  usdcToken:
    "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" as Address,
} as const;

/**
 * Symbol topic names emitted by the `agentic_commerce` contract events.
 *
 * The Soroban `#[contractevent]` macro publishes the struct name (converted to
 * the Symbol string below) as the first topic of every event.  Use these
 * constants when filtering `getEvents` results so callers never have to
 * hardcode magic strings.
 *
 * Example:
 *   const events = await server.getEvents({ filters: [{ topics: [[CommerceEvents.JobCreated]] }] });
 */
export const CommerceEvents = {
  JobCreated: "JobCreated",
  JobSubmitted: "JobSubmitted",
  JobCompleted: "JobCompleted",
  JobRefunded: "JobRefunded",
  JobCancelled: "JobCancelled",
} as const;

export type CommerceEventName = (typeof CommerceEvents)[keyof typeof CommerceEvents];

/** Decoded payload for a `JobCreated` event. */
export interface JobCreatedEvent {
  type: typeof CommerceEvents.JobCreated;
  client: Address;
  jobId: bigint;
  budget: bigint;
}

/** Decoded payload for a `JobSubmitted` event. */
export interface JobSubmittedEvent {
  type: typeof CommerceEvents.JobSubmitted;
  provider: Address;
  jobId: bigint;
}

/** Decoded payload for a `JobCompleted` event. */
export interface JobCompletedEvent {
  type: typeof CommerceEvents.JobCompleted;
  evaluator: Address;
  jobId: bigint;
  payout: bigint;
  fee: bigint;
  timestamp: bigint;
}

/** Decoded payload for a `JobRefunded` event. */
export interface JobRefundedEvent {
  type: typeof CommerceEvents.JobRefunded;
  client: Address;
  jobId: bigint;
}

/** Decoded payload for a `JobCancelled` event. */
export interface JobCancelledEvent {
  type: typeof CommerceEvents.JobCancelled;
  client: Address;
  jobId: bigint;
}

/** Discriminated union of all agentic-commerce contract events. */
export type JobEvent =
  | JobCreatedEvent
  | JobSubmittedEvent
  | JobCompletedEvent
  | JobRefundedEvent
  | JobCancelledEvent;
