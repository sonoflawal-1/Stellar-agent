import {
  Contract,
  Keypair,
  nativeToScVal,
  scValToNative,
  Address,
  xdr,
} from "@stellar/stellar-sdk";
import type { Job, JobStatus, MarcConfig } from "./types.js";
import { BaseClient } from "./baseClient.js";
import type { Signer } from "./signer.js";
import { signerPublicKey } from "./signer.js";

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
    client: Signer,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
  ): Promise<bigint> {
    if (budget <= 0n) throw new Error("budget must be greater than 0");
    if (budget > MAX_I128) throw new Error("budget exceeds i128 max");

    const op = this.contract.call(
      "create_job",
      new Address(signerPublicKey(client)).toScVal(),
      new Address(provider).toScVal(),
      new Address(evaluator).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(budget, { type: "i128" }),
      nativeToScVal(description, { type: "string" }),
    );
    return await this.invoke(client, op, (v) => BigInt(scValToNative(v) as string), "commerce");
  }

  /**
   * Create a funded escrow job and wait for on-chain confirmation.
   *
   * Functionally identical to {@link createJob} — included for API symmetry
   * with patterns that distinguish "fire-and-forget" from "wait for finality".
   *
   * @param client - The client's Keypair. Funds are pulled from this account.
   * @param provider - The service provider's Stellar address (G...).
   * @param evaluator - The evaluator's Stellar address (G...).
   * @param token - The token contract address (C...) for payment.
   * @param budget - The escrow amount in the token's smallest unit.
   * @param description - Human-readable description of the work.
   * @returns The new job's on-chain ID as a `bigint`, resolved after on-chain finality.
   * @throws {Error} If `budget <= 0`, `budget` exceeds `i128` max, or the transaction fails.
   */
  async createJobAndWait(
    client: Keypair,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
  ): Promise<bigint> {
    return this.createJob(client, provider, evaluator, token, budget, description);
  }

  /**
   * Provider submits a deliverable URL or content for a funded job.
   *
   * Transitions the job from `Funded` → `Submitted` status. Only the assigned
   * provider address can call this method successfully.
   *
   * @param provider - The provider's Keypair. Must match the job's `provider` field.
   * @param jobId - The ID of the job to submit a deliverable for.
   * @param deliverable - URL or content string representing the completed work
   *                      (e.g. an IPFS URL, a raw text summary, or a hosted file link).
   * @returns A promise that resolves when the submission is confirmed on-chain.
   * @throws {Error} If the signer is not the assigned provider, the job is not in
   *                 `Funded` status, or the transaction fails.
   *
   * @example
   * ```typescript
   * await commerce.submit(providerKeypair, jobId, "https://ipfs.io/ipfs/Qm...");
   * ```
   */
  async submit(provider: Keypair, jobId: bigint, deliverable: string): Promise<void> {
    const op = this.contract.call(
      "submit",
      new Address(signerPublicKey(provider)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
      nativeToScVal(deliverable, { type: "string" }),
    );
    await this.invoke(provider, op, () => undefined, "commerce");
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
   * @returns A promise that resolves when completion and payout are confirmed on-chain.
   * @throws {Error} If the signer is not the assigned evaluator, the job is not in
   *                 `Submitted` status, or the transaction fails.
   *
   * @example
   * ```typescript
   * await commerce.complete(evaluatorKeypair, jobId);
   * ```
   */
  async complete(evaluator: Signer, jobId: bigint): Promise<void> {
    const op = this.contract.call(
      "complete",
      new Address(signerPublicKey(evaluator)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(evaluator, op, () => undefined, "commerce");
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
  async cancel(client: Signer, jobId: bigint): Promise<void> {
    const op = this.contract.call(
      "cancel",
      new Address(signerPublicKey(client)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(client, op, () => undefined, "commerce");
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
        status: (Array.isArray(native.status) ? native.status[0] : native.status) as JobStatus,
        description: native.description,
        deliverable: native.deliverable,
        funded_at: BigInt(native.funded_at ?? 0),
        created_at: BigInt(native.created_at ?? 0),
        updated_at: BigInt(native.updated_at ?? 0),
      } as Job;
    });
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
  async setTreasury(admin: Signer, newTreasury: string): Promise<void> {
    const op = this.contract.call(
      "set_treasury",
      new Address(signerPublicKey(admin)).toScVal(),
      new Address(newTreasury).toScVal(),
    );
    await this.invoke(admin, op, () => undefined, "commerce");
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
  async setFeeBps(admin: Signer, newBps: number): Promise<void> {
    const op = this.contract.call(
      "set_fee_bps",
      new Address(signerPublicKey(admin)).toScVal(),
      nativeToScVal(newBps, { type: "u32" }),
    );
    await this.invoke(admin, op, () => undefined, "commerce");
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
