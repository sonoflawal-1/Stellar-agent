// Shared types for the marc-stellar SDK.
//
// These mirror the on-chain structures of the two Soroban contracts
// (`agent_identity`, `agentic_commerce`) so callers can work with
// strongly-typed JS objects instead of raw ScVal.
//
// Numeric fields that are `u64` / `i128` on-chain are modelled as `bigint`
// on the JS side to preserve precision.

/**
 * A Stellar account or contract address in StrKey format.
 *
 * - Public account addresses start with `G` (e.g., `GXXXXXXXXXXXXXX...`)
 * - Contract addresses start with `C` (e.g., `CXXXXXXXXXXXXXX...`)
 *
 * This is a simple string alias (not a branded type) for usability.
 * The `@stellar/stellar-sdk` `Address` class handles StrKey ↔ ScVal conversion.
 *
 * @example
 * "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K"
 */
export type Address = string;

/**
 * On-chain agent record from the `agent_identity` contract.
 *
 * Represents a registered service agent with identity and metadata.
 * Mirrors the Rust contract struct exactly.
 */
export interface Agent {
  /** The agent's unique on-chain identifier. */
  id: bigint;
  /** The owner's Stellar address. */
  owner: Address;
  /** Metadata URI (IPFS, HTTP, etc.). */
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
 * On-chain job record from the `agentic_commerce` contract.
 *
 * Represents a complete work assignment with budget, lifecycle state, and timestamps.
 * Mirrors the Rust contract struct exactly. Budget is `i128` on-chain → `bigint` in JS.
 */
export interface Job {
  /** The job's unique on-chain identifier. */
  id: bigint;
  /** The client (job creator and budget owner). */
  client: Address;
  /** The service provider (deliverable submitter). */
  provider: Address;
  /** The evaluator (approves completion and triggers payout). */
  evaluator: Address;
  /** Token contract address (e.g., USDC SAC). */
  token: Address;
  /** Budget amount in smallest token units. */
  budget: bigint;
  /** Current job lifecycle state. */
  status: JobStatus;
  /** Human-readable job description. */
  description: string;
  /** IPFS/URL link to the submitted work (empty until submitted). */
  deliverable: string;
  /** Unix timestamp when the job was funded. */
  funded_at: bigint;
  /** Unix timestamp when the job was created. */
  created_at: bigint;
  /** Unix timestamp of the last state change. */
  updated_at: bigint;
}

/**
 * Configuration required by SDK clients (`IdentityClient`, `CommerceClient`).
 *
 * Specifies network, deployment, and RPC settings. Create once per network
 * and reuse across client instances. The `TESTNET` constant is a convenient preset.
 *
 * @example
 * ```typescript
 * const cfg: MarcConfig = {
 *   ...TESTNET,
 *   rpcUrl: "https://custom-rpc.example.com", // override RPC
 * };
 * const identity = new IdentityClient(cfg);
 * ```
 */
export interface MarcConfig {
  /** Soroban JSON-RPC endpoint (e.g., `https://soroban-testnet.stellar.org`). */
  rpcUrl: string;
  /** Network passphrase for transaction signing (e.g., `Networks.TESTNET`). */
  networkPassphrase: string;
  /** Deployed `agent_identity` contract address (starts with `C`). */
  identityContract: Address;
  /** Deployed `agentic_commerce` contract address (starts with `C`). */
  commerceContract: Address;
  /** Token SAC address for job budgets (e.g., USDC on testnet). */
  usdcToken: Address;
  /** Optional callback fired after each successful on-chain transaction. */
  onTx?: (hash: string, method: string) => void;
}

/**
 * Preset configuration for Stellar testnet.
 *
 * Contains hard-coded contract addresses and network settings for testnet.
 * Values are updated each time contracts are deployed via `scripts/deploy-testnet.sh`.
 * Use as a base and override fields for custom RPC URLs or other adjustments.
 *
 * @example
 * ```typescript
 * const cfg = { ...TESTNET, rpcUrl: "http://localhost:8000" };
 * ```
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
