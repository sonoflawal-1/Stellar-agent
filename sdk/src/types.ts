import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JobStatus } from "./jobStatus.js";
export { JobStatus, JobStatusFromNumber } from "./jobStatus.js";

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
 * The numeric index of each variant matches the Rust enum declaration in
 * `agentic-commerce/src/lib.rs`:
 *
 * | Index | Variant   |
 * | ----- | --------- |
 * | 0     | Open      |
 * | 1     | Funded    |
 * | 2     | Submitted |
 * | 3     | Completed |
 * | 4     | Rejected  |
 * | 5     | Cancelled |
 * | 6     | Disputed  |
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
  /**
   * SHA-256 content hash of the submitted deliverable (#706).
   *
   * Mirrors the on-chain `deliverable_hash: BytesN<32>` field. Stored as a
   * 32-byte `Uint8Array` so it round-trips cleanly through `scValToNative`
   * (Soroban `Bytes`/`BytesN` decode to `Uint8Array` in the JS SDK).
   *
   * Empty (all-zero / zero-length) until the provider submits a deliverable.
   * Immutable once submitted — the contract rejects any later mutation.
   */
  deliverable_hash: Uint8Array;
  /** Unix timestamp when the job was funded. */
  funded_at: bigint;
  /** Unix timestamp when the job was created. */
  created_at: bigint;
  /** Unix timestamp of the last state change. */
  updated_at: bigint;
}

/**
 * Optional arguments for `CommerceClient.createJob()`, `createJobAndWait()` and
 * `approveAndCreateJob()` (#833).
 *
 * `slaDeadline` and `penaltyBpsPerHour` map to the contract's `create_job`
 * SLA arguments (#716). Both default to zero, which disables the SLA penalty.
 */
export interface CreateJobOptions {
  /** Optional transaction memo. */
  memo?: string;
  /** Unix timestamp (seconds) by which the deliverable is due. Encoded as `u64`. Default `0n`. */
  slaDeadline?: bigint;
  /** Penalty in basis points per overdue hour. Encoded as `u32`. Default `0`. */
  penaltyBpsPerHour?: number;
}

/**
 * Configuration required by SDK clients (`IdentityClient`, `CommerceClient`).
 *
 * Specifies network, deployment, and RPC settings. Create once per network
 * and reuse across client instances. The `TESTNET` constant is a convenient preset.
 *
 * ### Multi-endpoint failover (#781)
 * Provide `rpcUrls` with two or more Soroban RPC URLs to enable automatic
 * health-checking and transparent failover via {@link RpcFailoverPool}. The
 * pool routes calls to the lowest-latency healthy endpoint and retries with
 * exponential backoff when an endpoint returns a 5xx or network error.
 * `rpcUrl` is still accepted for single-endpoint / backward-compatible usage.
 *
 * @example
 * ```typescript
 * const cfg: MarcConfig = {
 *   ...TESTNET,
 *   // Multi-endpoint failover:
 *   rpcUrls: [
 *     "https://soroban-testnet.stellar.org",
 *     "https://rpc.ankr.com/stellar_testnet",
 *   ],
 * };
 * const identity = new IdentityClient(cfg);
 * ```
 */
