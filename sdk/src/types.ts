import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
 * Reverse mapping from the raw numeric status returned by `getJob()` to the
 * corresponding `JobStatus` string value.
 *
 * The Soroban contract stores `JobStatus` as a compact u32 enum on-chain.
 * When `scValToNative` decodes it you get a number (0-5). Instead of writing:
 *
 * ```ts
 * const label = Object.keys(JobStatus).find(k => (JobStatus as any)[k] === n);
 * ```
 *
 * you can now do:
 *
 * ```ts
 * const label: JobStatus = JobStatusFromNumber[n]; // e.g. JobStatus.Funded
 * ```
 *
 * The index order matches the Rust enum declaration in `agentic-commerce/src/lib.rs`.
 */
export const JobStatusFromNumber: Record<number, JobStatus> = {
  0: JobStatus.Open,
  1: JobStatus.Funded,
  2: JobStatus.Submitted,
  3: JobStatus.Completed,
  4: JobStatus.Rejected,
  5: JobStatus.Cancelled,
};

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

interface PresetConfig {
  network: "stellar-testnet" | "stellar-mainnet";
  networkPassphrase: string;
  rpcUrl: string;
  identityContract: Address;
  commerceContract: Address;
  deployer?: Address;
  usdcToken: Address;
}

function getEnvValue(name: string) {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

function resolveDeploymentValues(network: "testnet" | "mainnet") {
  const envIdentity = getEnvValue(
    network === "testnet" ? "MARC_TESTNET_IDENTITY_CONTRACT" : "MARC_MAINNET_IDENTITY_CONTRACT",
  );
  const envCommerce = getEnvValue(
    network === "testnet" ? "MARC_TESTNET_COMMERCE_CONTRACT" : "MARC_MAINNET_COMMERCE_CONTRACT",
  );
  const envUsdc = getEnvValue(
    network === "testnet" ? "MARC_TESTNET_USDC_TOKEN" : "MARC_MAINNET_USDC_TOKEN",
  );

  if (envIdentity || envCommerce || envUsdc) {
    return {
      identityContract: (envIdentity || "") as Address,
      commerceContract: (envCommerce || "") as Address,
      usdcToken: (envUsdc || "") as Address,
    };
  }

  try {
    const deploymentPath = fileURLToPath(
      new URL(`../../deployments/${network}.json`, import.meta.url),
    );
    const deploymentConfig = JSON.parse(readFileSync(deploymentPath, "utf8"));
    return {
      identityContract: (deploymentConfig.agent_identity ||
        deploymentConfig.identityContract ||
        "") as Address,
      commerceContract: (deploymentConfig.agentic_commerce ||
        deploymentConfig.commerceContract ||
        "") as Address,
      usdcToken: (deploymentConfig.usdcToken || "") as Address,
    };
  } catch {
    if (network === "testnet") {
      return {
        identityContract: "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5" as Address,
        commerceContract: "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE" as Address,
        usdcToken: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" as Address,
      };
    }

    return {
      identityContract: "" as Address,
      commerceContract: "" as Address,
      usdcToken: "" as Address,
    };
  }
}

/**
 * Resolve the Soroban RPC URL for a given network.
 *
 * Lookup order (first match wins):
 *   1. `STELLAR_TESTNET_RPC_URL` / `STELLAR_MAINNET_RPC_URL` — network-specific override
 *   2. `STELLAR_RPC_URL` — generic override (applies to whichever network is active)
 *   3. `defaultRpcUrl` — hard-coded fallback (e.g. public SDF endpoint)
 *
 * This lets callers point the SDK at a local testnet (e.g. Docker), a
 * custom RPC provider, or any other endpoint without touching source code.
 *
 * @param network      - `"testnet"` or `"mainnet"`, used to pick the
 *                       network-specific env var first.
 * @param defaultRpcUrl - The built-in fallback URL for this network.
 *
 * @example
 * // .env
 * STELLAR_RPC_URL=http://localhost:8000/soroban/rpc
 *
 * @example
 * // .env — per-network override (takes priority over STELLAR_RPC_URL)
 * STELLAR_TESTNET_RPC_URL=https://my-rpc-provider.example.com
 */
export function getEnvRpcUrl(network: "testnet" | "mainnet", defaultRpcUrl: string): string {
  if (typeof process === "undefined") return defaultRpcUrl;
  const networkKey = network === "testnet" ? "STELLAR_TESTNET_RPC_URL" : "STELLAR_MAINNET_RPC_URL";
  return process.env[networkKey] ?? process.env["STELLAR_RPC_URL"] ?? defaultRpcUrl;
}

/**
 * Preset configuration for Stellar testnet.
 *
 * Defaults to the latest deployed testnet addresses when available, while still
 * allowing environment overrides for custom RPC endpoints or deployment paths.
 *
 * RPC URL resolution order:
 *   `STELLAR_TESTNET_RPC_URL` → `STELLAR_RPC_URL` → `https://soroban-testnet.stellar.org`
 */
export const TESTNET: PresetConfig = {
  network: "stellar-testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: getEnvRpcUrl("testnet", "https://soroban-testnet.stellar.org"),
  ...resolveDeploymentValues("testnet"),
  deployer: "GA5VIZYCUM3IUZZNQTTB7YSLJSE5WZ2EI5EGWNLTWQ234SLSH45MPKX3" as Address,
};

/**
 * Preset configuration for Stellar mainnet.
 *
 * RPC URL resolution order:
 *   `STELLAR_MAINNET_RPC_URL` → `STELLAR_RPC_URL` → `https://soroban-rpc.mainnet.stellar.org`
 */
export const MAINNET: PresetConfig = {
  network: "stellar-mainnet",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  rpcUrl: getEnvRpcUrl("mainnet", "https://soroban-rpc.mainnet.stellar.org"),
  ...resolveDeploymentValues("mainnet"),
};

/**
 * Demo preset — identical to TESTNET but with the custom MUSD token used by
 * the Bear Protocol demo and dashboard instead of Circle's testnet USDC.
 *
 * Use this preset when running `./start-agents.sh` or the dashboard locally.
 * Swap back to `TESTNET` when integrating with Circle USDC on testnet.
 */
export const DEMO: PresetConfig = {
  ...TESTNET,
  usdcToken: (getEnvValue("MARC_DEMO_MUSD_TOKEN") ||
    "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA") as Address,
};

export function loadConfig(network: "testnet" | "mainnet"): PresetConfig {
  return network === "mainnet" ? MAINNET : TESTNET;
}

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
  JobCreatedEvent | JobSubmittedEvent | JobCompletedEvent | JobRefundedEvent | JobCancelledEvent;
