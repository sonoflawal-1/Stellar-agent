import {
  Contract,
  nativeToScVal,
  scValToNative,
  Address,
  xdr,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import type { Keypair } from "@stellar/stellar-sdk";
import type { CreateJobOptions, Job, MarcConfig } from "./types.js";
import { JobStatusFromNumber } from "./jobStatus.js";
import type { JobStatus } from "./jobStatus.js";
import { BaseClient } from "./baseClient.js";
import type { Signer } from "./signer.js";
import { signerPublicKey, toSigner } from "./signer.js";
import { createChannelVoucher } from "./paymentChannels.js";
import type { ChannelVoucher } from "./paymentChannels.js";
import { BearContractError } from "./errors.js";

export type { ChannelVoucher } from "./paymentChannels.js";

export interface PaymentChannelSession {
  channelId: bigint;
  createVoucher: (paymentAmount: bigint) => ChannelVoucher;
}

export interface EvaluatorProgress {
  evaluators: string[];
  threshold: number;
  approvals: number;
}

/**
 * Result of a simulation-only dry run of a write operation.
 *
 * Returned by every method on {@link CommerceClient.simulate}. Nothing is
 * submitted to the network and no funded signer is required.
 */
export interface SimulationResult<T = unknown> {
  /** The decoded return value the contract would produce. */
  result: T;
  /** Total resource fee (inclusion fee + resource fee) in stroops. */
  resourceFee: bigint;
  /** Inclusion (base) fee portion in stroops. */
  inclusionFee: bigint;
  /** Contract events the invocation would emit, decoded to native values. */
  events: Array<{ contractId?: string; topics: unknown[]; value: unknown }>;
  /** The base64-encoded, simulated (unsigned) transaction envelope. */
  transactionXdr: string;
}

/** Options accepted by {@link CommerceClient.watchJob}. */
export interface WatchJobOptions {
  /** Aborts the iterator and closes the underlying event source. */
  signal?: AbortSignal;
  /** Polling interval in milliseconds. Defaults to the client configuration. */
  pollIntervalMs?: number;
}

/** A single parsed job event yielded by {@link CommerceClient.watchJob}. */
export interface JobEvent {
  /** The job ID the event relates to. */
  jobId: bigint;
  /** The event name (e.g. `job_created`, `job_completed`). */
  type: string;
  /** The decoded event payload. */
  data: Record<string, unknown>;
  /** Ledger sequence in which the event was emitted, when known. */
  ledger?: number;
}

/** Placeholder source account used for simulation-only dry runs. */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * A single job definition for {@link CommerceClient.batchCreateJobs}.
 *
 * Mirrors the on-chain `JobRequest` struct consumed by the contract's
 * `batch_create_jobs` entry point.
 */
export interface JobRequest {
  /** The service provider's Stellar address (G...). */
  provider: string;
  /** The evaluator's Stellar address (G...). */
  evaluator: string;
  /** The token contract address (C...) used for payment. */
  token: string;
  /** The escrow amount in the token's smallest unit. Must be > 0 and fit in an i128. */
  budget: bigint;
  /** Human-readable description of the work to be done. */
  description: string;
}

/** Maximum number of jobs accepted by a single `batch_create_jobs` invocation. */
export const MAX_BATCH_JOBS = 10;

const MAX_I128 = (1n << 127n) - 1n;

// --- ScVal encoding helpers (exported for custom contract interactions) ---

/**
 * Encode a `bigint` as a Soroban `i128` ScVal.
 *
 * Use this when passing signed 128-bit integer arguments to Soroban contracts
 * that are not covered by the SDK's built-in helpers (e.g. custom token amounts).
 *
 * @param v - The integer value to encode. Must fit in a signed 128-bit integer.
 * @returns An XDR ScVal of type `i128`.
 */
export const i128ToScVal = (v: bigint) => nativeToScVal(v, { type: "i128" });

/**
 * Encode a `bigint` as a Soroban `u128` ScVal.
 *
 * @param v - The integer value to encode. Must fit in an unsigned 128-bit integer.
 * @returns An XDR ScVal of type `u128`.
 */
export const u128ToScVal = (v: bigint) => nativeToScVal(v, { type: "u128" });

/**
 * Encode a `bigint` as a Soroban `u64` ScVal.
 *
 * @param v - The integer value to encode. Must fit in an unsigned 64-bit integer.
 * @returns An XDR ScVal of type `u64`.
 */
export const u64ToScVal = (v: bigint) => nativeToScVal(v, { type: "u64" });

/**
 * Encode a `number` as a Soroban `u32` ScVal.
 *
 * @param v - The integer value to encode. Must be a non-negative 32-bit integer.
 * @returns An XDR ScVal of type `u32`.
 */
export const u32ToScVal = (v: number) => nativeToScVal(v, { type: "u32" });

/**
 * Encode a `string` as a Soroban `Symbol` or `String` ScVal.
 *
 * @param v - The string value to encode.
 * @returns An XDR ScVal of type `string`.
 */
export const strToScVal = (v: string) => nativeToScVal(v, { type: "string" });

/**
 * Encode a Stellar address string (G... or C...) as a Soroban `Address` ScVal.
 *
 * @param v - The Stellar address in StrKey format.
 * @returns An XDR ScVal of type `address`.
 */
export const addrToScVal = (v: string) => new Address(v).toScVal();

/**
 * Encode a 32-byte hash (or any byte buffer) as a Soroban `BytesN<32>` ScVal.
 *
 * @param v - The raw bytes to encode. Must be exactly 32 bytes for `BytesN<32>`.
 * @returns An XDR ScVal of type `bytes`.
 */
export const bytesToScVal = (v: Uint8Array) => nativeToScVal(v, { type: "bytes" });

/**
 * Encode a 32-byte SHA-256 digest as a Soroban `BytesN<32>` ScVal.
 *
 * @param v - The 32-byte digest to encode.
 * @returns An XDR ScVal of type `bytes`.
 * @throws {Error} If `v` is not exactly 32 bytes.
 */
export const sha256ToScVal = (v: Uint8Array) => {
  if (v.length !== 32) throw new Error("SHA-256 hash must be exactly 32 bytes");
  return nativeToScVal(v, { type: "bytes" });
};

/**
 * Compute the SHA-256 digest of a deliverable payload.
 *
 * Uses the Web Crypto API (`crypto.subtle.digest`) when available (browsers,
 * Deno, modern Node) and falls back to `node:crypto` otherwise. Accepts either
 * a `Uint8Array`/`ArrayBuffer` buffer or a UTF-8 string, which is encoded
 * before hashing.
 *
 * @param payload - The deliverable content to hash (buffer or string).
 * @returns A promise resolving to the 32-byte SHA-256 digest.
 *
 * @example
 * ```typescript
 * const hash = await computeDeliverableHash("https://ipfs.io/ipfs/Qm...");
 * await commerce.submit(providerKeypair, jobId, deliverable, hash);
 * ```
 */
export const computeDeliverableHash = async (
  payload: Uint8Array | ArrayBuffer | string,
): Promise<Uint8Array> => {
  let bytes: Uint8Array;
  if (typeof payload === "string") {
    bytes = new TextEncoder().encode(payload);
  } else if (payload instanceof Uint8Array) {
    bytes = payload;
  } else {
    bytes = new Uint8Array(payload);
  }

  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes);
    return new Uint8Array(digest);
  }

  const nodeCrypto = await import("node:crypto");
  const digest = nodeCrypto.createHash("sha256").update(bytes).digest();
  return new Uint8Array(digest);
};

// --- ScVal decoding helpers ---

/**
 * Decode a Soroban `i128` ScVal to a `bigint`.
 *
 * @param v - The XDR ScVal to decode.
 * @returns The decoded value as a `bigint` (signed 128-bit integer).
 */
export const i128FromScVal = (v: xdr.ScVal): bigint => BigInt(scValToNative(v) as string);

/**
 * Decode a Soroban `u128` ScVal to a `bigint`.
 *
 * @param v - The XDR ScVal to decode.
 * @returns The decoded value as a `bigint` (unsigned 128-bit integer).
 */
export const u128FromScVal = (v: xdr.ScVal): bigint => BigInt(scValToNative(v) as string);

/**
 * Decode a Soroban `u64` ScVal to a `bigint`.
 *
 * @param v - The XDR ScVal to decode.
 * @returns The decoded value as a `bigint` (unsigned 64-bit integer).
 */
export const u64FromScVal = (v: xdr.ScVal): bigint => BigInt(scValToNative(v) as string);

/**
 * Decode a Soroban `u32` ScVal to a `number`.
 *
 * @param v - The XDR ScVal to decode.
 * @returns The decoded value as a `number` (unsigned 32-bit integer).
 */