export interface MarcConfig {
  /** Soroban JSON-RPC endpoint (e.g., `https://soroban-testnet.stellar.org`). */
  rpcUrl: string;
  /**
   * Optional list of Soroban RPC endpoints for automatic failover (#781).
   *
   * When provided, the SDK creates an {@link RpcFailoverPool} that routes
   * all calls through the healthiest available endpoint. `rpcUrl` is used
   * as a fallback when this array is empty or omitted.
   */
  rpcUrls?: string[];
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

// ---------------------------------------------------------------------------
// #696 — Delegate / WebAuthn session key types (SDK mirror of Rust structs)
// ---------------------------------------------------------------------------

/**
 * Permission bitmask constants for agent delegates (#696).
 *
 * Mirrors the `PERM_*` constants in `contracts/agent-identity/src/lib.rs`.
 */
export const DelegatePermission = {
  /** Delegate may call `update_uri` on behalf of the agent owner. */
  UPDATE_URI: 0b0001,
  /** Delegate may call `deregister` on behalf of the agent owner. */
  DEREGISTER: 0b0010,
  /** Delegate may call `transfer_owner` on behalf of the agent owner. */
  TRANSFER: 0b0100,
  /** All permissions combined. */
  ALL: 0b0111,
} as const;

export type DelegatePermissionValue = (typeof DelegatePermission)[keyof typeof DelegatePermission];

/**
 * A time-bounded delegate key that can act on behalf of an agent owner.
 *
 * Mirrors the `Delegate` struct in `contracts/agent-identity/src/lib.rs` (#696).
 * Designed for autonomous AI agents that cannot safely hold master private keys.
 *
 * @example
 * ```typescript
 * // Grant a 24-hour session key with URI-update permission only
 * await identity.addDelegate(ownerKeypair, agentId, sessionPublicKey, {
 *   ttl: 86_400n,
 *   permissions: DelegatePermission.UPDATE_URI,
 * });
 * ```
 */
export interface DelegateInfo {
  /** Stellar address of the delegate key (ephemeral session key or passkey address). */
  delegateAddress: Address;
  /** Unix timestamp (seconds) after which the delegate is considered expired. */
  validUntil: bigint;
  /** Bitmask of allowed operations — see {@link DelegatePermission}. */
  permissions: number;
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
 */
function resolveRpcUrl(
  network: "testnet" | "mainnet",
  defaultRpcUrl: string,
): string {
  const networkKey = network === "testnet" ? "STELLAR_TESTNET_RPC_URL" : "STELLAR_MAINNET_RPC_URL";
  return process.env[networkKey] ?? process.env.STELLAR_RPC_URL ?? defaultRpcUrl;
}

/**
 * Pre-built config for Stellar Testnet.
 *
 * Uses SDF's public Soroban RPC and the known testnet contract addresses.
 * Override any field via environment variables.
 */
export const TESTNET: MarcConfig = {
  rpcUrl: resolveRpcUrl("testnet", "https://soroban-testnet.stellar.org"),
  networkPassphrase: "Test SDF Network ; September 2015",
  identityContract: "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5" as Address,
  commerceContract: "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE" as Address,
  usdcToken: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" as Address,
};

/**
 * Pre-built config for Stellar Mainnet (public network).
 */
export const MAINNET: MarcConfig = {
  rpcUrl: resolveRpcUrl("mainnet", "https://soroban-rpc.mainnet.stellar.org"),
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  identityContract: "" as Address,
  commerceContract: "" as Address,
  usdcToken: "" as Address,
};

/**
 * Load SDK configuration from environment variables or a deployment config file.
 */
export function loadConfig(network: "testnet" | "mainnet" = "testnet"): MarcConfig {
  const values = resolveDeploymentValues(network);
  return {
    rpcUrl: resolveRpcUrl(network, network === "testnet"
      ? "https://soroban-testnet.stellar.org"
      : "https://soroban-rpc.mainnet.stellar.org"),
    networkPassphrase: network === "testnet"
      ? "Test SDF Network ; September 2015"
      : "Public Global Stellar Network ; September 2015",
    identityContract: values.identityContract,
    commerceContract: values.commerceContract,
    usdcToken: values.usdcToken,
  };
}

/**
 * Returns true if the given job status is a terminal state (no further
 * transitions are possible).
 */
export function isJobTerminal(status: JobStatus): boolean {
  return (
    status === JobStatus.Completed ||
    status === JobStatus.Cancelled
  );
}

/**
 * Returns true if the given job status is an active (non-terminal) state.
 */
export function isJobActive(status: JobStatus): boolean {
  return !isJobTerminal(status);
}

/**
 * A single milestone within a milestone-based escrow job.
 * Mirrors the Rust `Milestone` contracttype struct in `agentic-commerce`.
 */
export interface Milestone {
  /** Zero-based position within the job's milestone sequence. */
  index: number;
  /** Allocated amount for this milestone in smallest token units. */
  amount: bigint;
  /** Human-readable description of this milestone's deliverable. */
  description: string;
  /** Submitted deliverable URI (empty string until submitted). */
  deliverable: string;
  /** Whether the evaluator has approved this milestone. */
  approved: boolean;
}

/** Input shape for creating a milestone job (pre-normalisation). */
export interface MilestoneInput {
  amount: bigint;
  description: string;
}

// ---------------------------------------------------------------------------
// #706 — SHA-256 deliverable content hash verification
// ---------------------------------------------------------------------------

/**
 * A 32-byte SHA-256 content hash, as committed on-chain via `BytesN<32>`.
 *
 * Accepts either the raw 32-byte buffer (`Uint8Array`) or a 64-character
 * lowercase/uppercase hex string. Use {@link normalizeDeliverableHash} to
 * convert a hex string into the canonical `Uint8Array` form before passing
 * it to `submit()`.
 *
 * @example
 * ```ts
 * const hash: DeliverableHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
 * ```
 */
export type DeliverableHash = Uint8Array | string;

/**
 * Optional assertion passed to `complete()` so the evaluator can attest that
 * the content they actually evaluated matches the hash committed at
 * `submit()` time (#706).
 *
 * When provided, the contract compares `expectedHash` against the stored
 * `deliverable_hash` and rejects the call with a mismatch error if they
 * differ. Omit it to complete without an integrity assertion.
 *
 * @example
 * ```ts
 * await commerce.complete(evaluatorKeypair, jobId, {
 *   expectedHash: sha256(deliverableBuffer),
 * });
 * ```
 */
export interface CompleteOptions {
  /**
   * The SHA-256 hash the evaluator asserts matches the submitted deliverable.
   * Must equal the on-chain `deliverable_hash` or the transaction reverts.
   */
  expectedHash?: DeliverableHash;
}

/**
 * Normalise a {@link DeliverableHash} into the canonical 32-byte
 * `Uint8Array` expected by the contract's `BytesN<32>` parameter.
 *
 * - `Uint8Array` input is validated for length and returned as-is.
 * - Hex string input (with or without a leading `0x`) is decoded.
 *
 * @throws {Error} If the input is not exactly 32 bytes / 64 hex characters.
 */
export function normalizeDeliverableHash(hash: DeliverableHash): Uint8Array {
  if (hash instanceof Uint8Array) {
    if (hash.length !== 32) {
      throw new Error(
        `deliverable hash must be exactly 32 bytes, received ${hash.length}`,
      );
    }
    return hash;
  }

  const hex = hash.startsWith("0x") ? hash.slice(2) : hash;
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "deliverable hash must be a 64-character hex string or a 32-byte Uint8Array",
    );
  }

  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// #954 — Payment receipt returned from marcFetch
// ---------------------------------------------------------------------------

/**
 * A record of the on-chain payment made to satisfy a 402 challenge during
 * {@link marcFetch} (#954).
 *
 * The fields mirror the ledger data of the settlement transaction so callers
 * can persist an auditable record of what was paid, to whom, and in which
 * ledger it was confirmed.
 *
 * @example
 * ```ts
 * const { response, receipt } = await marcFetch(url, { returnReceipt: true });
 * console.log(`paid ${receipt.amount} of ${receipt.token} to ${receipt.payTo}`);
 * ```
 */
export interface PaymentReceipt {
  /** Hash of the settlement transaction that carried the payment. */
  txHash: string;
  /** Amount paid, in the smallest unit of {@link token}. */
  amount: bigint;
  /** Token (SAC) contract address the payment was denominated in. */
  token: Address;
  /** Recipient address the payment was sent to. */
  payTo: Address;
  /** Ledger sequence number in which the payment was confirmed. */
  ledger: number;
}

/**
 * Result returned by {@link marcFetch} when receipt reporting is enabled
 * (`returnReceipt: true`) (#954).
 *
 * When receipt reporting is not requested, `marcFetch` resolves to the plain
 * `Response` for backward compatibility.
 */
export interface MarcFetchResult {
  /** The upstream HTTP response, unmodified. */
  response: Response;
  /** The on-chain payment receipt for the 402 settlement. */
  receipt: PaymentReceipt;
}

// ---------------------------------------------------------------------------
// #955 — Budget guard for marcFetch
// ---------------------------------------------------------------------------

/**
 * Information passed to the {@link BudgetOptions.onBudgetExceeded} hook when a
 * {@link marcFetch} call is rejected by the budget guard (#955).
 */
export interface BudgetExceededInfo {
  /** Which limit was breached. */
  limit: "maxPerRequest" | "maxPerWindow";
  /** The configured limit value, in smallest token units. */
  limitValue: bigint;
  /** The amount that would have been spent, in smallest token units. */
  attemptedAmount: bigint;
  /** Total amount already spent within the current rolling window. */
  spentInWindow: bigint;
  /** Length of the rolling window in milliseconds. */
  windowMs: number;
  /** The URL that triggered the guard. */
  url: string;
}

/**
 * Budget guard options for {@link marcFetch} (#955).
 *
 * Protects autonomous agents from overpaying or being drained by a malicious
 * API that keeps issuing 402 challenges.
 *
 * ### Default limits
 * - `maxPerRequest`: `1_000_000n` (1 USDC at 6 decimals)
 * - `maxPerWindow`: `10_000_000n` (10 USDC at 6 decimals)
 * - `windowMs`: `3_600_000` (1 hour)
 *
 * When a limit is exceeded, `marcFetch` throws a `BudgetExceeded` error and,
 * if provided, invokes {@link onBudgetExceeded} first.
 */
export interface BudgetOptions {
  /** Maximum amount allowed for a single request, in smallest token units. */
  maxPerRequest?: bigint;
  /** Maximum cumulative amount allowed within the rolling window, in smallest token units. */
  maxPerWindow?: bigint;
  /** Length of the rolling window in milliseconds. Defaults to 1 hour. */
  windowMs?: number;
  /** Optional hook invoked just before a `BudgetExceeded` error is thrown. */
  onBudgetExceeded?: (info: BudgetExceededInfo) => void;
}
