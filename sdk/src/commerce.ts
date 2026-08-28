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

const MAX_I128 = (1n << 127n) - 1n;

// --- ScVal helpers (exported for custom contract interactions) ---

export const i128ToScVal = (v: bigint) => nativeToScVal(v, { type: "i128" });
export const u128ToScVal = (v: bigint) => nativeToScVal(v, { type: "u128" });
export const u64ToScVal = (v: bigint) => nativeToScVal(v, { type: "u64" });
export const u32ToScVal = (v: number) => nativeToScVal(v, { type: "u32" });
export const strToScVal = (v: string) => nativeToScVal(v, { type: "string" });
export const addrToScVal = (v: string) => new Address(v).toScVal();

// --- ScVal decoding helpers ---

export const i128FromScVal = (v: xdr.ScVal): bigint => BigInt(scValToNative(v) as string);
export const u128FromScVal = (v: xdr.ScVal): bigint => BigInt(scValToNative(v) as string);
export const u64FromScVal = (v: xdr.ScVal): bigint => BigInt(scValToNative(v) as string);
export const u32FromScVal = (v: xdr.ScVal): number => Number(scValToNative(v));
export const strFromScVal = (v: xdr.ScVal): string => scValToNative(v) as string;
export const addrFromScVal = (v: xdr.ScVal): string => Address.fromScVal(v).toString();

/**
 * Typed wrapper around the `agentic_commerce` Soroban contract.
 *
 * Handles job lifecycle: create → submit → complete/cancel, plus
 * admin helpers (setTreasury, setFeeBps) and read-only queries.
 */
export class CommerceClient extends BaseClient {
  private contract: Contract;

  constructor(cfg: MarcConfig) {
    super(cfg);
    this.contract = new Contract(cfg.commerceContract);
  }

  /**
   * Create a funded job. Pulls `budget` of `token` from `client` into escrow.
   * Returns the new job ID.
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

  /** Create a job and wait for the transaction to finalize. */
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

  /** Provider submits a deliverable for a funded job. */
  async submit(provider: Keypair, jobId: bigint, deliverable: string): Promise<void> {
    const op = this.contract.call(
      "submit",
      new Address(signerPublicKey(provider)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
      nativeToScVal(deliverable, { type: "string" }),
    );
    await this.invoke(provider, op, () => undefined, "commerce");
  }

  /** Evaluator marks a submitted job as completed (triggers 99/1 payout). */
  async complete(evaluator: Signer, jobId: bigint): Promise<void> {
    const op = this.contract.call(
      "complete",
      new Address(signerPublicKey(evaluator)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(evaluator, op, () => undefined, "commerce");
  }

  /** Client cancels a funded job (full refund). */
  async cancel(client: Signer, jobId: bigint): Promise<void> {
    const op = this.contract.call(
      "cancel",
      new Address(signerPublicKey(client)).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(client, op, () => undefined, "commerce");
  }

  /**
   * Read a job by ID.
   * Returns `null` only when the contract confirms the job does not exist.
   * Throws on RPC/network errors so callers can distinguish not-found from outage.
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

  /** Disconnect any underlying resources. */
  disconnect(): void {
    // No-op for the current implementation.
  }

  /** Read the current fee in basis points. */
  async feeBps(): Promise<number> {
    const op = this.contract.call("fee_bps");
    return await this.simulate(op, (v) => Number(scValToNative(v)));
  }

  /** Admin: update the treasury address. */
  async setTreasury(admin: Signer, newTreasury: string): Promise<void> {
    const op = this.contract.call(
      "set_treasury",
      new Address(signerPublicKey(admin)).toScVal(),
      new Address(newTreasury).toScVal(),
    );
    await this.invoke(admin, op, () => undefined, "commerce");
  }

  /** Admin: update the fee (capped at 500 bps / 5%). */
  async setFeeBps(admin: Signer, newBps: number): Promise<void> {
    const op = this.contract.call(
      "set_fee_bps",
      new Address(signerPublicKey(admin)).toScVal(),
      nativeToScVal(newBps, { type: "u32" }),
    );
    await this.invoke(admin, op, () => undefined, "commerce");
  }

  /**
   * Get the balance of `address` for a given token.
   * Pass `"native"` for XLM (returns stroops as bigint),
   * or a Soroban token contract address for SAC/custom tokens.
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
}
