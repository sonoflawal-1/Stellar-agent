import {
  Contract,
  Keypair,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
  Address,
  xdr,
  Account,
} from "@stellar/stellar-sdk";
import type { Job, JobStatus, MarcConfig } from "./types.js";

// --- ScVal helpers (exported for custom contract interactions) ---

export const i128ToScVal = (v: bigint) => nativeToScVal(v, { type: "i128" });
export const u128ToScVal = (v: bigint) => nativeToScVal(v, { type: "u128" });
export const u64ToScVal  = (v: bigint) => nativeToScVal(v, { type: "u64" });
export const u32ToScVal  = (v: number) => nativeToScVal(v, { type: "u32" });
export const strToScVal  = (v: string) => nativeToScVal(v, { type: "string" });
export const addrToScVal = (v: string) => new Address(v).toScVal();

/**
 * Typed wrapper around the `agentic_commerce` Soroban contract.
 *
 * Handles job lifecycle: create → submit → complete/cancel, plus
 * admin helpers (setTreasury, setFeeBps) and read-only queries.
 */
export class CommerceClient {
  private server: rpc.Server;
  private contract: Contract;

  constructor(private cfg: MarcConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
      timeout: 15000,
    });
    this.contract = new Contract(cfg.commerceContract);
  }

  /**
   * Create a funded job. Pulls `budget` of `token` from `client` into escrow.
   * Returns the new job ID.
   */
  async createJob(
    client: Keypair,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
  ): Promise<bigint> {
    const op = this.contract.call(
      "create_job",
      new Address(client.publicKey()).toScVal(),
      new Address(provider).toScVal(),
      new Address(evaluator).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(budget, { type: "i128" }),
      nativeToScVal(description, { type: "string" }),
    );
    return await this.invoke(client, op, (v) => BigInt(scValToNative(v) as string));
  }

  /** Provider submits a deliverable for a funded job. */
  async submit(
    provider: Keypair,
    jobId: bigint,
    deliverable: string,
  ): Promise<void> {
    const op = this.contract.call(
      "submit",
      new Address(provider.publicKey()).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
      nativeToScVal(deliverable, { type: "string" }),
    );
    await this.invoke(provider, op, () => undefined);
  }

  /** Evaluator marks a submitted job as completed (triggers 99/1 payout). */
  async complete(evaluator: Keypair, jobId: bigint): Promise<void> {
    const op = this.contract.call(
      "complete",
      new Address(evaluator.publicKey()).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(evaluator, op, () => undefined);
  }

  /** Client cancels a funded job (full refund). */
  async cancel(client: Keypair, jobId: bigint): Promise<void> {
    const op = this.contract.call(
      "cancel",
      new Address(client.publicKey()).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
    );
    await this.invoke(client, op, () => undefined);
  }

  /**
   * Create a job and poll until completion, cancellation, or rejection.
   *
   * Returns the final Job object when status transitions from "Funded" to
   * a terminal state (Completed, Cancelled, Rejected). Throws on timeout.
   *
   * @param client The funding/cancelling client keypair
   * @param provider Provider address (string)
   * @param evaluator Evaluator address (string)
   * @param token Token contract address
   * @param budget Funding amount in base units
   * @param description Job description
   * @param pollInterval Milliseconds between status checks (default: 2000)
   * @param timeout Total timeout in milliseconds (default: 5 minutes)
   */
  async createJobAndWait(
    client: Keypair,
    provider: string,
    evaluator: string,
    token: string,
    budget: bigint,
    description: string,
    pollInterval: number = 2000,
    timeout: number = 5 * 60 * 1000,
  ): Promise<Job> {
    // Create the job and get its ID
    const jobId = await this.createJob(client, provider, evaluator, token, budget, description);

    // Poll until terminal state
    const startTime = Date.now();
    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeout) {
        throw new Error(`Timeout waiting for job ${jobId} to reach terminal state after ${timeout}ms`);
      }

      const job = await this.getJob(jobId);
      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      // Terminal states
      if (
        job.status === "Completed" ||
        job.status === "Cancelled" ||
        job.status === "Rejected"
      ) {
        return job;
      }

      // Still in Funded or Submitted state, keep polling
      await new Promise((r) => setTimeout(r, pollInterval));
    }
  }

  /** Read a job by ID. Returns null if not found. */
  async getJob(jobId: bigint): Promise<Job | null> {
    const op = this.contract.call(
      "get_job",
      nativeToScVal(jobId, { type: "u64" }),
    );
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      if (!native) return null;
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

  /** Read the current fee in basis points. */
  async feeBps(): Promise<number> {
    const op = this.contract.call("fee_bps");
    return await this.simulate(op, (v) => Number(scValToNative(v)));
  }

  /** Admin: update the treasury address. */
  async setTreasury(admin: Keypair, newTreasury: string): Promise<void> {
    const op = this.contract.call(
      "set_treasury",
      new Address(admin.publicKey()).toScVal(),
      new Address(newTreasury).toScVal(),
    );
    await this.invoke(admin, op, () => undefined);
  }

  /** Admin: update the fee (capped at 500 bps / 5%). */
  async setFeeBps(admin: Keypair, newBps: number): Promise<void> {
    const op = this.contract.call(
      "set_fee_bps",
      new Address(admin.publicKey()).toScVal(),
      nativeToScVal(newBps, { type: "u32" }),
    );
    await this.invoke(admin, op, () => undefined);
  }

  /**
   * Get the balance of `address` for a given token.
   * Pass `"native"` for XLM (returns stroops as bigint),
   * or a Soroban token contract address for SAC/custom tokens.
   */
  async getBalance(address: string, token: string): Promise<bigint> {
    if (token === "native") {
      const account = await this.server.getAccount(address);
      const xlmBalance = account.balances.find((b) => b.asset_type === "native");
      return BigInt(Math.round(Number(xlmBalance?.balance ?? "0") * 1e7));
    }
    const tokenContract = new Contract(token);
    const op = tokenContract.call("balance", new Address(address).toScVal());
    return await this.simulate(op, (v) => BigInt(scValToNative(v) as string));
  }

  // --- internals (same pattern as IdentityClient) ---

  private async invoke<T>(
    signer: Keypair,
    op: xdr.Operation,
    decode: (scVal: xdr.ScVal) => T,
  ): Promise<T> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new Error(`submit failed: ${sent.errorResult}`);
    let getResp = await this.server.getTransaction(sent.hash);
    while (getResp.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await this.server.getTransaction(sent.hash);
    }
    if (getResp.status !== "SUCCESS") {
      const failed = getResp as rpc.Api.GetFailedTransactionResponse;
      const detail = failed.resultXdr?.result()?.switch()?.name ?? getResp.status;
      throw new Error(`tx failed: ${detail}`);
    }
    this.cfg.onTx?.(sent.hash, "commerce");
    return decode(getResp.returnValue!);
  }

  private async simulate<T>(op: xdr.Operation, decode: (v: xdr.ScVal) => T): Promise<T> {
    const ephemeral = Keypair.random();
    const dummy = new Account(ephemeral.publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const sim = await this.server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
        const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
        if (!result) throw new Error("no simulation result");
        return decode(result.retval);
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw new Error("unreachable");
  }
}