export const u32FromScVal = (v: xdr.ScVal): number => Number(scValToNative(v));

/**
 * Decode a Soroban `String` or `Symbol` ScVal to a JS `string`.
 *
 * @param v - The XDR ScVal to decode.
 * @returns The decoded value as a `string`.
 */
export const strFromScVal = (v: xdr.ScVal): string => scValToNative(v) as string;

/**
 * Decode a Soroban `Address` ScVal to a Stellar StrKey string (G... or C...).
 *
 * @param v - The XDR ScVal of type `address` to decode.
 * @returns The decoded Stellar address in StrKey format.
 */
export const addrFromScVal = (v: xdr.ScVal): string => Address.fromScVal(v).toString();

/**
 * Typed client for the `agentic_commerce` Soroban contract.
 *
 * Manages the full job lifecycle: create → submit → complete/cancel. Also
 * provides admin helpers (`setTreasury`, `setFeeBps`) and read-only queries
 * (`getJob`, `feeBps`, `getBalance`).
 *
 * All methods handle ScVal encoding/decoding, transaction building, signing,
 * and submission internally — callers only work with plain JS types.
 *
 * @example
 * ```typescript
 * import { CommerceClient, TESTNET } from "marc-stellar-sdk";
 * import { Keypair } from "@stellar/stellar-sdk";
 *
 * const commerce = new CommerceClient(TESTNET);
 * const clientKeypair = Keypair.fromSecret("S...");
 *
 * // Create an escrow job
 * const jobId = await commerce.createJob(
 *   clientKeypair,
 *   providerAddress,
 *   evaluatorAddress,
 *   TESTNET.usdcToken,
 *   10_000_000n,      // 10 USDC (6 decimal places)
 *   "Summarize this dataset",
 * );
 * ```
 */
export class CommerceClient extends BaseClient {
  private contract: Contract;

  constructor(cfg: MarcConfig) {
    super(cfg);
    this.contract = new Contract(cfg.commerceContract);
  }

  /**
   * Create a funded escrow job.
   *
   * Transfers `budget` tokens from `client` into contract escrow atomically.
   * The job immediately enters `Funded` status on success.
   *
   * @param client - The client's Keypair. Funds are pulled from this account.
   * @param provider - The service provider's Stellar address (G...). Will submit deliverables.
   * @param evaluator - The evaluator's Stellar address (G...). Approves completion and triggers payout.
   * @param token - The token contract address (C...) to use for payment (e.g. `TESTNET.usdcToken`).
   * @param budget - The escrow amount in the token's smallest unit (e.g. `10_000_000n` = 10 USDC).
   *                 Must be greater than 0 and fit within a signed 128-bit integer.
   * @param description - Human-readable description of the work to be done.
   * @param options - Optional memo, SLA deadline (`slaDeadline`, unix seconds, default `0n`)
   *                  and late-delivery penalty (`penaltyBpsPerHour`, default `0`).
   * @returns The new job's on-chain ID as a `bigint`.
   * @throws {Error} If `budget <= 0`, `budget` exceeds `i128` max, the client
   *                 has insufficient funds, or the transaction fails.
   *
   * @example
   * ```typescript
   * const jobId = await commerce.createJob(
   *   clientKeypair, providerAddress, evaluatorAddress,
   *   TESTNET.usdcToken, 5_000_000n, "Write a landing page",
   * );
   * ```
   */
  async createJob(
    client: Signer | Keypair,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
    options: CreateJobOptions = {},
  ): Promise<bigint> {
    if (budget <= 0n) throw new Error("budget must be greater than 0");
    if (budget > MAX_I128) throw new Error("budget exceeds i128 max");

    const signer = toSigner(client);
    const op = this.contract.call(
      "create_job",
      new Address(signerPublicKey(signer)).toScVal(),
      new Address(provider).toScVal(),
      new Address(evaluator).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(budget, { type: "i128" }),
      nativeToScVal(description, { type: "string" }),
      nativeToScVal(options.slaDeadline ?? 0n, { type: "u64" }),
      nativeToScVal(options.penaltyBpsPerHour ?? 0, { type: "u32" }),
    );
    return await this.invoke(
      signer,
      op,
      (v) => BigInt(scValToNative(v) as string),
      "commerce",
      { memo: options.memo },
    );
  }

  /**
   * Create multiple funded escrow jobs in a single atomic transaction.
   *
   * Escrows the aggregated budget for every request in one `batch_create_jobs`
   * invocation, so agent orchestrators can fund a swarm of specialized worker
   * agents without paying N base fees or risking partial failure. If any single
   * job creation fails (e.g. insufficient token allowance), the entire batch
   * reverts.
   *
   * @param client - The client's Signer. Funds are pulled from this account.
   * @param requests - Between 1 and {@link MAX_BATCH_JOBS} job definitions.
   * @returns The assigned on-chain job IDs, in the same order as `requests`.
   * @throws {Error} If `requests` is empty, exceeds {@link MAX_BATCH_JOBS}, or any
   *                 entry has a non-positive or out-of-range budget.
   *
   * @example
   * ```typescript
   * const jobIds = await commerce.batchCreateJobs(clientKeypair, [
   *   { provider: namer, evaluator, token: TESTNET.usdcToken, budget: 5_000_000n, description: "Name the product" },
   *   { provider: researcher, evaluator, token: TESTNET.usdcToken, budget: 8_000_000n, description: "Market research" },
   * ]);
   * ```
   */
  async batchCreateJobs(
    client: Signer | Keypair,
    requests: JobRequest[],
  ): Promise<bigint[]> {
    if (requests.length === 0) throw new Error("requests must contain at least one job");
    if (requests.length > MAX_BATCH_JOBS) {
      throw new Error(`requests must contain at most ${MAX_BATCH_JOBS} jobs`);
    }
    for (const request of requests) {
      if (request.budget <= 0n) throw new Error("budget must be greater than 0");
      if (request.budget > MAX_I128) throw new Error("budget exceeds i128 max");
    }

    const signer = toSigner(client);

    const requestsScVal = xdr.ScVal.scvVec(
      requests.map((request) =>
        nativeToScVal(
          {
            provider: new Address(request.provider).toScVal(),
            evaluator: new Address(request.evaluator).toScVal(),
            token: new Address(request.token).toScVal(),
            budget: nativeToScVal(request.budget, { type: "i128" }),
            description: nativeToScVal(request.description, { type: "string" }),
          },
          { type: "map" },
        ),
      ),
    );

    const op = this.contract.call(
      "batch_create_jobs",
      new Address(signerPublicKey(signer)).toScVal(),
      requestsScVal,
    );
    return await this.invoke(
      signer,
      op,
      (v) => {
        const native = scValToNative(v);
        if (!Array.isArray(native)) return [];
        return native.map((id) => BigInt(id as string));
      },
      "commerce",
    );
  }

