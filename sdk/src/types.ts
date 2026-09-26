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
  Disputed = "Disputed",
}

/**
 * Reverse mapping from the raw numeric status returned by `getJob()` to the
 * corresponding `JobStatus` string value.
 *
 * The Soroban contract stores `JobStatus` as a compact u32 enum on-chain.
 * When `scValToNative` decodes it you get a number (0-6). Instead of writing:
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
  6: JobStatus.Disputed,
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
  /**
   * Maximum time (in milliseconds) to poll `getTransaction` for finality
   * before giving up. Defaults to 60,000 ms (60 seconds).
   *
   * If a transaction is dropped by the network (e.g. sequence number
   * mismatch or mempool eviction) the polling loop would otherwise never
   * terminate; this bound guarantees `invoke()` eventually throws instead
   * of hanging the application indefinitely.
   */
  pollTimeoutMs?: number;
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
 * // .env — per-network override (takes priority over STELL

/* … truncated 6530 chars — edit only what you need near the top … */