  /** Create a high-value escrow job that requires an evaluator quorum. */
  async createJobMultiEval(
    client: Signer | Keypair,
    provider: string,
    evaluators: string[],
    threshold: number,
    token: string,
    budget: bigint,
    description: string,
  ): Promise<bigint> {
    if (budget <= 0n) throw new Error("budget must be greater than 0");
    if (budget > MAX_I128) throw new Error("budget exceeds i128 max");
    if (evaluators.length === 0 || evaluators.length > 5) {
      throw new Error("evaluators must contain between 1 and 5 addresses");
    }
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > evaluators.length) {
      throw new Error("threshold must be between 1 and the evaluator count");
    }
    if (new Set(evaluators).size !== evaluators.length) {
      throw new Error("evaluators must be unique");
    }
    const signer = toSigner(client);
    const evaluatorScVal = xdr.ScVal.scvVec(
      evaluators.map((address) => new Address(address).toScVal()),
    );
    const op = this.contract.call(
      "create_job_multi_eval",
      new Address(signerPublicKey(signer)).toScVal(),
      new Address(provider).toScVal(),
      evaluatorScVal,
      nativeToScVal(threshold, { type: "u32" }),
      new Address(token).toScVal(),
      nativeToScVal(budget, { type: "i128" }),
      nativeToScVal(description, { type: "string" }),
    );
    return await this.invoke(signer, op, (value) => BigInt(scValToNative(value) as string), "commerce");
  }

  /** Submit this evaluator's approval; the contract pays out automatically at quorum. */
  async approveJob(evaluator: Signer | Keypair, jobId: bigint): Promise<number> {
    const signer = toSigner(evaluator);
    const op = this.contract.call(
      "approve_job",
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    return await this.invoke(signer, op, (value) => Number(scValToNative(value)), "commerce");
  }

  /** Read approval progress for a multi-evaluator job, or null for a regular job. */
  async getEvaluatorProgress(jobId: bigint): Promise<EvaluatorProgress | null> {
    const op = this.contract.call("get_evaluator_progress", nativeToScVal(jobId, { type: "u64" }));
    return await this.simulateOption(op, (value) => {
      const native = scValToNative(value) as [unknown[], number, number];
      return {
        evaluators: native[0].map((address) => String(address)),
        threshold: Number(native[1]),
        approvals: Number(native[2]),
      };
    });
  }

  /** Admin: configure the budget threshold that requires evaluator quorum. */
  async setMultiEvalThreshold(admin: Signer | Keypair, threshold: bigint): Promise<void> {
    if (threshold < 0n || threshold > MAX_I128) {
      throw new Error("threshold must fit in a non-negative i128");
    }
    const signer = toSigner(admin);
    const op = this.contract.call(
      "set_multi_eval_threshold",
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(threshold, { type: "i128" }),
    );
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  /** Open an escrowed one-way channel; calls to createVoucher are entirely off-chain. */
  async openChannel(
    payer: Signer | Keypair,
    provider: string,
    deposit: bigint,
    voucherKeypair: Keypair,
    token: string = this.cfg.usdcToken,
  ): Promise<PaymentChannelSession> {
    if (deposit <= 0n || deposit > MAX_I128) {
      throw new Error("deposit must be a positive i128 amount");
    }
    const signer = toSigner(payer);
    const voucherKey = new Uint8Array(voucherKeypair.rawPublicKey());
    const op = this.contract.call(
      "open_channel",
      new Address(signerPublicKey(signer)).toScVal(),
      new Address(provider).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(deposit, { type: "i128" }),
      nativeToScVal(voucherKey, { type: "bytes" }),
    );
    const channelId = await this.invoke(
      signer,
      op,
      (value) => BigInt(scValToNative(value) as string),
      "commerce",
    );
    let amount = 0n;
    let nonce = 0n;
    return {
      channelId,
      createVoucher: (paymentAmount) => {
        if (paymentAmount <= 0n) throw new Error("payment amount must be greater than 0");
        const nextAmount = amount + paymentAmount;
        if (nextAmount > deposit) throw new Error("channel deposit exceeded");
        if (nonce === (1n << 64n) - 1n) throw new Error("channel voucher nonce exhausted");
        amount = nextAmount;
        nonce += 1n;
        return createChannelVoucher(channelId, amount, nonce, voucherKeypair);
      },
    };
  }

  /** Either participant submits the best voucher to begin or update the challenge window. */
  async closeChannel(
    channelId: bigint,
    voucher: ChannelVoucher,
    participant: Signer | Keypair,
  ): Promise<void> {
    if (voucher.channelId !== channelId) throw new Error("voucher channel ID does not match");
    const signer = toSigner(participant);
    const voucherScVal = nativeToScVal(
      {
        channel_id: nativeToScVal(voucher.channelId, { type: "u64" }),
        amount: nativeToScVal(voucher.amount, { type: "i128" }),
        nonce: nativeToScVal(voucher.nonce, { type: "u64" }),
      },
      { type: "map" },
    );
    const op = this.contract.call(
      "close_channel",
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(channelId, { type: "u64" }),
      voucherScVal,
      nativeToScVal(voucher.signature, { type: "bytes" }),
    );
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  /** Settle a channel after its 24-hour challenge window has elapsed. */
  async forceClose(caller: Signer | Keypair, channelId: bigint): Promise<void> {
    const signer = toSigner(caller);
    const op = this.contract.call(
      "force_close",
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(channelId, { type: "u64" }),
    );
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  async estimateCreateJobFee(
    client: Signer | Keypair,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
  ): Promise<bigint> {
    const op = this.contract.call(
      "create_job",
      new Address(signerPublicKey(toSigner(client))).toScVal(),
      new Address(provider).toScVal(),
      new Address(evaluator).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(budget, { type: "i128" }),
      nativeToScVal(description, { type: "string" }),
    );
    return this.estimateOperationFee(op);
  }

  /**
   * Create a funded escrow job and wait for on-chain confirmation.
   *
   * Functionally identical to {@link createJob} — included for API symmetry
   * with patterns that distinguish "fire-and-forget" from "wait for finality".
   *
   * @param client - The client's Signer. Funds are pulled from this account.
   * @param provider - The service provider's Stellar address (G...).
   * @param evaluator - The evaluator's Stellar address (G...).
   * @param token - The token contract address (C...) for payment.
   * @param budget - The escrow amount in the token's smallest unit.
   * @param description - Human-readable description of the work.
   * @param options - Optional memo, SLA deadline and late-delivery penalty (see {@link createJob}).
   * @returns The new job's on-chain ID as a `bigint`, resolved after on-chain finality.
   * @throws {Error} If `budget <= 0`, `budget` exceeds `i128` max, or the transaction fails.
   */
  async createJobAndWait(
    client: Signer | Keypair,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
    options: CreateJobOptions = {},
  ): Promise<bigint> {
    return this.createJob(client, provider, evaluator, token, budget, description, options);
  }

  /**
   * Check the current token allowance granted from `owner` to `spender`.
   *
   * @param owner - The token owner's Stellar address.
   * @param spender - The approved spender's Stellar address (e.g. commerce contract).
   * @param token - The SAC token contract address.
   * @returns The current allowance as a `bigint`.
   */
  async allowance(owner: string, spender: string, token: string): Promise<bigint> {
    const tokenContract = new Contract(token);
    const op = tokenContract.call(
      "allowance",
      new Address(owner).toScVal(),
      new Address(spender).toScVal(),
    );
    return await this.simulate(op, (v) => BigInt(scValToNative(v) as string));
  }

  /**
   * Submit an `approve` operation on the token contract to set an allowance for `spender`.
   *
   * @param client - The account granting the allowance (Signer).
   * @param spender - The address authorized to spend tokens (e.g. commerce contract).
   * @param token - The SAC token contract address.
   * @param amount - The approved allowance amount in smallest token units.
   * @param expirationLedger - Optional expiration ledger sequence. Defaults to current + 1000.
   */
  async approve(
    client: Signer | Keypair,
    spender: string,
    token: string,
    amount: bigint,
    expirationLedger?: number,
  ): Promise<void> {
    const signer = toSigner(client);
    const clientAddr = signerPublicKey(signer);
    const tokenContract = new Contract(token);
    let liveUntil = expirationLedger;
    if (!liveUntil) {
      try {
        const latest = await this.server.getLatestLedger();
        liveUntil = latest.sequence + 1000;
      } catch {
        liveUntil = 100_000_000;
      }
    }
    const op = tokenContract.call(
      "approve",
      new Address(clientAddr).toScVal(),
      new Address(spender).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(liveUntil, { type: "u32" }),
    );
    await this.invoke(signer, op, () => undefined, "token:approve");
  }

  /**
   * Check token allowance for the commerce escrow contract, submit an approval transaction
   * if allowance is insufficient, and then create and fund the job (#546).
   *
   * Works cleanly with both Keypair and WalletSigner.
   *
   * @param client - The client's Signer (Keypair or WalletSigner).
   * @param provider - The service provider's Stellar address.
   * @param evaluator - The evaluator's Stellar address.
   * @param token - The token contract address for payment.
   * @param budget - The escrow budget in smallest token units.
   * @param description - Human-readable description of the work.
   * @param options - Optional memo, SLA deadline and late-delivery penalty (see {@link createJob}).
   * @returns The newly created job ID as a `bigint`.
   */
  async approveAndCreateJob(
    client: Signer | Keypair,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
    options: CreateJobOptions = {},
  ): Promise<bigint> {
    if (budget <= 0n) throw new Error("budget must be greater than 0");
    if (budget > MAX_I128) throw new Error("budget exceeds i128 max");

    const signer = toSigner(client);
    const clientAddress = signerPublicKey(signer);
    let currentAllowance = 0n;
    try {
      currentAllowance = await this.allowance(
        clientAddress,
        this.contract.address().toString(),
        token,
      );
    } catch {
      currentAllowance = 0n;
    }

    if (currentAllowance < budget) {
      await this.approve(signer, this.contract.address().toString(), token, budget);
    }

    return await this.createJob(signer, provider, evaluator, token, budget, description, options);
  }

  /**
   * Helper alias for {@link approveAndCreateJob} (#546).
   */
  async createJobWithApproval(
    client: Signer | Keypair,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
  ): Promise<bigint> {
    return this.approveAndCreateJob(client, provider, evaluator, token, budget, description);
  }

  /**
   * Provider submits a deliverable URL or content for a funded job.
   *
   * Transitions the job from `Funded` → `Submitted` status. Only the assigned
   * provider address can call this method successfully.
   *
   * @param provider - The provider's Signer. Must match the job's `provider` field.
   * @param jobId - The ID of the job to submit a deliverable for.
   * @param deliverable - URL or content string representing the completed work
   *                      (e.g. an IPFS URL, a raw text summary, or a hosted file link).
   * @param deliverableHash - Optional 32-byte SHA-256 content hash of the deliverable
   *                          payload. When omitted, the hash is computed automatically
   *                          from the `deliverable` string via {@link computeDeliverableHash}.
   * @returns A promise that resolves when the submission is confirmed on-chain.
   * @throws {Error} If the signer is not the assigned provider, the job is not in
   *                 `Funded` status, the hash is not 32 bytes, or the transaction fails.
   *
   * @example
   * ```typescript
   * await commerce.submit(providerKeypair, jobId, "https://ipfs.io/ipfs/Qm...");
   * // or with a pre-computed hash of the actual deliverable buffer:
   * const hash = await computeDeliverableHash(deliverableBuffer);
   * await commerce.submit(providerKeypair, jobId, "https://ipfs.io/ipfs/Qm...", hash);
   * ```
   */
  async submit(
    provider: Signer | Keypair,
    jobId: bigint,
    deliverable: string,
    deliverableHash?: Uint8Array,
  ): Promise<void> {
    const signer = toSigner(provider);
    const hash = deliverableHash ?? (await computeDeliverableHash(deliverable));
    const op = this.contract.call(
      "submit",
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
      nativeToScVal(deliverable, { type: "string" }),
      sha256ToScVal(hash),
    );
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  /**
   * Evaluator marks a submitted job as complete and triggers the payout.
   *
   * Transitions the job from `Submitted` → `Completed`. Funds are split:
   * 99% to the provider, 1% (or the configured fee) to the treasury.
   * Only the assigned evaluator address can call this.
   *
   * @param evaluator - The evaluator's Signer. Must match the job's `evaluator` field.
   * @param jobId - The ID of the job to complete.
   * @param expectedHash - Optional 32-byte SHA-256 hash the evaluator asserts matches
   *                       the stored deliverable hash. When provided, the contract
   *                       rejects the call if it does not match the submitted hash.
   * @returns A promise that resolves when completion and payout are confirmed on-chain.
   * @throws {Error} If the signer is not the assigned evaluator, the job is not in
   *                 `Submitted` status, the asserted hash does not match, or the
   *                 transaction fails.
   *
   * @example
   * ```typescript
   * await commerce.complete(evaluatorKeypair, jobId);
   * // or attesting to the evaluated content:
   * await commerce.complete(evaluatorKeypair, jobId, expectedHash);
   * ```
   */
  async complete(
    evaluator: Signer | Keypair,
    jobId: bigint,
    expectedHash?: Uint8Array,
  ): Promise<void> {
    const signer = toSigner(evaluator);
    const args: xdr.ScVal[] = [
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    ];
    if (expectedHash !== undefined) {
      args.push(sha256ToScVal(expectedHash));
    }
    const op = this.contract.call("complete", ...args);
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  /**
   * Client cancels a funded job and receives a full refund.
   *
   * Transitions the job to `Cancelled` status and returns the full budget
   * to the client. Only the original client address can cancel a job, and
   * only while it is in `Funded` or `Submitted` status.
   *
   * @param client - The client's Signer. Must match the job's `client` field.
   * @param jobId - The ID of the job to cancel.
   * @returns A promise that resolves when the cancellation and refund are confirmed on-chain.
   * @throws {Error} If the signer is not the job's client, the job is not cancellable,
   *                 or the transaction fails.
   *
   * @example
   * ```typescript
   * await commerce.cancel(clientKeypair, jobId);
   * ```
   */
  async cancel(client: Signer | Keypair, jobId: bigint): Promise<void> {
    const signer = toSigner(client);
    const op = this.contract.call(
      "cancel",
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  async dispute(client: Signer | Keypair, jobId: bigint): Promise<void> {
    const signer = toSigner(client);
    const op = this.contract.call(
      "dispute",
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  async claimRefund(client: Signer | Keypair, jobId: bigint): Promise<void> {
    const signer = toSigner(client);
    const op = this.contract.call(
      "claim_refund",
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  async claimExpired(provider: Signer | Keypair, jobId: bigint): Promise<void> {
    const signer = toSigner(provider);
    const op = this.contract.call(
      "claim_expired",
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  /**
   * Fetch a job record by its on-chain ID.
   *
   * Returns `null` only when the contract confirms the job does not exist.
   * Throws on RPC/network errors so callers can distinguish "not found" from "outage".
   *
   * @param jobId - The on-chain job ID (as returned by {@link createJob}).
   * @returns The {@link Job} record if found, or `null` if no job exists with that ID.
   * @throws {Error} On RPC/network failure.
   *
   * @example
   * ```typescript
   * const job = await commerce.getJob(42n);
   * if (job) {
   *   console.log(job.status, job.budget);
   * }
   * ```
   */
  async getJob(jobId: bigint): Promise<Job | null> {
    const op = this.contract.call("get_job", nativeToScVal(jobId, { type: "u64" }));
    return await this.simulateOption(op, (v) => {
      const native = scValToNative(v);
      return {
        id: BigInt(native.id),
        client: native.client,
        provider: native.provider,
        evaluator: native.evaluator,
        token: native.token,
        budget: BigInt(native.budget),
        status: (Array.isArray(native.status)
          ? native.status[0]
          : typeof native.status === "number"
            ? JobStatusFromNumber[native.status] ?? native.status
            : native.status) as JobStatus,
        description: native.description,
        deliverable: native.deliverable,
        funded_at: BigInt(native.funded_at ?? 0),
        created_at: BigInt(native.created_at ?? 0),
        updated_at: BigInt(native.updated_at ?? 0),
      } as Job;
    });
  }

  /**
   * Fetch all jobs assigned to a specific provider.
   *
   * Calls `jobs_by_provider` on the commerce contract.
   *
   * @param provider - Stellar public key (G...) of the provider.
   * @param startId - Starting job ID to scan from (default: 1n).
   * @param limit - Maximum number of jobs to return (default: 100).
   * @returns Array of jobs assigned to the provider.
   */
  async jobsByProvider(
    provider: string,
    startId: bigint = 1n,
    limit: number = 100,
  ): Promise<Job[]> {
    const op = this.contract.call(
      "jobs_by_provider",
      new Address(provider).toScVal(),
      nativeToScVal(startId, { type: "u64" }),
      nativeToScVal(limit, { type: "u32" }),
    );
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      if (!Array.isArray(native)) return [];
      return native.map((j: any) => ({
        id: BigInt(j.id),
        client: j.client,
        provider: j.provider,
        evaluator: j.evaluator,
        token: j.token,
        budget: BigInt(j.budget),
        status: (Array.isArray(j.status)
          ? j.status[0]
          : typeof j.status === "number"
            ? JobStatusFromNumber[j.status] ?? j.status
            : j.status) as JobStatus,
        description: j.description,
        deliverable: j.deliverable,
        funded_at: BigInt(j.funded_at ?? 0),
        created_at: BigInt(j.created_at ?? 0),
        updated_at: BigInt(j.updated_at ?? 0),
      })) as Job[];
    });
  }

  /** Alias for jobsByProvider matching contract snake_case naming */
  async jobs_by_provider(
    provider: string,
    startId: bigint = 1n,
    limit: number = 100,
  ): Promise<Job[]> {
    return this.jobsByProvider(provider, startId, limit);
  }

  /**
   * Fetch all jobs assigned to a specific provider.
   *
   * Typed alias for {@link jobsByProvider} with the method name from the
   * issue spec (#543). Calls `jobs_by_provider` on the commerce contract.
   *
   * @param provider - Stellar public key (G...) of the provider.
   * @param startId - Starting job ID to scan from (default: 1n).
   * @param limit - Maximum number of jobs to return (default: 100).
   * @returns Array of jobs assigned to the provider.
   */
  async getJobsByProvider(
    provider: string,
    startId: bigint = 1n,
    limit: number = 100,
  ): Promise<Job[]> {
    return this.jobsByProvider(provider, startId, limit);
  }

  /**
   * Fetch all jobs created by a specific client.
   *
   * Calls `jobs_by_client` on the commerce contract, scanning forward from
   * `startId` (#543).
   *
   * @param client - Stellar public key (G...) of the client.
   * @param startId - Starting job ID to scan from (default: 1n).
   * @param limit - Maximum number of jobs to return (default: 100).
   * @returns Array of jobs created by the client.
   */
  async getJobsByClient(
    client: string,
    startId: bigint = 1n,
    limit: number = 100,
  ): Promise<Job[]> {
    const op = this.contract.call(
      "jobs_by_client",
      new Address(client).toScVal(),
      nativeToScVal(startId, { type: "u64" }),
      nativeToScVal(limit, { type: "u32" }),
    );
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      if (!Array.isArray(native)) return [];
      return native.map((j: any) => ({
        id: BigInt(j.id),
        client: j.client,
        provider: j.provider,
        evaluator: j.evaluator,
        token: j.token,
        budget: BigInt(j.budget),
        status: (Array.isArray(j.status)
          ? j.status[0]
          : typeof j.status === "number"
            ? JobStatusFromNumber[j.status] ?? j.status
            : j.status) as JobStatus,
        description: j.description,
        deliverable: j.deliverable,
        funded_at: BigInt(j.funded_at ?? 0),
        created_at: BigInt(j.created_at ?? 0),
        updated_at: BigInt(j.updated_at ?? 0),
      })) as Job[];
    });
  }

  /**
   * List jobs with optional pagination (#542).
   *
   * Reads the total job count via `job_count`, then fetches jobs in parallel
   * batches starting from `startId`. Null/missing jobs are filtered out.
   *
   * @param options.startId - First job ID to include (default: 1n).
   * @param options.limit - Maximum number of jobs to return (default: 20).
   * @returns Array of Job objects, ordered by ID ascending.
   *
   * @example
   * ```typescript
   * // First page of 10 jobs
   * const page1 = await commerce.listJobs({ startId: 1n, limit: 10 });
   * // Next page
   * const page2 = await commerce.listJobs({ startId: 11n, limit: 10 });
   * ```
   */
  async listJobs(options: { startId?: bigint; limit?: number } = {}): Promise<Job[]> {
    const startId = options.startId ?? 1n;
    const limit = options.limit ?? 20;

    // Clamp limit to a sensible max to avoid unbounded parallel requests.
    const effectiveLimit = Math.min(limit, 100);

    let totalCount: bigint;
    try {
      totalCount = await this.jobCount();
    } catch {
      return [];
    }

    if (totalCount === 0n) return [];

    // Determine the range of IDs to fetch.
    const maxId = totalCount; // IDs are 1-based, so last ID == totalCount
    if (startId > maxId) return [];

    const endId = startId + BigInt(effectiveLimit) - 1n;
    const clampedEnd = endId > maxId ? maxId : endId;

    // Fetch all jobs in the range in parallel.
    const promises: Promise<Job | null>[] = [];
    for (let id = startId; id <= clampedEnd; id++) {
      promises.push(this.getJob(id));
    }

    const results = await Promise.all(promises);
    return results.filter((j): j is Job => j !== null);
  }

  async jobCount(): Promise<bigint> {
    const op = this.contract.call("job_count");
    return await this.simulate(op, (v) => BigInt(scValToNative(v) as string));
  }

  /**
   * Read the current protocol fee in basis points (bps).
   *
   * 100 bps = 1%. The contract caps the fee at 500 bps (5%).
   * Default is 100 bps (1%).
   *
   * @returns The fee as a `number` (e.g. `100` for 1%).
   * @throws {Error} On RPC/network failure.
   */
  async feeBps(): Promise<number> {
    const op = this.contract.call("fee_bps");
    return await this.simulate(op, (v) => Number(scValToNative(v)));
  }

  /**
   * Admin: update the treasury address that receives protocol fees.
   *
   * Only the contract admin can call this function. The treasury receives
   * the `feeBps` portion of each completed job's budget.
   *
   * @param admin - The admin's Signer (must be the contract's configured admin).
   * @param newTreasury - The new treasury's Stellar address (G...).
   * @returns A promise that resolves when the update is confirmed on-chain.
   * @throws {Error} If the signer is not the admin or the transaction fails.
   *
   * @example
   * ```typescript
   * await commerce.setTreasury(adminKeypair, "GABC...");
   * ```
   */
  async setTreasury(admin: Signer | Keypair, newTreasury: string): Promise<void> {
    const signer = toSigner(admin);
    const op = this.contract.call(
      "set_treasury",
      new Address(signerPublicKey(signer)).toScVal(),
      new Address(newTreasury).toScVal(),
    );
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  /**
   * Admin: update the protocol fee rate in basis points.
   *
   * The contract enforces a maximum of 500 bps (5%). Setting a higher value
   * will be rejected by the contract.
   *
   * @param admin - The admin's Signer (must be the contract's configured admin).
   * @param newBps - The new fee in basis points (0–500). E.g. `100` = 1%.
   * @returns A promise that resolves when the fee update is confirmed on-chain.
   * @throws {Error} If the signer is not the admin, `newBps > 500`, or the transaction fails.
   *
   * @example
   * ```typescript
   * await commerce.setFeeBps(adminKeypair, 50); // 0.5%
   * ```
   */
  async setFeeBps(admin: Signer | Keypair, newBps: number): Promise<void> {
    const signer = toSigner(admin);
    const op = this.contract.call(
      "set_fee_bps",
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(newBps, { type: "u32" }),
    );
    await this.invoke(signer, op, () => undefined, "commerce");
  }

  /**
   * Get the token balance of an address.
   *
   * Supports both native XLM and any Soroban token contract (SAC or custom).
   *
   * @param address - The Stellar address (G...) to query.
   * @param token - Either `"native"` for XLM (returns stroops as `bigint`),
   *                or a Soroban token contract address (C...) for SAC/custom tokens.
   * @returns The balance as a `bigint` in the smallest unit of the token
   *          (stroops for XLM, micro-USDC for USDC, etc.).
   * @throws {Error} On RPC failure or if the address does not exist on-chain.
   *
   * @example
   * ```typescript
   * // USDC balance
   * const balance = await commerce.getBalance("GABC...", TESTNET.usdcToken);
   * console.log("Balance (micro-USDC):", balance);
   * ```
   */
  async getBalance(address: string, token: string): Promise<bigint> {
    if (token === "native") {
      const account = await this.server.getAccount(address);
      const balances =
        (account as unknown as { balances?: Array<{ asset_type?: string; balance?: string }> })
          .balances ?? [];
      const xlmBalance = balances.find((b) => b.asset_type === "native");
      return BigInt(Math.round(Number(xlmBalance?.balance ?? "0") * 1e7));
    }
    const tokenContract = new Contract(token);
    const op = tokenContract.call("balance", new Address(address).toScVal());
    return await this.simulate(op, (v) => BigInt(scValToNative(v) as string));
  }

  // -------------------------------------------------------------------------
  // #780 — Offline transaction preparation (air-gapped / multisig workflows)
  // -------------------------------------------------------------------------

  /**
   * Build and simulate a `create_job` transaction, returning the **unsigned**
   * XDR string for offline or multisig signing.
   *
   * No private key is required — pass only the *public address* of the client
   * that will eventually sign. The transaction is simulated against the network
   * to attach the Soroban resource footprint and fee, but is never submitted.
   *
   * ### Air-gapped workflow
   * ```typescript
   * // 1. Online: prepare the unsigned XDR
   * const unsignedXdr = await commerce.prepareCreateJob(
   *   clientAddress, provider, evaluator, token, 10_000_000n, "Build a website",
   * );
   *
   * // 2. Offline: sign with Ledger / HSM / multisig vault
   * const signedXdr = await ledgerDevice.sign(unsignedXdr);
   *
   * // 3. Online: broadcast the signed XDR
   * const txHash = await commerce.submitSignedXdr(signedXdr);
   * ```
   *
   * @param clientAddress - Stellar public key (G...) of the client account.
   * @param provider      - Provider's Stellar address.
   * @param evaluator     - Evaluator's Stellar address.
   * @param token         - Token contract address.
   * @param budget        - Escrow amount in smallest token units.
   * @param description   - Human-readable job description.
   * @returns Base64-encoded unsigned Soroban transaction XDR.
   */
  async prepareCreateJob(
    clientAddress: string,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
  ): Promise<string> {
    if (budget <= 0n) throw new Error("budget must be greater than 0");
    if (budget > MAX_I128) throw new Error("budget exceeds i128 max");

    const op = this.contract.call(
      "create_job",
      new Address(clientAddress).toScVal(),
      new Address(provider).toScVal(),
      new Address(evaluator).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(budget, { type: "i128" }),
      nativeToScVal(description, { type: "string" }),
    );

    return this.rpcCall(async (server) => {
      const account = await server.getAccount(clientAddress);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.cfg.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();
      const prepared = await server.prepareTransaction(tx);
      return prepared.toXDR();
    });
  }

  /**
   * Build and simulate a `submit` transaction, returning unsigned XDR for
   * offline signing (#780).
   *
   * @param providerAddress - Stellar public key of the provider.
   * @param jobId           - On-chain job ID.
   * @param deliverable     - URL or content string for the completed work.
   * @param deliverableHash - Optional 32-byte SHA-256 content hash of the deliverable
   *                          payload. Computed automatically from `deliverable` when omitted.
   * @returns Base64-encoded unsigned Soroban transaction XDR.
   */
  async prepareSubmit(
    providerAddress: string,
    jobId: bigint,
    deliverable: string,
    deliverableHash?: Uint8Array,
  ): Promise<string> {
    const hash = deliverableHash ?? (await computeDeliverableHash(deliverable));
    const op = this.contract.call(
      "submit",
      new Address(providerAddress).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
      nativeToScVal(deliverable, { type: "string" }),
      sha256ToScVal(hash),
    );

    return this.rpcCall(async (server) => {
      const account = await server.getAccount(providerAddress);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.cfg.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();
      const prepared = await server.prepareTransaction(tx);
      return prepared.toXDR();
    });
  }

  /**
   * Build and simulate a `complete` transaction, returning unsigned XDR for
   * offline signing (#780).
   *
   * @param evaluatorAddress - Stellar public key of the evaluator.
   * @param jobId            - On-chain job ID.
   * @param expectedHash     - Optional 32-byte SHA-256 hash the evaluator asserts
   *                           matches the stored deliverable hash.
   * @returns Base64-encoded unsigned Soroban transaction XDR.
   */
  async prepareComplete(
    evaluatorAddress: string,
    jobId: bigint,
    expectedHash?: Uint8Array,
  ): Promise<string> {
    const args: xdr.ScVal[] = [
      new Address(evaluatorAddress).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    ];
    if (expectedHash !== undefined) {
      args.push(sha256ToScVal(expectedHash));
    }
    const op = this.contract.call("complete", ...args);

    return this.rpcCall(async (server) => {
      const account = await server.getAccount(evaluatorAddress);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.cfg.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();
      const prepared = await server.prepareTransaction(tx);
      return prepared.toXDR();
    });
  }

  /**
   * Submit a pre-signed XDR transaction to the network and poll for finality.
   *
   * The transaction must already be fully signed (by a Ledger device, cold
   * wallet, or multisig flow) and base64-encoded. Routes through the RPC
   * failover pool for reliability (#780, #781).
   *
   * @param signedXdr - Base64-encoded signed transaction XDR.
   * @returns The transaction hash once confirmed on-chain.
   * @throws {Error} If the transaction is rejected or times out.
   */
  async submitSignedXdr(signedXdr: string): Promise<string> {
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.cfg.networkPassphrase);
    const sent = await this.rpcCall((s) => s.sendTransaction(signedTx));

    if (sent.status === "ERROR") {
      throw new Error(`submitSignedXdr: submit failed: ${sent.errorResult}`);
    }

    const startTime = Date.now();
    const timeoutMs = this.cfg.pollTimeoutMs ?? 60_000;
    let getResp = await this.rpcCall((s) => s.getTransaction(sent.hash));
    while (getResp.status === "NOT_FOUND") {
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error(`submitSignedXdr: timed out polling for tx ${sent.hash}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await this.rpcCall((s) => s.getTransaction(sent.hash));
    }
    if (getResp.status !== "SUCCESS") {
      throw new Error(`submitSignedXdr: tx failed with status ${getResp.status}`);
    }
    this.cfg.onTx?.(sent.hash, "submitSignedXdr");
    return sent.hash;
  }

  // -------------------------------------------------------------------------

  /**
   * Create a milestone-based escrow job.
   *
   * The `milestones` array defines sequential deliverables. The sum of all
   * milestone `amount` values must equal `budget` exactly — the contract
   * enforces this invariant and will reject the transaction if it is violated.
   *
   * @param client - The client's Signer. Funds are pulled from this account.
   * @param provider - The provider's Stellar address.
   * @param evaluator - The evaluator's Stellar address.
   * @param token - Token contract address for payment.
   * @param budget - Total escrow budget (must equal sum of milestone amounts).
   * @param description - Overall job description.
   * @param milestones - Ordered list of milestone definitions.
   * @returns The new job's on-chain ID as a `bigint`.
   */
  async createMilestoneJob(
    client: Signer | Keypair,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
    milestones: Array<{ amount: bigint; description: string }>,
  ): Promise<bigint> {
    if (budget <= 0n) throw new Error('budget must be greater than 0');
    if (budget > MAX_I128) throw new Error('budget exceeds i128 max');
    if (milestones.length === 0 || milestones.length > 20) {
      throw new Error('milestones must contain between 1 and 20 entries');
    }
    const total = milestones.reduce((acc, m) => acc + m.amount, 0n);
    if (total !== budget) throw new Error('sum of milestone amounts must equal budget');

    const signer = toSigner(client);

    // Encode milestones as a Soroban Vec<Milestone>
    const milestoneScVals = milestones.map((m, i) =>
      nativeToScVal(
        {
          index: nativeToScVal(i, { type: 'u32' }),
          amount: nativeToScVal(m.amount, { type: 'i128' }),
          description: nativeToScVal(m.description, { type: 'string' }),
          deliverable: nativeToScVal('', { type: 'string' }),
          approved: nativeToScVal(false, { type: 'bool' }),
        },
        { type: 'map' },
      ),
    );
    const milestonesScVal = xdr.ScVal.scvVec(milestoneScVals);

    const op = this.contract.call(
      'create_milestone_job',
      new Address(signerPublicKey(signer)).toScVal(),
      new Address(provider).toScVal(),
      new Address(evaluator).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(budget, { type: 'i128' }),
      nativeToScVal(description, { type: 'string' }),
      milestonesScVal,
    );
    return await this.invoke(signer, op, (v) => BigInt(scValToNative(v) as string), 'commerce');
  }

  /**
   * Provider submits a deliverable for a specific milestone.
   *
   * @param provider - The provider's Signer.
   * @param jobId - The milestone job's on-chain ID.
   * @param milestoneIdx - Zero-based index of the milestone to submit.
   * @param deliverable - URI or content string of the completed deliverable.
   * @param deliverableHash - Optional 32-byte SHA-256 content hash of the deliverable
   *                          payload. Computed automatically from `deliverable` when omitted.
   */
  async submitMilestone(
    provider: Signer | Keypair,
    jobId: bigint,
    milestoneIdx: number,
    deliverable: string,
    deliverableHash?: Uint8Array,
  ): Promise<void> {
    const signer = toSigner(provider);
    const hash = deliverableHash ?? (await computeDeliverableHash(deliverable));
    const op = this.contract.call(
      'submit_milestone',
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(jobId, { type: 'u64' }),
      nativeToScVal(milestoneIdx, { type: 'u32' }),
      nativeToScVal(deliverable, { type: 'string' }),
      sha256ToScVal(hash),
    );
    await this.invoke(signer, op, () => undefined, 'commerce');
  }

  /**
   * Evaluator approves a milestone, releasing proportional funds to the provider.
   *
   * @param evaluator - The evaluator's Signer.
   * @param jobId - The milestone job's on-chain ID.
   * @param milestoneIdx - Zero-based index of the milestone to approve.
   */
  async approveMilestone(
    evaluator: Signer | Keypair,
    jobId: bigint,
    milestoneIdx: number,
  ): Promise<void> {
    const signer = toSigner(evaluator);
    const op = this.contract.call(
      'approve_milestone',
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(jobId, { type: 'u64' }),
      nativeToScVal(milestoneIdx, { type: 'u32' }),
    );
    await this.invoke(signer, op, () => undefined, 'commerce');
  }

  /**
   * Client cancels all uncompleted milestones and gets a refund of unreleased funds.
   * Already-approved milestones are preserved.
   *
   * @param client - The client's Signer.
   * @param jobId - The milestone job's on-chain ID.
   */
  async cancelUncompletedMilestones(client: Signer | Keypair, jobId: bigint): Promise<void> {
    const signer = toSigner(client);
    const op = this.contract.call(
      'cancel_uncompleted_milestones',
      new Address(signerPublicKey(signer)).toScVal(),
      nativeToScVal(jobId, { type: 'u64' }),
    );
    await this.invoke(signer, op, () => undefined, 'commerce');
  }

  /**
   * Fetch the milestone list for a job.
   *
   * @param jobId - The milestone job's on-chain ID.
   * @returns Array of Milestone objects, or null if not a milestone job.
   */
  async getMilestones(jobId: bigint): Promise<import('./types.js').Milestone[] | null> {
    const op = this.contract.call('get_milestones', nativeToScVal(jobId, { type: 'u64' }));
    return await this.simulateOption(op, (v) => {
      const native = scValToNative(v);
      if (!Array.isArray(native)) return [];
      return native.map((m: Record<string, unknown>) => ({
        index: Number(m.index),
        amount: BigInt(m.amount as string),
        description: String(m.description),
        deliverable: String(m.deliverable ?? ''),
        approved: Boolean(m.approved),
      })) as import('./types.js').Milestone[];
    });
  }

  // -------------------------------------------------------------------------
  // #950 — Async iterator over job events
  // -------------------------------------------------------------------------

  /**
   * Watch a job's lifecycle events as an async iterator.
   *
   * Built on the same polling/stream core as `subscribeJob`, but yields parsed
   * {@link JobEvent} objects instead of invoking callbacks. The iterator ends
   * cleanly when the supplied {@link AbortSignal} fires, closing the underlying
   * event source.
   *
   * @param jobId - The on-chain job ID to watch.
   * @param options - Optional abort signal and polling interval.
   * @returns An async generator yielding {@link JobEvent} objects.
   *
   * @example
   * ```typescript
   * const controller = new AbortController();
   * for await (const ev of commerce.watchJob(jobId, { signal: controller.signal })) {
   *   console.log(ev.type, ev.data);
   *   if (ev.type === "job_completed") controller.abort();
   * }
   * ```
   */
  async *watchJob(jobId: bigint, options: WatchJobOptions = {}): AsyncGenerator<JobEvent> {
    const { signal, pollIntervalMs } = options;
    if (signal?.aborted) return;

    const queue: JobEvent[] = [];
    let notify: (() => void) | null = null;
    let closed = false;

    const push = (event: JobEvent) => {
      if (closed) return;
      queue.push(event);
      notify?.();
    };

    const close = () => {
      if (closed) return;
      closed = true;
      notify?.();
    };

    const unsubscribe = this.subscribeJob(jobId, (event) => {
      push({
        jobId,
        type: String((event as { type?: unknown }).type ?? "update"),
        data: (event as { data?: Record<string, unknown> }).data ?? {},
        ledger: (event as { ledger?: number }).ledger,
      });
    });

    const onAbort = () => {
      unsubscribe();
      close();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (!closed) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
          if (pollIntervalMs !== undefined) {
            setTimeout(resolve, pollIntervalMs);
          }
        });
        notify = null;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (!closed) {
        unsubscribe();
        closed = true;
      }
    }
  }

  // -------------------------------------------------------------------------
  // #951 — Simulation-only dry runs for every write
  // -------------------------------------------------------------------------

  /**
   * Simulation-only dry-run helpers for every write operation.
   *
   * Each method builds the exact same contract operation as its write
   * counterpart but only simulates it — nothing is submitted and no funded
   * signer is required. Contract failures are surfaced as
   * {@link BearContractError}; success returns a {@link SimulationResult}
   * containing resource fees, expected events and the decoded return value.
   *
   * @example
   * ```typescript
   * const sim = await commerce.simulate.createJob(
   *   clientAddress, provider, evaluator, TESTNET.usdcToken, 10_000_000n, "Do work",
   * );
   * console.log(sim.resourceFee, sim.events);
   * ```
   */
  readonly simulate = {
    createJob: (
      clientAddress: string,
      provider: string,
      evaluator: string,
      token: string,
      budget: bigint,
      description: string,
      options: CreateJobOptions = {},
    ): Promise<SimulationResult<bigint>> => {
      if (budget <= 0n) throw new Error("budget must be greater than 0");
      if (budget > MAX_I128) throw new Error("budget exceeds i128 max");
      const op = this.contract.call(
        "create_job",
        new Address(clientAddress).toScVal(),
        new Address(provider).toScVal(),
        new Address(evaluator).toScVal(),
        new Address(token).toScVal(),
        nativeToScVal(budget, { type: "i128" }),
        nativeToScVal(description, { type: "string" }),
        nativeToScVal(options.slaDeadline ?? 0n, { type: "u64" }),
        nativeToScVal(options.penaltyBpsPerHour ?? 0, { type: "u32" }),
      );
      return this.runSimulation(op, (v) => BigInt(scValToNative(v) as string));
    },

    batchCreateJobs: (
      clientAddress: string,
      requests: JobRequest[],
    ): Promise<SimulationResult<bigint[]>> => {
      if (requests.length === 0) throw new Error("requests must contain at least one job");
      if (requests.length > MAX_BATCH_JOBS) {
        throw new Error(`requests must contain at most ${MAX_BATCH_JOBS} jobs`);
      }
      for (const request of requests) {
        if (request.budget <= 0n) throw new Error("budget must be greater than 0");
        if (request.budget > MAX_I128) throw new Error("budget exceeds i128 max");
      }
      const requestsScVal = xdr.ScVal.scvVec(
        requests.map((request) =>
          nativeToScVal(
            {
              provider: new Address(request.provider).toScVal(),
              evaluator: new Address(request.evaluator).toScVal(),
              token: new Address(request.token).toScVal(),
              budget: nativeToScVal(request.budget, { type: "i128" }),
              description: nativeToScVal(request.description, { type: "string" }),
            },
            { type: "map" },
          ),
        ),
      );
      const op = this.contract.call(
        "batch_create_jobs",
        new Address(clientAddress).toScVal(),
        requestsScVal,
      );
      return this.runSimulation(op, (v) => {
        const native = scValToNative(v);
        if (!Array.isArray(native)) return [];
        return native.map((id) => BigInt(id as string));
      });
    },

    createJobMultiEval: (
      clientAddress: string,
      provider: string,
      evaluators: string[],
      threshold: number,
      token: string,
      budget: bigint,
      description: string,
    ): Promise<SimulationResult<bigint>> => {
      if (budget <= 0n) throw new Error("budget must be greater than 0");
      if (budget > MAX_I128) throw new Error("budget exceeds i128 max");
      if (evaluators.length === 0 || evaluators.length > 5) {
        throw new Error("evaluators must contain between 1 and 5 addresses");
      }
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > evaluators.length) {
        throw new Error("threshold must be between 1 and the evaluator count");
      }
      if (new Set(evaluators).size !== evaluators.length) {
        throw new Error("evaluators must be unique");
      }
      const evaluatorScVal = xdr.ScVal.scvVec(
        evaluators.map((address) => new Address(address).toScVal()),
      );
      const op = this.contract.call(
        "create_job_multi_eval",
        new Address(clientAddress).toScVal(),
        new Address(provider).toScVal(),
        evaluatorScVal,
        nativeToScVal(threshold, { type: "u32" }),
        new Address(token).toScVal(),
        nativeToScVal(budget, { type: "i128" }),
        nativeToScVal(description, { type: "string" }),
      );
      return this.runSimulation(op, (v) => BigInt(scValToNative(v) as string));
    },

    approveJob: (evaluatorAddress: string, jobId: bigint): Promise<SimulationResult<number>> => {
      const op = this.contract.call(
        "approve_job",
        new Address(evaluatorAddress).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
      );
      return this.runSimulation(op, (v) => Number(scValToNative(v)));
    },

    submit: async (
      providerAddress: string,
      jobId: bigint,
      deliverable: string,
      deliverableHash?: Uint8Array,
    ): Promise<SimulationResult<void>> => {
      const hash = deliverableHash ?? (await computeDeliverableHash(deliverable));
      const op = this.contract.call(
        "submit",
        new Address(providerAddress).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
        nativeToScVal(deliverable, { type: "string" }),
        sha256ToScVal(hash),
      );
      return this.runSimulation(op, () => undefined);
    },

    complete: (
      evaluatorAddress: string,
      jobId: bigint,
      expectedHash?: Uint8Array,
    ): Promise<SimulationResult<void>> => {
      const args: xdr.ScVal[] = [
        new Address(evaluatorAddress).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
      ];
      if (expectedHash !== undefined) args.push(sha256ToScVal(expectedHash));
      const op = this.contract.call("complete", ...args);
      return this.runSimulation(op, () => undefined);
    },

    cancel: (clientAddress: string, jobId: bigint): Promise<SimulationResult<void>> => {
      const op = this.contract.call(
        "cancel",
        new Address(clientAddress).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
      );
      return this.runSimulation(op, () => undefined);
    },

    dispute: (clientAddress: string, jobId: bigint): Promise<SimulationResult<void>> => {
      const op = this.contract.call(
        "dispute",
        new Address(clientAddress).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
      );
      return this.runSimulation(op, () => undefined);
    },

    claimRefund: (clientAddress: string, jobId: bigint): Promise<SimulationResult<void>> => {
      const op = this.contract.call(
        "claim_refund",
        new Address(clientAddress).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
      );
      return this.runSimulation(op, () => undefined);
    },

    claimExpired: (providerAddress: string, jobId: bigint): Promise<SimulationResult<void>> => {
      const op = this.contract.call(
        "claim_expired",
        new Address(providerAddress).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
      );
      return this.runSimulation(op, () => undefined);
    },

    approve: (
      ownerAddress: string,
      spender: string,
      token: string,
      amount: bigint,
      expirationLedger: number = 100_000_000,
    ): Promise<SimulationResult<void>> => {
      const tokenContract = new Contract(token);
      const op = tokenContract.call(
        "approve",
        new Address(ownerAddress).toScVal(),
        new Address(spender).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(expirationLedger, { type: "u32" }),
      );
      return this.runSimulation(op, () => undefined);
    },

    approveAndCreateJob: (
      clientAddress: string,
      provider: string,
      evaluator: string,
      token: string,
      budget: bigint,
      description: string,
      options: CreateJobOptions = {},
    ): Promise<SimulationResult<bigint>> =>
      this.simulate.createJob(
        clientAddress,
        provider,
        evaluator,
        token,
        budget,
        description,
        options,
      ),

    createJobWithApproval: (
      clientAddress: string,
      provider: string,
      evaluator: string,
      token: string,
      budget: bigint,
      description: string,
    ): Promise<SimulationResult<bigint>> =>
      this.simulate.createJob(clientAddress, provider, evaluator, token, budget, description),

    openChannel: (
      payerAddress: string,
      provider: string,
      deposit: bigint,
      voucherPublicKey: Uint8Array,
      token: string = this.cfg.usdcToken,
    ): Promise<SimulationResult<bigint>> => {
      if (deposit <= 0n || deposit > MAX_I128) {
        throw new Error("deposit must be a positive i128 amount");
      }
      const op = this.contract.call(
        "open_channel",
        new Address(payerAddress).toScVal(),
        new Address(provider).toScVal(),
        new Address(token).toScVal(),
        nativeToScVal(deposit, { type: "i128" }),
        nativeToScVal(voucherPublicKey, { type: "bytes" }),
      );
      return this.runSimulation(op, (v) => BigInt(scValToNative(v) as string));
    },

    closeChannel: (
      participantAddress: string,
      channelId: bigint,
      voucher: ChannelVoucher,
    ): Promise<SimulationResult<void>> => {
      if (voucher.channelId !== channelId) throw new Error("voucher channel ID does not match");
      const voucherScVal = nativeToScVal(
        {
          channel_id: nativeToScVal(voucher.channelId, { type: "u64" }),
          amount: nativeToScVal(voucher.amount, { type: "i128" }),
          nonce: nativeToScVal(voucher.nonce, { type: "u64" }),
        },
        { type: "map" },
      );
      const op = this.contract.call(
        "close_channel",
        new Address(participantAddress).toScVal(),
        nativeToScVal(channelId, { type: "u64" }),
        voucherScVal,
        nativeToScVal(voucher.signature, { type: "bytes" }),
      );
      return this.runSimulation(op, () => undefined);
    },

    forceClose: (callerAddress: string, channelId: bigint): Promise<SimulationResult<void>> => {
      const op = this.contract.call(
        "force_close",
        new Address(callerAddress).toScVal(),
        nativeToScVal(channelId, { type: "u64" }),
      );
      return this.runSimulation(op, () => undefined);
    },

    setTreasury: (adminAddress: string, newTreasury: string): Promise<SimulationResult<void>> => {
      const op = this.contract.call(
        "set_treasury",
        new Address(adminAddress).toScVal(),
        new Address(newTreasury).toScVal(),
      );
      return this.runSimulation(op, () => undefined);
    },

    setFeeBps: (adminAddress: string, newBps: number): Promise<SimulationResult<void>> => {
      const op = this.contract.call(
        "set_fee_bps",
        new Address(adminAddress).toScVal(),
        nativeToScVal(newBps, { type: "u32" }),
      );
      return this.runSimulation(op, () => undefined);
    },

    setMultiEvalThreshold: (
      adminAddress: string,
      threshold: bigint,
    ): Promise<SimulationResult<void>> => {
      if (threshold < 0n || threshold > MAX_I128) {
        throw new Error("threshold must fit in a non-negative i128");
      }
      const op = this.contract.call(
        "set_multi_eval_threshold",
        new Address(adminAddress).toScVal(),
        nativeToScVal(threshold, { type: "i128" }),
      );
      return this.runSimulation(op, () => undefined);
    },

    createMilestoneJob: (
      clientAddress: string,
      provider: string,
      evaluator: string,
      token: string,
      budget: bigint,
      description: string,
      milestones: Array<{ amount: bigint; description: string }>,
    ): Promise<SimulationResult<bigint>> => {
      if (budget <= 0n) throw new Error("budget must be greater than 0");
      if (budget > MAX_I128) throw new Error("budget exceeds i128 max");
      if (milestones.length === 0 || milestones.length > 20) {
        throw new Error("milestones must contain between 1 and 20 entries");
      }
      const total = milestones.reduce((acc, m) => acc + m.amount, 0n);
      if (total !== budget) throw new Error("sum of milestone amounts must equal budget");
      const milestoneScVals = milestones.map((m, i) =>
        nativeToScVal(
          {
            index: nativeToScVal(i, { type: "u32" }),
            amount: nativeToScVal(m.amount, { type: "i128" }),
            description: nativeToScVal(m.description, { type: "string" }),
            deliverable: nativeToScVal("", { type: "string" }),
            approved: nativeToScVal(false, { type: "bool" }),
          },
          { type: "map" },
        ),
      );
      const op = this.contract.call(
        "create_milestone_job",
        new Address(clientAddress).toScVal(),
        new Address(provider).toScVal(),
        new Address(evaluator).toScVal(),
        new Address(token).toScVal(),
        nativeToScVal(budget, { type: "i128" }),
        nativeToScVal(description, { type: "string" }),
        xdr.ScVal.scvVec(milestoneScVals),
      );
      return this.runSimulation(op, (v) => BigInt(scValToNative(v) as string));
    },

    submitMilestone: async (
      providerAddress: string,
      jobId: bigint,
      milestoneIdx: number,
      deliverable: string,
      deliverableHash?: Uint8Array,
    ): Promise<SimulationResult<void>> => {
      const hash = deliverableHash ?? (await computeDeliverableHash(deliverable));
      const op = this.contract.call(
        "submit_milestone",
        new Address(providerAddress).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
        nativeToScVal(milestoneIdx, { type: "u32" }),
        nativeToScVal(deliverable, { type: "string" }),
        sha256ToScVal(hash),
      );
      return this.runSimulation(op, () => undefined);
    },

    approveMilestone: (
      evaluatorAddress: string,
      jobId: bigint,
      milestoneIdx: number,
    ): Promise<SimulationResult<void>> => {
      const op = this.contract.call(
        "approve_milestone",
        new Address(evaluatorAddress).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
        nativeToScVal(milestoneIdx, { type: "u32" }),
      );
      return this.runSimulation(op, () => undefined);
    },

    cancelUncompletedMilestones: (
      clientAddress: string,
      jobId: bigint,
    ): Promise<SimulationResult<void>> => {
      const op = this.contract.call(
        "cancel_uncompleted_milestones",
        new Address(clientAddress).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
      );
      return this.runSimulation(op, () => undefined);
    },
  };

  /**
   * Shared core for {@link simulate}: runs a simulation-only dry run of `op`
   * against a placeholder source account and decodes the result.
   */
  private async runSimulation<T>(
    op: xdr.Operation,
    decode: (value: xdr.ScVal) => T,
  ): Promise<SimulationResult<T>> {
    const sim = await this.simulateOperation(op, SIMULATION_SOURCE);
    if (!sim.success) {
      throw new BearContractError(sim.error ?? "simulation failed", {
        operation: "simulate",
      });
    }
    const result = sim.result !== undefined ? decode(sim.result) : decode(undefined as never);
    return {
      result,
      resourceFee: sim.resourceFee,
      inclusionFee: sim.inclusionFee,
      events: sim.events,
      transactionXdr: sim.transactionXdr,
    };
  }

  /**
   * Disconnect and clean up any resources held by this client.
   *
   * The RPC server uses stateless HTTP connections, so this is currently a
   * no-op. Call it for symmetry when disposing of client instances.
   */
  disconnect(): void {
    // No-op for the current implementation.
  }
}
